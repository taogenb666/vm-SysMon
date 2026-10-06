"""Central configuration, driven by environment variables."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


HOST: str = _env_str("SYSMON_HOST", "0.0.0.0")
PORT: int = _env_int("SYSMON_PORT", 8000)

# Sampling cadence (seconds) and how long raw samples are retained.
SAMPLE_INTERVAL: float = _env_float("SYSMON_INTERVAL", 2.0)
RETENTION_DAYS: float = _env_float("SYSMON_RETENTION_DAYS", 7.0)
CLEANUP_INTERVAL: float = _env_float("SYSMON_CLEANUP_INTERVAL", 3600.0)

DB_PATH: Path = Path(_env_str("SYSMON_DB", str(BASE_DIR / "data" / "sysmon.db")))

# Maximum number of points a single history query returns before downsampling.
MAX_HISTORY_POINTS: int = _env_int("SYSMON_MAX_POINTS", 1200)

# GPU probing: auto | nvidia | amd | off
GPU_MODE: str = _env_str("SYSMON_GPU_MODE", "auto")

# Optional webhook called with a JSON body when an alert opens.
ALERT_WEBHOOK_URL: str = _env_str("SYSMON_WEBHOOK_URL", "")
