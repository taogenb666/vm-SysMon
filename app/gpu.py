"""GPU telemetry: NVIDIA (pynvml / nvidia-smi), AMD (rocm-smi), integrated fallback."""
from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

from . import config

NV_FIELDS = "utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,name"


def _run(cmd: list[str], timeout: float = 3.0) -> str | None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return (proc.stdout or "").strip()


def _num(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if text == "" or text.lower() in ("n/a", "[not supported]", "not supported"):
        return None
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def _blank(vendor: str | None, source: str, name: str | None, available: bool = False, **extra: Any) -> dict[str, Any]:
    base = {
        "available": available,
        "vendor": vendor,
        "source": source,
        "name": name,
        "util_percent": None,
        "mem_used_mb": None,
        "mem_total_mb": None,
        "temp_c": None,
        "power_w": None,
        "power_limit_w": None,
    }
    base.update(extra)
    return base


def _nvml() -> dict[str, Any] | None:
    try:
        import pynvml
    except Exception:
        return None
    try:
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode("utf-8", "replace")
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        try:
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
        except Exception:
            temp = None
        try:
            power = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
        except Exception:
            power = None
        try:
            limit = pynvml.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0
        except Exception:
            limit = None
        return _blank(
            "nvidia", "pynvml", name, True,
            util_percent=float(util.gpu),
            mem_used_mb=round(mem.used / 1024 / 1024, 1),
            mem_total_mb=round(mem.total / 1024 / 1024, 1),
            temp_c=None if temp is None else float(temp),
            power_w=None if power is None else round(power, 1),
            power_limit_w=None if limit is None else round(limit, 1),
        )
    except Exception:
        return None
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:
            pass


def _nvidia_smi() -> dict[str, Any] | None:
    if not shutil.which("nvidia-smi"):
        return None
    out = _run(["nvidia-smi", "--query-gpu=" + NV_FIELDS, "--format=csv,noheader,nounits"])
    if not out:
        return None
    parts = [p.strip() for p in out.splitlines()[0].split(",")]
    if len(parts) < 6:
        return None
    return _blank(
        "nvidia", "nvidia-smi", parts[6] if len(parts) > 6 else "NVIDIA GPU", True,
        util_percent=_num(parts[0]),
        mem_used_mb=_num(parts[1]),
        mem_total_mb=_num(parts[2]),
        temp_c=_num(parts[3]),
        power_w=_num(parts[4]),
        power_limit_w=_num(parts[5]),
    )


def _rocm_smi() -> dict[str, Any] | None:
    if not shutil.which("rocm-smi"):
        return None
    out = _run(["rocm-smi", "--showuse", "--showmeminfo", "vram", "--showtemp", "--showpower", "--showproductname", "--json"])
    if not out:
        return None
    try:
        data = json.loads(out)
    except ValueError:
        return None
    if not isinstance(data, dict) or not data:
        return None
    card_key = next(iter(data))
    card = data[card_key]
    if not isinstance(card, dict):
        return None

    def pick(fragment: str) -> Any:
        for key, value in card.items():
            if fragment.lower() in key.lower():
                return value
        return None

    used = _num(pick("VRAM Total Used Memory"))
    total = _num(pick("VRAM Total Memory"))
    scale = 1024.0 * 1024.0 if (total or 0) > 10 ** 7 else 1.0
    return _blank(
        "amd", "rocm-smi", pick("Card Series") or pick("Card model") or "AMD GPU", True,
        util_percent=_num(pick("GPU use")),
        mem_used_mb=None if used is None else round(used / scale, 1),
        mem_total_mb=None if total is None else round(total / scale, 1),
        temp_c=_num(pick("Temperature (Sensor edge)")),
        power_w=_num(pick("Average Power")),
    )


def _integrated() -> dict[str, Any]:
    name = None
    if shutil.which("lspci"):
        out = _run(["lspci"])
        if out:
            for line in out.splitlines():
                low = line.lower()
                if ("vga compatible controller" in low or "display controller" in low or "3d controller" in low):
                    name = line.split(": ", 1)[-1]
                    if "nvidia" in low or "geforce" in low or "quadro" in low or "radeon" in low or "amd/ati" in low:
                        return _blank(None, "lspci", name, False, error="GPU detected but no usable telemetry tool")
                    return _blank("integrated", "lspci", name, False)
    if name is None:
        return _blank(None, "none", None, False, error="no GPU detected")
    return _blank("integrated", "lspci", name, False)


def sample() -> dict[str, Any]:
    mode = (config.GPU_MODE or "auto").lower()
    if mode == "off":
        return _blank(None, "disabled", None, False, error="GPU probe disabled")
    result = None
    if mode in ("auto", "nvidia"):
        result = _nvml() or _nvidia_smi()
    if result is None and mode in ("auto", "amd"):
        result = _rocm_smi()
    if result is not None:
        return result
    return _integrated()
