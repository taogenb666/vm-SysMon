"""Threshold alert evaluation and optional webhook notification."""
from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any

from . import config, db

OPERATORS = {
    ">": lambda a, b: a > b,
    ">=": lambda a, b: a >= b,
    "<": lambda a, b: a < b,
    "<=": lambda a, b: a <= b,
    "==": lambda a, b: a == b,
    "!=": lambda a, b: a != b,
}

ALERT_METRICS = (
    "cpu.total", "cpu.temp", "mem.percent", "mem.used", "swap.percent", "swap.used",
    "load.1", "load.5", "load.15", "gpu.util", "gpu.temp", "gpu.power",
    "disk.max_percent", "net.up_bps", "net.down_bps", "net.conns",
    "sys.proc_count", "sys.user_count", "fan.rpm",
)


def metrics_from_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    cpu = snapshot.get("cpu") or {}
    mem = snapshot.get("memory") or {}
    gpu = snapshot.get("gpu") or {}
    net = snapshot.get("net") or {}
    system = snapshot.get("system") or {}
    sensors = snapshot.get("sensors") or {}
    load = list(cpu.get("load") or [None, None, None])
    while len(load) < 3:
        load.append(None)
    disks = snapshot.get("disks") or []
    disk_max = max([d.get("percent") or 0 for d in disks], default=0)
    gpu_ok = bool(gpu.get("available"))
    swap = mem.get("swap") or {}
    return {
        "cpu.total": cpu.get("total"),
        "cpu.temp": cpu.get("temp_c"),
        "fan.rpm": sensors.get("max_fan_rpm"),
        "load.1": load[0],
        "load.5": load[1],
        "load.15": load[2],
        "mem.total": mem.get("total"),
        "mem.used": mem.get("used"),
        "mem.percent": mem.get("percent"),
        "swap.used": swap.get("used"),
        "swap.percent": swap.get("percent"),
        "gpu.util": gpu.get("util_percent") if gpu_ok else None,
        "gpu.temp": gpu.get("temp_c") if gpu_ok else None,
        "gpu.power": gpu.get("power_w") if gpu_ok else None,
        "disk.max_percent": disk_max,
        "net.up_bps": net.get("total_up_bps"),
        "net.down_bps": net.get("total_down_bps"),
        "net.conns": net.get("connections"),
        "sys.proc_count": system.get("proc_count"),
        "sys.user_count": system.get("user_count"),
    }


class AlertEngine:
    """Evaluates alert rules against each snapshot and fires webhooks on open."""

    def __init__(self) -> None:
        self._rules: list[dict[str, Any]] = []
        self._pending: dict[int, float] = {}
        self._active: dict[int, dict[str, Any]] = {}
        self.reload()

    def reload(self) -> None:
        try:
            self._rules = db.rules_list()
        except Exception:
            self._rules = []

    @property
    def rules(self) -> list[dict[str, Any]]:
        return list(self._rules)

    def evaluate(self, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
        values = metrics_from_snapshot(snapshot)
        now = time.time()
        active: list[dict[str, Any]] = []
        fired: list[tuple[dict[str, Any], Any]] = []
        for rule in list(self._rules):
            if not rule.get("enabled"):
                continue
            metric = rule.get("metric")
            value = values.get(metric)
            if value is None:
                continue
            compare = OPERATORS.get(rule.get("op") or ">")
            if compare is None:
                continue
            try:
                hit = bool(compare(float(value), float(rule.get("threshold") or 0)))
            except (TypeError, ValueError):
                continue
            key = int(rule.get("id") or 0)
            if hit:
                since = self._pending.get(key)
                if since is None:
                    since = now
                    self._pending[key] = since
                if now - since >= float(rule.get("duration_s") or 0):
                    if key not in self._active:
                        self._active[key] = {"since": since, "value": value}
                        fired.append((rule, value))
                    active.append({
                        "id": key,
                        "metric": metric,
                        "op": rule.get("op"),
                        "threshold": rule.get("threshold"),
                        "value": value,
                        "since": self._active[key]["since"],
                        "duration_s": rule.get("duration_s") or 0,
                        "note": rule.get("note") or "",
                    })
            else:
                self._pending.pop(key, None)
                self._active.pop(key, None)
        for rule, value in fired:
            self._notify(rule, value)
        return active

    def clear(self) -> None:
        self._pending.clear()
        self._active.clear()

    def _notify(self, rule: dict[str, Any], value: Any) -> None:
        url = config.ALERT_WEBHOOK_URL
        if not url:
            return
        payload = {
            "event": "alert",
            "time": time.time(),
            "source": "sysmon",
            "rule": {k: rule.get(k) for k in ("id", "metric", "op", "threshold", "duration_s", "note")},
            "value": value,
        }

        def worker() -> None:
            try:
                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    url, data=data, headers={"Content-Type": "application/json"}, method="POST"
                )
                urllib.request.urlopen(req, timeout=5).read()
            except Exception as exc:
                print("[alerts] webhook failed: " + repr(exc), flush=True)

        threading.Thread(target=worker, daemon=True).start()
