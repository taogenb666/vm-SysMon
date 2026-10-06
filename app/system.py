"""Process, TCP connection and systemd service inspection and control."""
from __future__ import annotations

import os
import re
import shutil
import signal as signal_module
import subprocess
import threading
import time
from typing import Any, Callable

import psutil

UNIT_RE = re.compile(r"^[A-Za-z0-9@._:-]+\.service$")
SIGNAL_NAMES = {"TERM": "SIGTERM", "KILL": "SIGKILL", "INT": "SIGINT", "HUP": "SIGHUP"}
SERVICE_ACTIONS = ("start", "stop", "restart", "reload", "enable", "disable")
PROTECTED_STOP = {"sysmon.service"}
MAX_CONNECTIONS = 2000
MAX_PROCESSES = 200


class ControlError(Exception):
    """User-facing control failure; mapped to HTTP 400 by the API layer."""


def _safe(callback: Callable[[], Any], default: Any = None) -> Any:
    try:
        return callback()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError, ValueError):
        return default


# --------------------------------------------------------------------------
# processes
# --------------------------------------------------------------------------

_proc_cache: dict[int, psutil.Process] = {}
_proc_lock = threading.Lock()


def _process_objects() -> list[psutil.Process]:
    pids = set(psutil.pids())
    with _proc_lock:
        for pid in list(_proc_cache):
            if pid not in pids:
                _proc_cache.pop(pid, None)
        objects: list[psutil.Process] = []
        for pid in pids:
            proc = _proc_cache.get(pid)
            if proc is None:
                proc = _safe(lambda: psutil.Process(pid))
                if proc is None:
                    continue
                _proc_cache[pid] = proc
            objects.append(proc)
    return objects


def prime_processes() -> int:
    """First cpu_percent() call per process only establishes a baseline."""
    objects = _process_objects()
    for proc in objects:
        _safe(lambda p=proc: p.cpu_percent(interval=None), 0.0)
    return len(objects)


def top_processes(limit: int = 10, sort: str = "cpu") -> tuple[list[dict[str, Any]], int]:
    limit = max(1, min(int(limit), MAX_PROCESSES))
    order = str(sort or "cpu").lower()
    if order not in ("cpu", "mem"):
        order = "cpu"
    rows: list[dict[str, Any]] = []
    for proc in _process_objects():
        pid = proc.pid
        cpu = _safe(lambda p=proc: p.cpu_percent(interval=None), 0.0) or 0.0
        mem_percent = _safe(lambda p=proc: p.memory_percent(), 0.0) or 0.0
        info = _safe(lambda p=proc: p.as_dict(attrs=[
            "name", "username", "status", "cmdline", "create_time", "num_threads", "memory_info",
        ]), {}) or {}
        memory_info = info.get("memory_info")
        cmdline = info.get("cmdline") or []
        rows.append({
            "pid": pid,
            "name": info.get("name") or "?",
            "username": info.get("username") or "?",
            "status": info.get("status") or "?",
            "cmdline": " ".join(cmdline)[:400] if cmdline else (info.get("name") or "?"),
            "cpu_percent": round(float(cpu), 1),
            "mem_percent": round(float(mem_percent), 2),
            "rss": None if memory_info is None else memory_info.rss,
            "threads": info.get("num_threads"),
            "create_time": info.get("create_time"),
        })
    key = "mem_percent" if order == "mem" else "cpu_percent"
    rows.sort(key=lambda row: row[key], reverse=True)
    return rows[:limit], len(rows)


def signal_process(pid: int, sig: str = "TERM") -> dict[str, Any]:
    name = SIGNAL_NAMES.get(str(sig or "TERM").upper())
    if name is None:
        raise ControlError("unsupported signal: " + str(sig))
    pid = int(pid)
    if pid <= 1:
        raise ControlError("refusing to signal pid " + str(pid))
    if pid == os.getpid():
        raise ControlError("refusing to signal the monitor process itself")
    proc = _safe(lambda: psutil.Process(pid))
    if proc is None:
        raise ControlError("no such process: " + str(pid))
    proc_name = _safe(lambda: proc.name(), "?")
    number = getattr(signal_module, name)
    try:
        os.kill(pid, number)
    except ProcessLookupError:
        return {"pid": pid, "name": proc_name, "signal": name, "alive": False}
    except PermissionError:
        raise ControlError("permission denied for pid " + str(pid))
    alive = True
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if not _safe(lambda: proc.is_running(), False) or _safe(lambda: proc.status(), "?") == "zombie":
            alive = False
            break
        time.sleep(0.1)
    return {
        "pid": pid,
        "name": proc_name,
        "signal": name,
        "alive": alive,
        "status": _safe(lambda: proc.status(), "?"),
    }


# --------------------------------------------------------------------------
# TCP connections
# --------------------------------------------------------------------------

STATUS_ORDER = {
    "ESTABLISHED": 0, "SYN_SENT": 1, "SYN_RECV": 2, "CLOSE_WAIT": 3,
    "FIN_WAIT1": 4, "FIN_WAIT2": 5, "TIME_WAIT": 6, "LAST_ACK": 7, "LISTEN": 8,
}


def list_tcp_connections(limit: int = 2000) -> dict[str, Any]:
    limit = max(1, min(int(limit), MAX_CONNECTIONS))
    try:
        raw = psutil.net_connections(kind="tcp")
    except psutil.AccessDenied as exc:
        raise ControlError("cannot read connections: " + str(exc))
    except Exception as exc:
        raise ControlError("cannot read connections: " + repr(exc))
    summary: dict[str, int] = {}
    rows: list[dict[str, Any]] = []
    for conn in raw:
        status = conn.status or "NONE"
        summary[status] = summary.get(status, 0) + 1
        pid = conn.pid
        proc_name = None
        username = None
        if pid:
            proc = _safe(lambda p=pid: psutil.Process(p))
            if proc is not None:
                proc_name = _safe(lambda: proc.name())
                username = _safe(lambda: proc.username())
        laddr = getattr(conn, "laddr", None)
        raddr = getattr(conn, "raddr", None)
        rows.append({
            "fd": conn.fd,
            "status": status,
            "local_ip": getattr(laddr, "ip", None),
            "local_port": getattr(laddr, "port", None),
            "remote_ip": getattr(raddr, "ip", None) if raddr else None,
            "remote_port": getattr(raddr, "port", None) if raddr else None,
            "pid": pid,
            "process": proc_name,
            "user": username,
        })
    rows.sort(key=lambda row: (STATUS_ORDER.get(row["status"], 9), row["local_port"] or 0))
    total = len(rows)
    return {
        "total": total,
        "truncated": total > limit,
        "destroy_supported": kernel_destroy_supported(),
        "summary": summary,
        "connections": rows[:limit],
    }


def _has_connection(local_port: int | None, remote_ip: str | None, remote_port: int | None) -> bool:
    try:
        raw = psutil.net_connections(kind="tcp")
    except Exception:
        return False
    for conn in raw:
        if conn.status in ("LISTEN", "TIME_WAIT"):
            continue
        laddr = getattr(conn, "laddr", None)
        raddr = getattr(conn, "raddr", None)
        if local_port is not None and getattr(laddr, "port", None) != local_port:
            continue
        if remote_port is not None and getattr(raddr, "port", None) != remote_port:
            continue
        if remote_ip and getattr(raddr, "ip", None) != remote_ip:
            continue
        return True
    return False


def _find_owner(
    local_port: int | None,
    remote_ip: str | None,
    remote_port: int | None,
    local_ip: str | None = None,
) -> tuple[int | None, str | None]:
    try:
        raw = psutil.net_connections(kind="tcp")
    except Exception:
        return None, None
    for conn in raw:
        laddr = getattr(conn, "laddr", None)
        raddr = getattr(conn, "raddr", None)
        if local_port is not None and getattr(laddr, "port", None) != local_port:
            continue
        if remote_port is not None and getattr(raddr, "port", None) != remote_port:
            continue
        if remote_ip and getattr(raddr, "ip", None) != remote_ip:
            continue
        if local_ip and getattr(laddr, "ip", None) != local_ip:
            continue
        if conn.pid:
            proc = _safe(lambda p=conn.pid: psutil.Process(p))
            name = _safe(lambda: proc.name(), "?") if proc else None
            return conn.pid, name
    return None, None


def kernel_destroy_supported() -> bool:
    """ss -K only works when the kernel was built with CONFIG_INET_DIAG_DESTROY."""
    cached = getattr(kernel_destroy_supported, "cached", None)
    if cached is not None:
        return bool(cached)
    text = None
    try:
        import gzip

        with gzip.open("/proc/config.gz", "rt", errors="replace") as handle:
            text = handle.read()
    except Exception:
        text = None
    if text is None:
        try:
            with open("/boot/config-" + os.uname().release, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError:
            text = None
    supported = True
    if text is not None:
        if "CONFIG_INET_DIAG_DESTROY=y" in text:
            supported = True
        elif "# CONFIG_INET_DIAG_DESTROY is not set" in text:
            supported = False
    kernel_destroy_supported.cached = supported
    return supported


def close_connection(
    local_ip: str | None,
    local_port: int | None,
    remote_ip: str | None,
    remote_port: int | None,
    status: str | None = None,
    mode: str = "destroy",
) -> dict[str, Any]:
    if (status or "").upper() == "LISTEN":
        raise ControlError("refusing to destroy a listening socket; stop the owning service instead")
    verb = str(mode or "destroy").lower()
    if verb not in ("destroy", "kill-owner"):
        raise ControlError("unsupported close mode: " + str(mode))
    owner_pid, owner_name = _find_owner(local_port, remote_ip, remote_port, local_ip)

    if verb == "kill-owner":
        if owner_pid is None:
            raise ControlError("could not identify the process owning this connection")
        result = signal_process(owner_pid, "TERM")
        return {
            "ok": True,
            "checked": not result.get("alive", True),
            "mode": "kill-owner",
            "destroy_supported": kernel_destroy_supported(),
            "owner_pid": owner_pid,
            "owner_name": owner_name,
            "signal": result.get("signal"),
            "command": "",
            "output": "",
        }

    if not kernel_destroy_supported():
        return {
            "ok": False,
            "checked": False,
            "mode": "destroy",
            "destroy_supported": False,
            "owner_pid": owner_pid,
            "owner_name": owner_name,
            "command": "",
            "output": "kernel built without CONFIG_INET_DIAG_DESTROY; tear-down unavailable",
        }

    exe = shutil.which("ss")
    if not exe:
        raise ControlError("ss (iproute2) is not installed; cannot close connections")
    args = [exe, "-K"]
    if local_port:
        args += ["sport", "= :" + str(int(local_port))]
    if remote_port:
        args += ["dport", "= :" + str(int(remote_port))]
    if remote_ip:
        args += ["dst", str(remote_ip)]
    if local_ip:
        args += ["src", str(local_ip)]
    if len(args) <= 2:
        raise ControlError("missing connection endpoints")
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=6.0)
    except subprocess.SubprocessError as exc:
        raise ControlError("ss -K failed: " + repr(exc))
    output = (proc.stdout + proc.stderr).strip()
    time.sleep(0.3)
    still_there = _has_connection(local_port, remote_ip, remote_port)
    return {
        "ok": proc.returncode == 0 and not still_there,
        "checked": not still_there,
        "mode": "destroy",
        "destroy_supported": True,
        "owner_pid": owner_pid,
        "owner_name": owner_name,
        "command": " ".join(args),
        "output": "" if not still_there else (output or "socket still present after ss -K"),
    }


# --------------------------------------------------------------------------
# systemd services
# --------------------------------------------------------------------------

def _systemctl(*args: str, timeout: float = 25.0) -> subprocess.CompletedProcess:
    exe = shutil.which("systemctl")
    if not exe:
        raise ControlError("systemctl is not available on this host")
    try:
        return subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.SubprocessError as exc:
        raise ControlError("systemctl failed: " + repr(exc))


def list_services(query: str | None = None, limit: int = 400) -> dict[str, Any]:
    limit = max(1, min(int(limit), MAX_CONNECTIONS))
    loaded = _systemctl("list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain")
    files = _systemctl("list-unit-files", "--type=service", "--no-legend", "--no-pager")

    rows: dict[str, dict[str, Any]] = {}
    for line in files.stdout.splitlines():
        parts = line.split()
        if not parts or not UNIT_RE.match(parts[0]):
            continue
        rows[parts[0]] = {
            "unit": parts[0], "description": "", "load": "not-loaded",
            "active": "inactive", "sub": "dead", "loaded": False,
            "file_state": parts[1] if len(parts) > 1 else "",
        }
    for line in loaded.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4 or not UNIT_RE.match(parts[0]):
            continue
        unit = parts[0]
        row = rows.get(unit) or {
            "unit": unit, "description": "", "file_state": "",
        }
        row.update({
            "description": parts[4] if len(parts) > 4 else "",
            "load": parts[1], "active": parts[2], "sub": parts[3], "loaded": True,
        })
        rows[unit] = row

    services = list(rows.values())
    if query:
        needle = str(query).strip().lower()
        services = [
            svc for svc in services
            if needle in svc["unit"].lower() or needle in (svc.get("description") or "").lower()
        ]
    services.sort(key=lambda svc: (
        0 if svc.get("active") == "active" else 1 if svc.get("active") == "failed" else 2,
        svc["unit"],
    ))
    total = len(services)
    return {"total": total, "truncated": total > limit, "services": services[:limit]}


def service_action(unit: str, action: str) -> dict[str, Any]:
    if not UNIT_RE.match(unit or ""):
        raise ControlError("invalid unit name: " + str(unit))
    verb = str(action or "").lower()
    if verb not in SERVICE_ACTIONS:
        raise ControlError("unsupported action: " + str(action))
    if verb in ("stop", "disable") and unit in PROTECTED_STOP:
        raise ControlError("refusing to " + verb + " " + unit + ": it serves this panel")
    proc = _systemctl(verb, unit, timeout=40.0)
    output = (proc.stdout + proc.stderr).strip()
    return {
        "unit": unit,
        "action": verb,
        "ok": proc.returncode == 0,
        "output": "" if proc.returncode == 0 else (output or "systemctl exited with " + str(proc.returncode)),
    }
