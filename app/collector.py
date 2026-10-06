"""System metric collection built on psutil, plus background scheduling."""
from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from typing import Any, Callable

import psutil

from . import config, db, gpu
from .alerts import AlertEngine

PREFERRED_TEMP_CHIPS = (
    "coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal",
    "soc_thermal", "acpitz", "thinkpad",
)
SKIP_NET = {"lo"}


def _round(value: Any, digits: int = 1) -> Any:
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return None


CPUINFO_MODEL_KEYS = ("model name", "cpu model", "hardware", "model", "cpu")


def _cpu_model_from_cpuinfo() -> str | None:
    """/proc/cpuinfo exposes the model on x86 and most ARM boards."""
    fields: dict[str, str] = {}
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                key = key.strip().lower()
                if key not in fields:
                    fields[key] = value.strip()
    except OSError:
        return None
    for key in CPUINFO_MODEL_KEYS:
        value = fields.get(key)
        if value and value not in ("-", "0"):
            return value
    return None


def _cpu_model_from_lscpu() -> str | None:
    """lscpu -J also reports the BIOS/DMI processor model (VMs, ARM SoCs)."""
    exe = shutil.which("lscpu")
    if not exe:
        return None
    try:
        env = dict(os.environ)
        env["LC_ALL"] = "C"
        proc = subprocess.run([exe, "-J"], capture_output=True, text=True, timeout=3.0, env=env)
        payload = json.loads(proc.stdout or "{}")
    except Exception:
        return None
    fields: dict[str, str] = {}
    for item in payload.get("lscpu", []):
        key = str(item.get("field", "")).rstrip(":").strip().lower()
        fields[key] = str(item.get("data", "") or "").strip()
    for key in ("model name", "bios model name"):
        value = fields.get(key)
        if value and value not in ("-", "0"):
            return value
    return None


def resolve_cpu_model() -> str | None:
    for resolver in (_cpu_model_from_cpuinfo, _cpu_model_from_lscpu):
        try:
            value = resolver()
        except Exception:
            value = None
        if value:
            return value
    return None


class Collector:
    """Samples system state on a fixed interval, persists it, and feeds alerts."""

    def __init__(self, engine: AlertEngine) -> None:
        self.engine = engine
        self.latest: dict[str, Any] | None = None
        self._prev_ts: float | None = None
        self._prev_disk: dict[str, tuple[float, float, float, float]] = {}
        self._prev_net: dict[str, tuple[int, int]] = {}
        self._static = self._static_info()
        self._conn_ts = 0.0
        self._conn_count: int | None = None
        # Prime psutil percentage counters so the first real sample is meaningful.
        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)

    # -- lifecycle ------------------------------------------------------
    async def run(self, publish: Callable[[dict[str, Any]], None] | None = None) -> None:
        while True:
            started = time.monotonic()
            try:
                snapshot = await asyncio.to_thread(self.sample_blocking)
                self.latest = snapshot
                if publish is not None:
                    try:
                        publish(snapshot)
                    except Exception as exc:
                        print("[collector] publish failed: " + repr(exc), flush=True)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print("[collector] sample failed: " + repr(exc), flush=True)
            delay = config.SAMPLE_INTERVAL - (time.monotonic() - started)
            await asyncio.sleep(max(0.25, delay))

    # -- sampling -------------------------------------------------------
    def sample_blocking(self) -> dict[str, Any]:
        now = time.time()
        ts_ms = int(now * 1000)
        elapsed = max(0.001, now - (self._prev_ts or now))

        sensors = self._sensors()
        cpu = self._cpu(sensors)
        memory = self._memory()
        disk = self._disk_io(elapsed)
        disks = self._partitions(disk["devices"])
        net = self._network(elapsed)
        gpu_info = self._gpu()
        system = self._system(now)

        snapshot: dict[str, Any] = {
            "ts": ts_ms,
            "timestamp": datetime.fromtimestamp(now, timezone.utc).isoformat(),
            "interval_s": round(elapsed, 3),
            "cpu": cpu,
            "memory": memory,
            "gpu": gpu_info,
            "disks": disks,
            "disk_io": disk["totals"],
            "net": net,
            "system": system,
            "sensors": sensors,
        }
        try:
            snapshot["alerts"] = self.engine.evaluate(snapshot)
        except Exception as exc:
            snapshot["alerts"] = []
            print("[collector] alert evaluation failed: " + repr(exc), flush=True)

        self._persist(ts_ms, snapshot)
        self._prev_ts = now
        return snapshot

    def _static_info(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "hostname": socket.gethostname(),
            "cpu_model": resolve_cpu_model(),
            "platform": platform.platform(),
            "system": platform.system(),
            "kernel": platform.release(),
            "arch": platform.machine(),
            "python": platform.python_version(),
            "distro": None,
        }
        try:
            release = platform.freedesktop_os_release()
            info["distro"] = release.get("PRETTY_NAME") or release.get("NAME")
        except Exception:
            pass
        return info

    def _system(self, now: float) -> dict[str, Any]:
        boot = None
        try:
            boot = psutil.boot_time()
        except Exception:
            pass
        users = []
        try:
            users = [
                {"name": u.name, "terminal": u.terminal, "host": u.host, "started": u.started}
                for u in psutil.users()
            ]
        except Exception:
            users = []
        info = dict(self._static)
        info.update({
            "boot_time": boot,
            "uptime": None if boot is None else round(max(0.0, now - boot), 1),
            "proc_count": len(psutil.pids()),
            "user_count": len(users),
            "users": users,
        })
        return info

    def _sensors(self) -> dict[str, Any]:
        temperatures: list[dict[str, Any]] = []
        try:
            raw_temps = psutil.sensors_temperatures() or {}
        except Exception:
            raw_temps = {}
        for chip, entries in raw_temps.items():
            for entry in entries:
                temperatures.append({
                    "chip": chip,
                    "label": entry.label or chip,
                    "current": _round(entry.current),
                    "high": _round(entry.high),
                    "critical": _round(entry.critical),
                })
        fans: list[dict[str, Any]] = []
        try:
            raw_fans = psutil.sensors_fans() or {}
        except Exception:
            raw_fans = {}
        for chip, entries in raw_fans.items():
            for entry in entries:
                fans.append({"chip": chip, "label": entry.label or chip, "rpm": entry.current})
        max_fan = max([f["rpm"] for f in fans if f.get("rpm")], default=None)
        return {"temperatures": temperatures, "fans": fans, "max_fan_rpm": max_fan}

    def _pick_cpu_temp(self, temperatures: list[dict[str, Any]]) -> Any:
        for chip in PREFERRED_TEMP_CHIPS:
            for entry in temperatures:
                if entry["chip"] == chip and entry["current"] is not None:
                    return entry["current"]
        best = None
        for entry in temperatures:
            value = entry.get("current")
            if value is None:
                continue
            if best is None or value > best:
                best = value
        return _round(best)

    def _cpu(self, sensors: dict[str, Any]) -> dict[str, Any]:
        total = psutil.cpu_percent(interval=None)
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        try:
            load1, load5, load15 = psutil.getloadavg()
        except (AttributeError, OSError):
            load1 = load5 = load15 = None
        try:
            freq = psutil.cpu_freq()
        except Exception:
            freq = None
        ctx_switches = interrupts = None
        try:
            stats = psutil.cpu_stats()
            ctx_switches = stats.ctx_switches
            interrupts = stats.interrupts
        except Exception:
            pass
        return {
            "total": _round(total, 1),
            "per_core": [_round(value, 1) for value in per_core],
            "cores_logical": psutil.cpu_count(logical=True),
            "cores_physical": psutil.cpu_count(logical=False),
            "load": [_round(load1, 2), _round(load5, 2), _round(load15, 2)],
            "freq_mhz": None if freq is None else _round(freq.current, 0),
            "freq_max_mhz": None if freq is None else _round(freq.max, 0),
            "temp_c": self._pick_cpu_temp(sensors["temperatures"]),
            "ctx_switches": ctx_switches,
            "interrupts": interrupts,
        }

    def _memory(self) -> dict[str, Any]:
        vm = psutil.virtual_memory()
        sm = psutil.swap_memory()
        return {
            "total": vm.total,
            "used": vm.used,
            "available": vm.available,
            "free": vm.free,
            "percent": _round(vm.percent, 1),
            "cached": getattr(vm, "cached", None),
            "buffers": getattr(vm, "buffers", None),
            "swap": {
                "total": sm.total,
                "used": sm.used,
                "free": sm.free,
                "percent": _round(sm.percent, 1),
            },
        }

    def _disk_io(self, elapsed: float) -> dict[str, Any]:
        try:
            raw = psutil.disk_io_counters(perdisk=True) or {}
        except Exception:
            raw = {}
        devices: dict[str, dict[str, Any]] = {}
        totals = {"read_bps": None, "write_bps": None, "read_iops": None, "write_iops": None}
        aggregate = {"read_bps": 0.0, "write_bps": 0.0, "read_iops": 0.0, "write_iops": 0.0}
        have = False
        for name, counter in raw.items():
            current = (
                float(counter.read_bytes), float(counter.write_bytes),
                float(counter.read_count), float(counter.write_count),
            )
            previous = self._prev_disk.get(name)
            rate: dict[str, Any] = {"read_bps": None, "write_bps": None, "read_iops": None, "write_iops": None}
            if previous is not None:
                have = True
                rate = {
                    "read_bps": _round(max(0.0, current[0] - previous[0]) / elapsed),
                    "write_bps": _round(max(0.0, current[1] - previous[1]) / elapsed),
                    "read_iops": _round(max(0.0, current[2] - previous[2]) / elapsed),
                    "write_iops": _round(max(0.0, current[3] - previous[3]) / elapsed),
                }
                for key in aggregate:
                    aggregate[key] += rate[key] or 0.0
            devices[name] = dict(rate, read_bytes=counter.read_bytes, write_bytes=counter.write_bytes)
            self._prev_disk[name] = current
        if have:
            totals = {key: _round(value) for key, value in aggregate.items()}
        return {"totals": totals, "devices": devices}

    def _partitions(self, device_rates: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            partitions = psutil.disk_partitions(all=False)
        except Exception:
            partitions = []
        result: list[dict[str, Any]] = []
        for part in partitions:
            try:
                usage = psutil.disk_usage(part.mountpoint)
            except (PermissionError, OSError):
                continue
            rate = device_rates.get(part.device.split("/")[-1]) or {}
            result.append({
                "device": part.device,
                "mountpoint": part.mountpoint,
                "fstype": part.fstype,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": _round(usage.percent, 1),
                "read_bps": rate.get("read_bps"),
                "write_bps": rate.get("write_bps"),
                "read_iops": rate.get("read_iops"),
                "write_iops": rate.get("write_iops"),
            })
        return result

    def _network(self, elapsed: float) -> dict[str, Any]:
        try:
            raw = psutil.net_io_counters(pernic=True) or {}
        except Exception:
            raw = {}
        try:
            addresses = psutil.net_if_addrs()
        except Exception:
            addresses = {}
        interfaces: list[dict[str, Any]] = []
        total_up = 0.0
        total_down = 0.0
        have = False
        for name, counter in raw.items():
            if name in SKIP_NET:
                continue
            previous = self._prev_net.get(name)
            up = down = None
            if previous is not None:
                have = True
                up = _round(max(0.0, counter.bytes_sent - previous[0]) / elapsed)
                down = _round(max(0.0, counter.bytes_recv - previous[1]) / elapsed)
                total_up += up or 0.0
                total_down += down or 0.0
            self._prev_net[name] = (counter.bytes_sent, counter.bytes_recv)
            iface_addresses = [
                a.address for a in addresses.get(name, []) if a.family == socket.AF_INET
            ]
            interfaces.append({
                "name": name,
                "up_bps": up,
                "down_bps": down,
                "bytes_sent": counter.bytes_sent,
                "bytes_recv": counter.bytes_recv,
                "packets_sent": counter.packets_sent,
                "packets_recv": counter.packets_recv,
                "errors_in": counter.errin,
                "errors_out": counter.errout,
                "drops_in": counter.dropin,
                "drops_out": counter.dropout,
                "addresses": iface_addresses,
            })
        connections = self._connection_count()
        return {
            "interfaces": interfaces,
            "total_up_bps": _round(total_up) if have else None,
            "total_down_bps": _round(total_down) if have else None,
            "connections": connections,
        }

    def _connection_count(self) -> int | None:
        """Socket counting is expensive (~4 ms), so refresh it on its own clock."""
        now = time.time()
        if self._conn_count is None or now - self._conn_ts >= config.CONNECTION_REFRESH:
            try:
                self._conn_count = len(psutil.net_connections(kind="inet"))
            except Exception:
                self._conn_count = None
            self._conn_ts = now
        return self._conn_count

    def _gpu(self) -> dict[str, Any]:
        try:
            return gpu.sample()
        except Exception as exc:
            return {
                "available": False, "vendor": None, "source": "error", "name": None,
                "util_percent": None, "mem_used_mb": None, "mem_total_mb": None,
                "temp_c": None, "power_w": None, "power_limit_w": None, "error": repr(exc),
            }

    def _persist(self, ts_ms: int, snapshot: dict[str, Any]) -> None:
        cpu = snapshot["cpu"]
        memory = snapshot["memory"]
        gpu_info = snapshot["gpu"]
        disk = snapshot["disk_io"]
        net = snapshot["net"]
        system = snapshot["system"]
        gpu_ok = bool(gpu_info.get("available"))
        load = cpu.get("load") or [None, None, None]
        row = {
            "cpu_total": cpu.get("total"),
            "cpu_temp": cpu.get("temp_c"),
            "fan_rpm": snapshot["sensors"].get("max_fan_rpm"),
            "load1": load[0], "load5": load[1], "load15": load[2],
            "mem_total": memory.get("total"), "mem_used": memory.get("used"),
            "mem_avail": memory.get("available"), "mem_cached": memory.get("cached"),
            "mem_percent": memory.get("percent"),
            "swap_total": memory["swap"].get("total"), "swap_used": memory["swap"].get("used"),
            "swap_percent": memory["swap"].get("percent"),
            "gpu_util": gpu_info.get("util_percent") if gpu_ok else None,
            "gpu_mem_used": gpu_info.get("mem_used_mb") if gpu_ok else None,
            "gpu_mem_total": gpu_info.get("mem_total_mb") if gpu_ok else None,
            "gpu_temp": gpu_info.get("temp_c") if gpu_ok else None,
            "gpu_power": gpu_info.get("power_w") if gpu_ok else None,
            "disk_read_bps": disk.get("read_bps"), "disk_write_bps": disk.get("write_bps"),
            "disk_read_iops": disk.get("read_iops"), "disk_write_iops": disk.get("write_iops"),
            "net_up_bps": net.get("total_up_bps"), "net_down_bps": net.get("total_down_bps"),
            "net_conns": net.get("connections"),
            "proc_count": system.get("proc_count"), "user_count": system.get("user_count"),
            "uptime": system.get("uptime"),
        }
        try:
            db.insert_sample(row, ts_ms)
        except Exception as exc:
            print("[collector] persist failed: " + repr(exc), flush=True)
