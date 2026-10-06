"""FastAPI application: REST API, WebSocket/SSE streaming and the web UI."""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, config, db, system
from .alerts import ALERT_METRICS, OPERATORS, AlertEngine
from .collector import Collector

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class Hub:
    """Fan-out of serialized snapshots to WebSocket and SSE subscribers."""

    def __init__(self) -> None:
        self.queues: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        self.queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.queues.discard(queue)

    def publish(self, snapshot: dict[str, Any]) -> None:
        payload = json.dumps(snapshot, default=str)
        for queue in list(self.queues):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(payload)


hub = Hub()
engine = AlertEngine()
collector = Collector(engine)


async def _cleanup_loop() -> None:
    while True:
        try:
            deleted = await asyncio.to_thread(db.cleanup, config.RETENTION_DAYS)
            if deleted:
                print("[maintenance] removed " + str(deleted) + " expired samples", flush=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print("[maintenance] cleanup failed: " + repr(exc), flush=True)
        await asyncio.sleep(max(60.0, config.CLEANUP_INTERVAL))


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    engine.reload()
    tasks = [
        asyncio.create_task(collector.run(hub.publish)),
        asyncio.create_task(_cleanup_loop()),
        asyncio.create_task(asyncio.to_thread(system.prime_processes)),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(
    title="SysMon",
    version=__version__,
    description="Lightweight Linux system monitoring panel",
    lifespan=lifespan,
)


class RuleIn(BaseModel):
    metric: str = Field(..., description="metric name, e.g. cpu.total")
    op: str = Field(">", description="one of > >= < <= == !=")
    threshold: float
    duration_s: int = Field(0, ge=0)
    enabled: bool = True
    note: str = ""


class RulePatch(BaseModel):
    metric: str | None = None
    op: str | None = None
    threshold: float | None = None
    duration_s: int | None = Field(None, ge=0)
    enabled: bool | None = None
    note: str | None = None


class ProcessSignalIn(BaseModel):
    signal: str = Field("TERM", description="TERM | KILL | INT | HUP")


class ConnectionCloseIn(BaseModel):
    local_ip: str | None = None
    local_port: int | None = None
    remote_ip: str | None = None
    remote_port: int | None = None
    status: str | None = None
    mode: str = Field("destroy", description="destroy | kill-owner")


class ServiceActionIn(BaseModel):
    action: str = Field(..., description="start | stop | restart | reload | enable | disable")


def _validate_rule(metric: str, op: str) -> None:
    if metric not in ALERT_METRICS:
        raise HTTPException(status_code=400, detail="unknown metric: " + metric)
    if op not in OPERATORS:
        raise HTTPException(status_code=400, detail="unknown operator: " + op)


def _parse_time(value: str | None, default_ms: int) -> int:
    if value is None or value == "":
        return default_ms
    text = str(value).strip()
    try:
        return int(float(text))
    except ValueError:
        pass
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid time: " + text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "sampling": collector.latest is not None,
        "interval_s": config.SAMPLE_INTERVAL,
        "retention_days": config.RETENTION_DAYS,
    }


@app.get("/api/current")
async def api_current() -> dict[str, Any]:
    if collector.latest is None:
        raise HTTPException(status_code=503, detail="no sample collected yet")
    return collector.latest


@app.get("/api/meta")
async def api_meta() -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    return {
        "version": __version__,
        "interval_s": config.SAMPLE_INTERVAL,
        "retention_days": config.RETENTION_DAYS,
        "max_points": config.MAX_HISTORY_POINTS,
        "server_time": now_ms,
        "metrics": list(db.METRIC_ALIASES.keys()),
        "alert_metrics": list(ALERT_METRICS),
        "operators": list(OPERATORS.keys()),
        "system": None if collector.latest is None else collector.latest.get("system"),
    }


@app.get("/api/history")
async def api_history(
    metric: str = Query(..., description="metric name, e.g. cpu.total"),
    start: str | None = Query(None, description="epoch ms or ISO-8601"),
    end: str | None = Query(None, description="epoch ms or ISO-8601"),
    limit: int = Query(config.MAX_HISTORY_POINTS, ge=10, le=20000),
) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    end_ms = _parse_time(end, now_ms)
    start_ms = _parse_time(start, end_ms - 3600 * 1000)
    if start_ms >= end_ms:
        raise HTTPException(status_code=400, detail="start must be before end")
    try:
        column, total, points = await asyncio.to_thread(
            db.query_history, metric, start_ms, end_ms, min(limit, config.MAX_HISTORY_POINTS * 4)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "metric": metric,
        "column": column,
        "start": start_ms,
        "end": end_ms,
        "total": total,
        "points": points,
    }


@app.get("/api/alerts")
async def api_alerts() -> dict[str, Any]:
    latest = collector.latest or {}
    return {
        "active": latest.get("alerts") or [],
        "rules": engine.rules,
        "metrics": list(ALERT_METRICS),
        "operators": list(OPERATORS.keys()),
    }


@app.post("/api/alerts", status_code=201)
async def api_alert_add(rule: RuleIn) -> dict[str, Any]:
    _validate_rule(rule.metric, rule.op)
    rule_id = await asyncio.to_thread(
        db.rule_add, rule.metric, rule.op, rule.threshold, rule.duration_s, rule.enabled, rule.note
    )
    engine.reload()
    return {"id": rule_id}


@app.patch("/api/alerts/{rule_id}")
async def api_alert_update(rule_id: int, rule: RulePatch) -> dict[str, Any]:
    current = {r["id"]: r for r in engine.rules}.get(rule_id)
    if current is None:
        raise HTTPException(status_code=404, detail="rule not found")
    metric = rule.metric if rule.metric is not None else current["metric"]
    op = rule.op if rule.op is not None else current["op"]
    _validate_rule(metric, op)
    changed = await asyncio.to_thread(db.rule_update, rule_id, **rule.model_dump())
    engine.reload()
    return {"updated": bool(changed)}


@app.delete("/api/alerts/{rule_id}")
async def api_alert_delete(rule_id: int) -> dict[str, Any]:
    deleted = await asyncio.to_thread(db.rule_delete, rule_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="rule not found")
    engine.reload()
    return {"deleted": True}


def _control_error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@app.get("/api/processes")
async def api_processes(
    limit: int = Query(10, ge=1, le=200),
    sort: str = Query("cpu", pattern="^(cpu|mem)$"),
) -> dict[str, Any]:
    try:
        processes, total = await asyncio.to_thread(system.top_processes, limit, sort)
    except system.ControlError as exc:
        raise _control_error(exc)
    return {"total": total, "sort": sort, "processes": processes}


@app.post("/api/processes/{pid}/signal")
async def api_process_signal(pid: int, payload: ProcessSignalIn) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(system.signal_process, pid, payload.signal)
    except system.ControlError as exc:
        raise _control_error(exc)


@app.get("/api/connections")
async def api_connections(limit: int = Query(200, ge=1, le=2000)) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(system.list_tcp_connections, limit)
    except system.ControlError as exc:
        raise _control_error(exc)


@app.post("/api/connections/close")
async def api_connection_close(payload: ConnectionCloseIn) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            system.close_connection,
            payload.local_ip, payload.local_port, payload.remote_ip, payload.remote_port,
            payload.status, payload.mode,
        )
    except system.ControlError as exc:
        raise _control_error(exc)


@app.get("/api/services")
async def api_services(
    query: str | None = Query(None),
    limit: int = Query(400, ge=1, le=2000),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(system.list_services, query, limit)
    except system.ControlError as exc:
        raise _control_error(exc)


@app.post("/api/services/{unit}/action")
async def api_service_action(unit: str, payload: ServiceActionIn) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(system.service_action, unit, payload.action)
    except system.ControlError as exc:
        raise _control_error(exc)


@app.get("/api/stream")
async def api_stream(request: Request) -> StreamingResponse:
    async def generator():
        queue = hub.subscribe()
        try:
            if collector.latest is not None:
                yield "data: " + json.dumps(collector.latest, default=str) + "\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield "data: " + payload + "\n\n"
        finally:
            hub.unsubscribe(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = hub.subscribe()
    try:
        if collector.latest is not None:
            await websocket.send_text(json.dumps(collector.latest, default=str))
        while True:
            payload = await queue.get()
            await websocket.send_text(payload)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception:
        pass
    finally:
        hub.unsubscribe(queue)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/history")
async def history_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "history.html")


def main() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT)


if __name__ == "__main__":
    main()
