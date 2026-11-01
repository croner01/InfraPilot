"""用量统计 API（P0）—— 供前端 UsagePage 替换 MOCK 数据。"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Request

from .. import db, usage

usage_router = APIRouter()


@usage_router.get("/summary")
def get_usage_summary(request: Request) -> dict[str, Any]:
    days_text = request.query_params.get("days")
    session_limit = request.query_params.get("sessionLimit")
    return usage.summarize(
        days=int(days_text) if days_text and days_text.isdigit() else 14,
        session_limit=int(session_limit) if session_limit and session_limit.isdigit() else 20,
    )


@usage_router.get("/calls")
def get_usage_calls(request: Request) -> dict[str, Any]:
    session_id: Optional[str] = request.query_params.get("sessionId")
    limit = request.query_params.get("limit")
    return {"calls": db.list_llm_calls(session_id=session_id, limit=int(limit) if limit and limit.isdigit() else 200)}


@usage_router.get("/sessions/{session_id}")
def get_session_usage(session_id: str) -> dict[str, Any]:
    calls = db.list_llm_calls(session_id=session_id, limit=1000)
    prompt = sum(int(c["prompt_tokens"]) for c in calls)
    completion = sum(int(c["completion_tokens"]) for c in calls)
    return {
        "sessionId": session_id,
        "calls": len(calls),
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": prompt + completion,
        "cost": round(sum(float(c["cost"]) for c in calls), 6),
        "items": calls,
    }
