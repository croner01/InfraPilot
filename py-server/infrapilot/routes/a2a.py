"""A2A 协议端点（P3）—— Agent Card + JSON-RPC + SSE 流式。

- `GET /.well-known/agent.json` / `/.well-known/agent-card.json`：Agent Card（无前缀挂载）
- `POST /api/a2a`：JSON-RPC（message/send、tasks/get、tasks/cancel）
- `POST /api/a2a` + `message/stream` / `tasks/resubscribe`：`text/event-stream` SSE 流式推送
  （Task → status-update / artifact-update → final status-update）；每帧带 `id:` 供断线续传
"""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import a2a, auth

a2a_router = APIRouter()
well_known_router = APIRouter()


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@well_known_router.get("/.well-known/agent.json")
@well_known_router.get("/.well-known/agent-card.json")
def agent_card(request: Request) -> dict[str, Any]:
    return a2a.agent_card(_base_url(request))


@a2a_router.get("")
def a2a_info(request: Request) -> dict[str, Any]:
    card = a2a.agent_card(_base_url(request))
    return {"ok": True, "protocolVersion": card["protocolVersion"], "agent": card["name"], "endpoint": card["url"]}


@a2a_router.post("")
async def a2a_endpoint(request: Request, payload: Any = Body(default=None)):
    user: Optional[dict[str, Any]] = auth.user_from_request(request)
    user_id = (user or {}).get("id")
    data = payload if isinstance(payload, dict) else {}

    method = data.get("method")
    if method in ("message/stream", "tasks/resubscribe"):
        request_id = data.get("id")
        params = data.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        try:
            if method == "tasks/resubscribe":
                results = await a2a.resubscribe_task(params, last_event_id=request.headers.get("last-event-id"))
            else:
                results = await a2a.stream_message(params, user_id=user_id)
        except ValueError as err:
            return JSONResponse(content=a2a._rpc_error(request_id, -32001, str(err)))
        return StreamingResponse(
            _sse_body(results, request_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    response = await a2a.handle_request(data, user_id=user_id)
    if response is None:
        return JSONResponse(status_code=202, content={"ok": True})
    return JSONResponse(content=response)


async def _sse_body(results: Any, request_id: Any):
    async for result in results:
        if result is None:
            yield ": ping\n\n"
            continue
        event_id = getattr(result, "event_id", None)
        payload = {"jsonrpc": "2.0", "id": request_id, "result": result}
        prefix = f"id: {event_id}\n" if event_id else ""
        yield f"{prefix}data: {json.dumps(payload, ensure_ascii=False)}\n\n"
