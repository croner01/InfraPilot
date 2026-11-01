"""Data Sources API —— 对应 `server/src/routes/datasources.ts`。

指标（Prometheus）与数据库（只读 SQL）的运行时查询入口，供前端数据源工作台使用。
"""

from __future__ import annotations

import asyncio
import os
import re
import socket
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from .. import config_store as store
from ..skills import prom

data_sources_router = APIRouter()


def _find_prom(backend_id: str) -> dict[str, Any] | None:
    return next(
        (b for b in store.get_metric_systems() if b.get("id") == backend_id and b.get("type") == "prometheus"), None
    )


@data_sources_router.get("/prom")
def list_prom() -> dict[str, Any]:
    return {"systems": store.get_metric_systems()}


@data_sources_router.post("/prom/{backend_id}/test")
async def test_prom(backend_id: str) -> dict[str, Any]:
    backend = _find_prom(backend_id)
    if not backend:
        raise HTTPException(status_code=404, detail="prometheus backend not found")
    try:
        data = await asyncio.to_thread(prom._prom_request, backend, "api/v1/status/buildinfo", {})
        return {"ok": True, "reachable": True, "version": (data or {}).get("version") or "unknown"}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err)}


@data_sources_router.post("/prom/{backend_id}/query")
async def prom_query(backend_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    backend = _find_prom(backend_id)
    if not backend:
        raise HTTPException(status_code=404, detail="prometheus backend not found")
    body = payload or {}
    query = body.get("query")
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    try:
        result = await asyncio.to_thread(
            prom.prom_instant_query, backend, str(query), str(body["time"]) if body.get("time") else None
        )
        return {"ok": True, "result": result}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}


def _to_unix_seconds(value: str) -> int:
    try:
        return int(float(value))
    except ValueError:
        pass
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


@data_sources_router.post("/prom/{backend_id}/query-range")
async def prom_query_range(backend_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    backend = _find_prom(backend_id)
    if not backend:
        raise HTTPException(status_code=404, detail="prometheus backend not found")
    body = payload or {}
    query = body.get("query")
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    try:
        end_sec = _to_unix_seconds(str(body["end"])) if body.get("end") else int(time.time())
        start_sec = _to_unix_seconds(str(body["start"])) if body.get("start") else end_sec - 3600
        result = await asyncio.to_thread(
            prom.prom_range_query, backend, str(query), str(start_sec), str(end_sec), str(body.get("step") or "1m")
        )
        return {"ok": True, "result": result, "series": prom._matrix_to_series(result)}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}


@data_sources_router.get("/prom/{backend_id}/labels/{label}")
async def prom_labels(backend_id: str, label: str) -> dict[str, Any]:
    backend = _find_prom(backend_id)
    if not backend:
        raise HTTPException(status_code=404, detail="prometheus backend not found")
    try:
        values = await asyncio.to_thread(prom.prom_label_values, backend, label)
        return {"ok": True, "values": values}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}


# -------------------- Database（只读查询） --------------------

_READONLY_SQL_PREFIX = re.compile(r"^(select|explain|show|describe|desc|pragma|with)\b", re.IGNORECASE)

_DB_DEFAULT_PORTS = {"mysql": 3306, "mariadb": 3306, "postgres": 5432, "clickhouse": 8123, "elasticsearch": 9200}


def _default_db_port(dialect: Any) -> int:
    return _DB_DEFAULT_PORTS.get(str(dialect), 5432)


def _find_db(backend_id: str) -> dict[str, Any] | None:
    return next(
        (b for b in store.get_database_systems() if b.get("id") == backend_id and b.get("type") == "database"), None
    )


@data_sources_router.get("/db")
def list_db() -> dict[str, Any]:
    return {"systems": store.get_database_systems()}


async def _tcp_probe(host: str, port: int, timeout: float = 5.0) -> None:
    def _try() -> None:
        with socket.create_connection((host, port), timeout=timeout):
            return None

    try:
        await asyncio.to_thread(_try)
    except OSError as err:
        raise RuntimeError(f"连接失败 ({host}:{port}): {err}") from err


@data_sources_router.post("/db/{backend_id}/test")
async def db_test(backend_id: str) -> dict[str, Any]:
    db = _find_db(backend_id)
    if not db:
        raise HTTPException(status_code=404, detail="database backend not found")
    try:
        if db.get("dialect") == "sqlite":
            if not os.path.exists(db["host"]):
                return {"ok": True, "reachable": False, "error": f"sqlite 文件不存在: {db['host']}"}
            return {"ok": True, "reachable": True}
        await _tcp_probe(db["host"], db.get("port") or _default_db_port(db.get("dialect")))
        return {"ok": True, "reachable": True}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err)}


@data_sources_router.post("/db/{backend_id}/query")
async def db_query(backend_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    db = _find_db(backend_id)
    if not db:
        raise HTTPException(status_code=404, detail="database backend not found")
    sql = str((payload or {}).get("sql") or "").strip()
    if not sql:
        raise HTTPException(status_code=400, detail="sql is required")
    if (db.get("readonly", True) if db.get("readonly") is not None else True) and not _READONLY_SQL_PREFIX.match(sql):
        raise HTTPException(
            status_code=403, detail="只读模式：仅允许 SELECT / EXPLAIN / SHOW / DESCRIBE / PRAGMA / WITH 查询"
        )
    max_rows = min(max(int(db.get("maxRows") or 200), 1), 1000)

    try:
        if db.get("dialect") == "sqlite":
            if not os.path.exists(db["host"]):
                return {"ok": False, "error": f"sqlite 文件不存在: {db['host']}"}
            if not _READONLY_SQL_PREFIX.match(sql):
                raise HTTPException(status_code=403, detail="只读连接：仅允许查询语句")

            def _run() -> dict[str, Any]:
                conn = sqlite3.connect(f"file:{db['host']}?mode=ro", uri=True)
                conn.row_factory = sqlite3.Row
                try:
                    cursor = conn.execute(sql)
                    rows = [dict(row) for row in cursor.fetchall()]
                finally:
                    conn.close()
                columns = list(rows[0].keys()) if rows else []
                return {
                    "ok": True,
                    "columns": columns,
                    "rows": rows[:max_rows],
                    "total": len(rows),
                    "truncated": len(rows) > max_rows,
                }

            return await asyncio.to_thread(_run)

        dialect = str(db.get("dialect"))
        await _tcp_probe(db["host"], db.get("port") or _default_db_port(dialect))
        if dialect in ("clickhouse", "elasticsearch"):
            return {
                "ok": False,
                "reachable": True,
                "error": f"{dialect} 数据源类型已登记，查询驱动待接入（可先用 Skill 工具检索）",
            }
        driver = "mysql2" if dialect in ("mysql", "mariadb") else "pg"
        return {
            "ok": False,
            "reachable": True,
            "error": f"服务端未安装 {dialect} 驱动。请在 server 目录安装依赖后重启：npm install {driver}",
        }
    except HTTPException:
        raise
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}
