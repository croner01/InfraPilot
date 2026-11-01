"""MCP Server HTTP 端点（P2）—— `POST /api/mcp`。

JSON-RPC 2.0（Model Context Protocol）。鉴权独立于 `/api/auth`：
使用 `MCP_JWT_SECRET` / runtime-config `mcp.jwtSecret` 签发的 HS256 JWT；
未配置 secret 时放开（本地开发）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Header, Request
from fastapi.responses import JSONResponse

from .. import mcp_server

mcp_router = APIRouter()


def _bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    value = authorization.strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return value


@mcp_router.get("")
def mcp_info() -> dict[str, Any]:
    return {
        "ok": True,
        "protocolVersion": mcp_server.PROTOCOL_VERSION,
        "serverInfo": mcp_server.SERVER_INFO,
        "transport": "http-jsonrpc",
        "toolCount": len(mcp_server.list_tools()),
    }


@mcp_router.post("")
async def mcp_endpoint(
    request: Request,
    payload: Any = Body(default=None),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    if mcp_server.verify_bearer(_bearer(authorization)) is None:
        return JSONResponse(status_code=401, content={"error": "未认证"})
    headers = request.headers
    allow_write = mcp_server.allow_write_default() or headers.get("x-infrapilot-allow-write") == "1"
    response = await mcp_server.handle_payload(payload, allow_write=allow_write)
    if response is None:
        return JSONResponse(status_code=202, content={"ok": True})
    return JSONResponse(content=response)
