"""SQLite persistence: samples, alert rules and retention."""
from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any

from . import config

# Wide table: one row per sample.
SAMPLE_COLUMNS: tuple[str, ...] = (
    "cpu_total", "cpu_temp", "fan_rpm",
    "load1", "load5", "load15",
    "mem_total", "mem_used", "mem_avail", "mem_cached", "mem_percent",
    "swap_total", "swap_used", "swap_percent",
    "gpu_util", "gpu_mem_used", "gpu_mem_total", "gpu_temp", "gpu_power",
    "disk_read_bps", "disk_write_bps", "disk_read_iops", "disk_write_iops",
    "net_up_bps", "net_down_bps", "net_conns",
    "proc_count", "user_count", "uptime",
)

COLUMN_DDL = "ts INTEGER PRIMARY KEY, " + ", ".join(name + " REAL" for name in SAMPLE_COLUMNS)

METRIC_ALIASES: dict[str, str] = {
    "cpu.total": "cpu_total",
    "cpu.temp": "cpu_temp",
    "fan.rpm": "fan_rpm",
    "load.1": "load1",
    "load.5": "load5",
    "load.15": "load15",
    "mem.total": "mem_total",
    "mem.used": "mem_used",
    "mem.avail": "mem_avail",
    "mem.cached": "mem_cached",
    "mem.percent": "mem_percent",
    "swap.total": "swap_total",
    "swap.used": "swap_used",
    "swap.percent": "swap_percent",
    "gpu.util": "gpu_util",
    "gpu.mem_used": "gpu_mem_used",
    "gpu.mem_total": "gpu_mem_total",
    "gpu.temp": "gpu_temp",
    "gpu.power": "gpu_power",
    "disk.read_bps": "disk_read_bps",
    "disk.write_bps": "disk_write_bps",
    "disk.read_iops": "disk_read_iops",
    "disk.write_iops": "disk_write_iops",
    "net.up_bps": "net_up_bps",
    "net.down_bps": "net_down_bps",
    "net.conns": "net_conns",
    "sys.proc_count": "proc_count",
    "sys.user_count": "user_count",
    "sys.uptime": "uptime",
}

# UI grouping: keeps the metric pickers scannable and drives chart colours.
METRIC_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("CPU", ("cpu.total", "cpu.temp", "fan.rpm", "load.1", "load.5", "load.15")),
    ("内存", ("mem.total", "mem.used", "mem.avail", "mem.cached", "mem.percent",
              "swap.total", "swap.used", "swap.percent")),
    ("磁盘", ("disk.read_bps", "disk.write_bps", "disk.read_iops", "disk.write_iops")),
    ("网络", ("net.up_bps", "net.down_bps", "net.conns")),
    ("GPU", ("gpu.util", "gpu.mem_used", "gpu.mem_total", "gpu.temp", "gpu.power")),
    ("系统", ("sys.proc_count", "sys.user_count", "sys.uptime")),
)

METRIC_LABELS: dict[str, str] = {
    name: label for label, names in METRIC_GROUPS for name in names
}

# Alert-only virtual metrics that have no history column of their own.
METRIC_LABELS["disk.max_percent"] = "磁盘"


def group_metrics(names: Any) -> list[dict[str, Any]]:
    """Bucket metric names into their groups, keeping the canonical order."""
    buckets: dict[str, list[str]] = {}
    for name in names:
        buckets.setdefault(METRIC_LABELS.get(name, "其他"), []).append(name)
    groups = [
        {"label": label, "metrics": buckets[label]}
        for label, _ in METRIC_GROUPS if buckets.get(label)
    ]
    if buckets.get("其他"):
        groups.append({"label": "其他", "metrics": buckets["其他"]})
    return groups


DEFAULT_RULES: tuple[tuple[Any, ...], ...] = (
    ("cpu.total", ">", 90.0, 5, "CPU usage above 90%"),
    ("mem.percent", ">", 90.0, 5, "Memory usage above 90%"),
    ("swap.percent", ">", 50.0, 10, "Swap usage above 50%"),
    ("cpu.temp", ">", 85.0, 10, "CPU temperature above 85C"),
    ("gpu.temp", ">", 85.0, 10, "GPU temperature above 85C"),
    ("disk.max_percent", ">", 90.0, 30, "A filesystem is over 90% full"),
)

_local = threading.local()


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(config.DB_PATH), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA cache_size=-2000")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA mmap_size=134217728")
        _local.conn = conn
    return conn


def init_db() -> None:
    conn = connect()
    with conn:
        conn.execute("CREATE TABLE IF NOT EXISTS samples (" + COLUMN_DDL + ")")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS alert_rules ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "metric TEXT NOT NULL, "
            "op TEXT NOT NULL DEFAULT '>', "
            "threshold REAL NOT NULL, "
            "duration_s INTEGER NOT NULL DEFAULT 0, "
            "enabled INTEGER NOT NULL DEFAULT 1, "
            "note TEXT NOT NULL DEFAULT '')"
        )
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        count = conn.execute("SELECT COUNT(*) AS n FROM alert_rules").fetchone()["n"]
        if count == 0:
            conn.executemany(
                "INSERT INTO alert_rules (metric, op, threshold, duration_s, note) VALUES (?, ?, ?, ?, ?)",
                DEFAULT_RULES,
            )


def insert_sample(row: dict[str, Any], ts_ms: int) -> None:
    cols = ["ts"] + [name for name in SAMPLE_COLUMNS if name in row]
    values = [ts_ms] + [row[name] for name in cols[1:]]
    placeholders = ", ".join("?" for _ in cols)
    conn = connect()
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO samples (" + ", ".join(cols) + ") VALUES (" + placeholders + ")",
            values,
        )


def resolve_column(metric: str) -> str:
    name = METRIC_ALIASES.get(metric, metric)
    if name not in SAMPLE_COLUMNS:
        raise ValueError("unknown metric: " + str(metric))
    return name


def query_history(metric: str, start_ms: int, end_ms: int, max_points: int):
    column = resolve_column(metric)
    conn = connect()
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM samples WHERE ts BETWEEN ? AND ?", (start_ms, end_ms)
    ).fetchone()
    total = int(row["n"] or 0)
    if total == 0:
        return column, total, []
    span = max(1, end_ms - start_ms)
    bucket = 1
    if total > max_points:
        bucket = max(1, int(span // max_points))
    if bucket > 1:
        sql = (
            "SELECT CAST(ts / ? AS INTEGER) * ? AS ts, AVG(" + column + ") AS value "
            "FROM samples WHERE ts BETWEEN ? AND ? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts"
        )
        rows = conn.execute(sql, (bucket, bucket, start_ms, end_ms, bucket)).fetchall()
    else:
        sql = (
            "SELECT ts AS ts, " + column + " AS value "
            "FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts"
        )
        rows = conn.execute(sql, (start_ms, end_ms)).fetchall()
    points = [
        [int(r["ts"]), None if r["value"] is None else round(float(r["value"]), 3)]
        for r in rows
    ]
    return column, total, points


def cleanup(retention_days: float) -> int:
    cutoff = int((time.time() - retention_days * 86400.0) * 1000)
    conn = connect()
    with conn:
        cur = conn.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
    return cur.rowcount or 0


def rules_list() -> list[dict[str, Any]]:
    conn = connect()
    rows = conn.execute("SELECT * FROM alert_rules ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def rule_add(metric: str, op: str, threshold: float, duration_s: int = 0, enabled: bool = True, note: str = "") -> int:
    conn = connect()
    with conn:
        cur = conn.execute(
            "INSERT INTO alert_rules (metric, op, threshold, duration_s, enabled, note) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (metric, op, float(threshold), int(duration_s), int(bool(enabled)), note or ""),
        )
    return int(cur.lastrowid)


def rule_update(rule_id: int, **fields: Any) -> bool:
    allowed = {"metric", "op", "threshold", "duration_s", "enabled", "note"}
    sets: list[str] = []
    values: list[Any] = []
    for key, value in fields.items():
        if key not in allowed or value is None:
            continue
        if key == "enabled":
            value = int(bool(value))
        elif key == "threshold":
            value = float(value)
        elif key == "duration_s":
            value = int(value)
        sets.append(key + " = ?")
        values.append(value)
    if not sets:
        return False
    values.append(int(rule_id))
    conn = connect()
    with conn:
        cur = conn.execute("UPDATE alert_rules SET " + ", ".join(sets) + " WHERE id = ?", values)
    return bool(cur.rowcount)


def rule_delete(rule_id: int) -> bool:
    conn = connect()
    with conn:
        cur = conn.execute("DELETE FROM alert_rules WHERE id = ?", (int(rule_id),))
    return bool(cur.rowcount)


def set_meta(key: str, value: Any) -> None:
    conn = connect()
    with conn:
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, str(value)))


def get_meta(key: str, default: Any = None) -> Any:
    conn = connect()
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return default if row is None else row["value"]
