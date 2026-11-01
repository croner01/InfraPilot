"""定时任务 API（P2）—— `/api/schedules/*`。

Node 版无对应路由（Python 版新增能力）。前端尚未接入；契约保持与本项目其它路由
一致的 `{"error": "..."}` 错误体与 camelCase 字段。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException

from .. import db, scheduler
from ..util import new_id, now_iso

schedules_router = APIRouter()


def _public_schedule(row: dict[str, Any]) -> dict[str, Any]:
    """把 db 层的 snake_case 行转为与其它路由一致的 camelCase 契约。"""
    return {
        "id": row["id"],
        "name": row.get("name"),
        "cron": row.get("cron"),
        "prompt": row.get("prompt"),
        "enabled": bool(row.get("enabled")),
        "skills": row.get("skills") or [],
        "userId": row.get("user_id"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "nextRunAt": row.get("next_run_at"),
        "lastRunAt": row.get("last_run_at"),
        "runCount": int(row.get("run_count") or 0),
        "lastSessionId": row.get("last_session_id"),
        "lastError": row.get("last_error"),
    }


def _next_run_iso(cron: str) -> Optional[str]:
    try:
        return scheduler.next_run(cron, datetime.now()).isoformat()
    except ValueError:
        return None


@schedules_router.get("")
def list_schedules() -> dict[str, Any]:
    return {"schedules": [_public_schedule(r) for r in db.list_schedules()]}


@schedules_router.post("/validate")
def validate_schedule(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    cron = str((payload or {}).get("cron") or "")
    try:
        upcoming = scheduler.next_run(cron, datetime.now())
    except (ValueError, TypeError) as err:
        raise HTTPException(status_code=400, detail=str(err))
    return {"ok": True, "nextRun": upcoming.isoformat()}


@schedules_router.post("")
def create_schedule(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    cron = str(body.get("cron") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    name = str(body.get("name") or "").strip()
    if not cron or not prompt:
        raise HTTPException(status_code=400, detail="cron and prompt are required")
    try:
        scheduler.validate(cron)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=f"cron 非法: {err}")
    now = now_iso()
    row = {
        "id": new_id(),
        "name": name or f"定时任务 {cron}",
        "cron": cron,
        "prompt": prompt,
        "enabled": bool(body.get("enabled", True)),
        "skills": body.get("skills") or [],
        "user_id": body.get("user_id"),
        "created_at": now,
        "updated_at": now,
        "next_run_at": _next_run_iso(cron),
        "run_count": 0,
    }
    db.insert_schedule(row)
    created = db.get_schedule(row["id"])
    return {"ok": True, "schedule": _public_schedule(created) if created else None}


@schedules_router.put("/{schedule_id}")
def update_schedule(schedule_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    existing = db.get_schedule(schedule_id)
    if not existing:
        raise HTTPException(status_code=404, detail="schedule not found")
    body = payload or {}
    fields: dict[str, Any] = {}
    for key in ("name", "prompt", "enabled", "skills"):
        if key in body:
            fields[key] = body[key]
    if "cron" in body:
        cron = str(body["cron"] or "").strip()
        try:
            scheduler.validate(cron)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=f"cron 非法: {err}")
        fields["cron"] = cron
        fields["next_run_at"] = _next_run_iso(cron)
    fields["updated_at"] = now_iso()
    updated = db.update_schedule(schedule_id, fields)
    return {"ok": True, "schedule": _public_schedule(updated) if updated else None}


@schedules_router.delete("/{schedule_id}")
def delete_schedule(schedule_id: str) -> dict[str, Any]:
    if not db.delete_schedule(schedule_id):
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"ok": True}


@schedules_router.post("/{schedule_id}/run")
async def run_schedule(schedule_id: str) -> dict[str, Any]:
    if not db.get_schedule(schedule_id):
        raise HTTPException(status_code=404, detail="schedule not found")
    result = await scheduler.scheduler.trigger(schedule_id)
    schedule = result.get("schedule")
    return {
        "ok": result["ok"],
        "sessionId": result["sessionId"],
        "schedule": _public_schedule(schedule) if schedule else None,
        "error": result["error"],
    }


@schedules_router.get("/status")
def scheduler_status() -> dict[str, Any]:
    jobs = db.list_schedules()
    upcoming = [j["next_run_at"] for j in jobs if j.get("enabled") and j.get("next_run_at")]
    return {
        "running": scheduler.scheduler.running,
        "tickSeconds": scheduler.scheduler.tick,
        "count": len(jobs),
        "enabledCount": sum(1 for j in jobs if j.get("enabled")),
        "nextRunAt": min(upcoming) if upcoming else None,
    }
