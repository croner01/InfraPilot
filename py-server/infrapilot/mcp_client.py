"""MCP Client —— 通过标准 MCP（JSON-RPC 2.0 over HTTP）调用远端 InfraPilot MCP Agent。

对应已删除的 Node 版 `server/src/mcp/{client,discovery,grpcClient}.ts`（gRPC linux-mcp-server
通道），语义保持一致：
- Host Registry 中 `auth.type=="mcp"` 的主机优先走 MCP（endpoint 形如 `host:port` 或完整 URL）；
- `MCP_ENDPOINTS` 环境变量（JSON: {"host": "host:port"}）作为兼容回退（Node 版遗留方式）；
- 远端 linux 工具调用会把 host 归一为 local —— 语义即「在该节点上的 Agent 于其本机执行」；
- SSH 通道仍由 linux skill 自己兜底只读工具（见 skills/linux.py），本模块不再降级；
- 变更类工具是否可执行由远端 MCP Server 把关（对端默认只读；
  `INFRAPILOT_MCP_ALLOW_WRITE=1` 时 medium+ 走"提交审批"语义）。

远端 Agent 启动方式（与 py-server 自带的 MCP Server 一致）：
    MCP_SERVER_MODE=http python3 -m infrapilot.mcp_server   # 端口 MCP_SERVER_PORT
或直接在已运行的服务上使用 `POST /api/mcp` 端点。任何实现 MCP tools/call 的 HTTP 端点均可。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

from .models import ToolExecutionResult

PROTOCOL_VERSION = "2024-11-05"

DEFAULT_TIMEOUT_MS = 10000
MUTATION_TIMEOUT_MS = 30000
DEFAULT_MCP_PATH = "/api/mcp"


class McpProbeError(RuntimeError):
    """MCP health/tool 调用的用户可见错误（不含凭据/栈信息）。"""


def _mcp_jwt_secret() -> Optional[str]:
    secret = os.environ.get("MCP_JWT_SECRET")
    if secret:
        return secret
    try:
        from .config_store import get_mcp_config

        return get_mcp_config().get("jwtSecret") or None
    except Exception:  # noqa: BLE001 - config_store 不可用时视作无密钥
        return None


def _sign_token(tool: str, expires_in: int = 300) -> Optional[str]:
    """与 Node 版 mcp/auth.ts::signMcpJwt 同构：主 server 本地签发短期 JWT。"""
    secret = _mcp_jwt_secret()
    if not secret:
        return None

    import jwt

    now = int(time.time())
    return jwt.encode(
        {
            "sub": "infrapilot-server",
            "aud": "infrapilot-mcp",
            "tools": [tool],
            "iat": now,
            "exp": now + expires_in,
        },
        secret,
        algorithm="HS256",
    )


def normalize_endpoint(endpoint: str) -> str:
    """`host:port` / `http://host:port[/path]` -> 完整 JSON-RPC URL（默认拼 /api/mcp）。"""
    raw = str(endpoint or "").strip()
    if not raw:
        raise McpProbeError("MCP endpoint is empty")
    if not raw.startswith(("http://", "https://")):
        raw = f"http://{raw}"
    base = raw.rstrip("/")
    if not base.lower().endswith(DEFAULT_MCP_PATH):
        return base + DEFAULT_MCP_PATH
    return base


def _timeout_for(skill: str, tool: str, args: dict[str, Any]) -> int:
    """与 Node grpcClient 一致：变更类调用给更长的 deadline。"""
    try:
        from . import policy

        decision = policy.classify_risk(skill, tool, args)
        return MUTATION_TIMEOUT_MS if decision.requiresApproval else DEFAULT_TIMEOUT_MS
    except Exception:  # noqa: BLE001 - 工具未注册等场景走默认
        return DEFAULT_TIMEOUT_MS


def discover_endpoint(host: str) -> Optional[str]:
    """主机 -> MCP endpoint。优先 Host Registry(mcp 类型)，回退 MCP_ENDPOINTS 环境变量。"""
    if not host or host == "local":
        return None
    try:
        from . import remote as remote_skill

        cfg = remote_skill.get_host(host)
        auth = (cfg or {}).get("auth") or {}
        if auth.get("type") == "mcp" and auth.get("endpoint"):
            return str(auth["endpoint"])
    except Exception:  # noqa: BLE001 - 仅尽力读取 registry
        pass
    raw = os.environ.get("MCP_ENDPOINTS")
    if raw:
        try:
            mapping = json.loads(raw)
        except ValueError:
            return None
        if isinstance(mapping, dict) and mapping.get(host):
            return str(mapping[host])
    return None


async def _post_json(endpoint: str, payload: dict[str, Any], tool: str, timeout_s: float) -> dict[str, Any]:
    import httpx

    url = normalize_endpoint(endpoint)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = _sign_token(tool)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            res = await client.post(url, json=payload, headers=headers)
    except Exception as err:  # noqa: BLE001
        raise McpProbeError(f"MCP endpoint 不可达 (POST {url}): {err}") from None
    if res.status_code >= 400:
        raise McpProbeError(f"MCP endpoint 返回 {res.status_code} (POST {url})")
    try:
        body = res.json()
    except ValueError:
        raise McpProbeError(f"MCP endpoint 返回非 JSON 响应 (POST {url})") from None
    if not isinstance(body, dict):
        raise McpProbeError("MCP endpoint 返回空 JSON-RPC 响应")
    if body.get("error"):
        err = body["error"]
        message = err.get("message") if isinstance(err, dict) else str(err)
        raise McpProbeError(f"MCP JSON-RPC 错误: {message}")
    return body


async def ping(endpoint: str, timeout_s: float = 5.0) -> dict[str, Any]:
    """健康检查：标准 MCP `initialize`，返回远端 serverInfo。"""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "infrapilot-client", "version": "0.2.0"},
        },
    }
    body = await _post_json(endpoint, payload, "initialize", timeout_s)
    result = body.get("result") or {}
    return result.get("serverInfo") or result


async def list_tools(endpoint: str) -> list[dict[str, Any]]:
    """远端工具清单（tools/list）。"""
    payload = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    body = await _post_json(endpoint, payload, "tools/list", 10)
    return (body.get("result") or {}).get("tools") or []


async def call_tool(
    endpoint: str, name: str, args: dict[str, Any], timeout_ms: Optional[int] = None
) -> ToolExecutionResult:
    """远端 `tools/call`。远端把 ToolExecutionResult 序列化进 content[0].text，这里解析还原。"""
    start = time.time()
    skill, _, tool = str(name).partition("__")
    if not tool:
        return ToolExecutionResult(success=False, error=f"MCP 工具名非法: {name}", durationMs=0)
    effective_timeout = int(timeout_ms or _timeout_for(skill, tool, args))

    payload = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
    }
    try:
        body = await _post_json(endpoint, payload, name, effective_timeout / 1000)
    except McpProbeError as err:
        return ToolExecutionResult(success=False, error=str(err), durationMs=int((time.time() - start) * 1000))

    result = body.get("result") or {}
    content = result.get("content") or []
    text = ""
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = str(item.get("text") or "")
            break
    if not text:
        return ToolExecutionResult(
            success=False,
            error="MCP tools/call 返回无文本内容(isError=%s)" % result.get("isError"),
            durationMs=int((time.time() - start) * 1000),
        )

    # py-server 的 MCP Server 把 ToolExecutionResult.model_dump() 序列化为 JSON 文本；
    # 兼容远端直接返回纯文本 stdout 的情形。
    parsed: dict[str, Any]
    try:
        maybe = json.loads(text)
        parsed = maybe if isinstance(maybe, dict) else {"success": True, "stdout": text}
    except ValueError:
        return ToolExecutionResult(
            success=True,
            stdout=text,
            data={"transport": "mcp", "raw": True},
            durationMs=int((time.time() - start) * 1000),
        )

    data = parsed.get("data")
    merged_data = {**(data or {}), "transport": "mcp"}
    return ToolExecutionResult(
        success=bool(parsed.get("success")),
        error=parsed.get("error"),
        stdout=parsed.get("stdout"),
        stderr=parsed.get("stderr"),
        data=merged_data,
        durationMs=int(parsed.get("durationMs") or int((time.time() - start) * 1000)),
    )
