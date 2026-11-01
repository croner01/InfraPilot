"""MCP Server 模式（P2）—— 把 InfraPilot 自身暴露为 MCP 工具供其他 Agent 调用。

对应差距分析 §3 #9「MCP Server 模式（把 InfraPilot 自身暴露为 MCP 工具供其他 Agent 调用）」。
Node 版只有 MCP **Client**（gRPC linux-mcp-server），没有对外暴露 MCP Server；Python 版补齐。

协议：Model Context Protocol（JSON-RPC 2.0），实现 `initialize` / `tools/list` / `tools/call`
/ `ping` 与 `notifications/initialized`。传输方式：
- HTTP：`POST /api/mcp`（见 `routes/mcp.py`），带 `Authorization: Bearer <jwt>`；
- stdio：`MCP_SERVER_MODE=stdio python3 -m infrapilot.mcp_server`（本地 CLI 集成）；
- 独立 HTTP 进程：`MCP_SERVER_MODE=http python3 -m infrapilot.mcp_server`（端口 `MCP_SERVER_PORT`）。

安全：写操作（medium+ 风险）不直接执行，而是要求走审批网关，MCP 调用默认只放行
readonly/low 工具（可通过 `INFRAPILOT_MCP_ALLOW_WRITE=1` 放开为"提交审批"模式）。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Optional

import jwt

from . import db, gateway, policy, skills
from .config_store import get_mcp_config
from .models import PendingToolCall
from .util import new_id

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "infrapilot", "version": "0.2.0"}

# 与前端/Agent 命名约定一致：{skill}__{tool}
SEP = "__"


def _secret() -> Optional[str]:
    config = get_mcp_config()
    secret = config.get("jwtSecret") or os.environ.get("MCP_JWT_SECRET")
    return secret or None


def verify_bearer(token: Optional[str]) -> Optional[dict[str, Any]]:
    """校验 MCP JWT；未配置 secret 时放开（本地开发），返回调用方身份。"""
    secret = _secret()
    if not secret:
        return {"sub": "anonymous", "source": "mcp"}
    if not token:
        return None
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if not payload.get("sub"):
        return None
    payload["source"] = "mcp"
    return payload


def list_tools() -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for tool in skills.all_tools():
        tools.append(
            {
                "name": f"{tool.skill}{SEP}{tool.name}",
                "description": f"[risk={tool.risk}] {tool.description}",
                "inputSchema": tool.parameters,
            }
        )
    return tools


def _text(content: str, *, is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": content}], "isError": is_error}


async def call_tool(name: str, arguments: Optional[dict[str, Any]] = None, *, allow_write: bool = False) -> dict[str, Any]:
    args = arguments or {}
    if SEP not in name:
        return _text(f"工具名非法（应形如 skill{SEP}tool）: {name}", is_error=True)
    skill, _, tool = name.partition(SEP)
    definition = policy.find_tool(skill, tool)
    if definition is None:
        return _text(f"未注册的工具: {name}", is_error=True)

    decision = policy.classify_risk(skill, tool, args)
    if decision.requiresApproval and not allow_write:
        return _text(
            f"工具 {name} 风险等级为 {decision.level}（{decision.reason}），"
            "MCP 调用默认只允许只读工具；如需执行请通过 InfraPilot 会话内审批流程。",
            is_error=True,
        )

    session_id = f"mcp-{new_id()}"
    pending = PendingToolCall(id=new_id(), skill=skill, tool=tool, args=args, risk=decision, approvalId=None)
    # allow_write 模式下 medium+ 无审批令牌 → 网关注明并拒执行（审计留痕），语义等价于"提交待审批"。
    result = await gateway.execute_tool_call(pending, session_id, "mcp-client", approved_by=None)
    text = json.dumps(result.model_dump(), ensure_ascii=False, default=str)
    return _text(text, is_error=not result.success)


async def handle_request(payload: dict[str, Any], *, allow_write: bool = False) -> Optional[dict[str, Any]]:
    """处理单条 JSON-RPC 请求；通知类返回 None。"""
    if not isinstance(payload, dict):
        return _error(None, -32600, "invalid request")
    method = payload.get("method")
    request_id = payload.get("id")
    is_notification = "id" not in payload
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    if method == "initialize":
        result: Any = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        }
    elif method in ("notifications/initialized", "notifications/cancelled"):
        return None
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": list_tools()}
    elif method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        result = await call_tool(name, arguments, allow_write=allow_write)
    elif method in ("resources/list", "prompts/list"):
        result = {"resources": []} if method == "resources/list" else {"prompts": []}
    else:
        if is_notification:
            return None
        return _error(request_id, -32601, f"method not found: {method}")

    if is_notification:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


async def handle_payload(payload: Any, *, allow_write: bool = False) -> Optional[Any]:
    """支持 JSON-RPC 批量请求（数组）与单条请求。"""
    if isinstance(payload, list):
        responses = []
        for item in payload:
            response = await handle_request(item, allow_write=allow_write)
            if response is not None:
                responses.append(response)
        return responses or None
    return await handle_request(payload, allow_write=allow_write)


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def allow_write_default() -> bool:
    return os.environ.get("INFRAPILOT_MCP_ALLOW_WRITE") == "1"


# -------------------- stdio transport --------------------


def serve_stdio() -> None:
    """逐行读取 JSON-RPC 并回写响应（MCP stdio 传输）。"""
    import asyncio

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps(_error(None, -32700, "parse error")), flush=True)
            continue
        response = asyncio.run(handle_payload(payload, allow_write=allow_write_default()))
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)


def serve_http() -> None:
    """以独立 uvicorn 进程提供 MCP HTTP 端点（复用 FastAPI app）。"""
    import uvicorn

    port = int(os.environ.get("MCP_SERVER_PORT") or get_mcp_config().get("serverPort") or 8443)
    uvicorn.run("infrapilot.main:app", host="0.0.0.0", port=port, log_level="info")


def main() -> None:
    mode = (os.environ.get("MCP_SERVER_MODE") or "stdio").lower()
    db.init_db()
    if mode in ("http", "true", "1"):
        serve_http()
    else:
        serve_stdio()


if __name__ == "__main__":
    main()
