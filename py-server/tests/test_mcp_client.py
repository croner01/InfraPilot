"""MCP Client：endpoint 归一化、主机发现、JWT 签发与 tools/call 结果还原。"""

from __future__ import annotations

import json

import pytest

from infrapilot import mcp_client as mc


def test_normalize_endpoint_appends_jsonrpc_path():
    assert mc.normalize_endpoint("10.0.0.2:8443") == "http://10.0.0.2:8443/api/mcp"
    assert mc.normalize_endpoint("http://host:port") == "http://host:port/api/mcp"
    assert mc.normalize_endpoint("http://host/") == "http://host/api/mcp"
    assert mc.normalize_endpoint("http://host/api/mcp") == "http://host/api/mcp"
    with pytest.raises(mc.McpProbeError):
        mc.normalize_endpoint("")


def test_normalize_endpoint_used_by_post(monkeypatch):
    captured: dict[str, object] = {}

    class _Res:
        status_code = 200

        def json(self):
            return {"jsonrpc": "2.0", "id": 1, "result": {"serverInfo": {"name": "infrapilot"}}}

    import httpx

    class _Client:
        def __init__(self, *a, **k):
            captured["timeout"] = k.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return _Res()

    def _fake_asyncclient(*a, **k):
        return _Client()

    monkeypatch.setattr(httpx, "AsyncClient", _fake_asyncclient)
    info = mc.ping("10.1.1.1:9")
    assert info.get("name") == "infrapilot"
    assert captured["url"] == "http://10.1.1.1:9/api/mcp"
    assert captured["json"]["method"] == "initialize"


def test_sign_token_with_secret(monkeypatch):
    monkeypatch.setenv("MCP_JWT_SECRET", "s3cret")
    token = mc._sign_token("linux__get_cpu_usage")
    assert token
    import jwt

    payload = jwt.decode(token, "s3cret", algorithms=["HS256"])
    assert payload["sub"] == "infrapilot-server"
    assert payload["tools"] == ["linux__get_cpu_usage"]


def test_discover_endpoint_from_env_mapping(monkeypatch):
    monkeypatch.delenv("MCP_ENDPOINTS", raising=False)
    assert mc.discover_endpoint("whatever") is None
    monkeypatch.setattr("infrapilot.remote.get_host", lambda name: None, raising=False)
    monkeypatch.setenv("MCP_ENDPOINTS", '{"node-1": "10.0.0.5:8443"}')
    assert mc.discover_endpoint("node-1") == "10.0.0.5:8443"


def test_call_tool_parses_remote_tool_result(monkeypatch):
    response = {
        "jsonrpc": "2.0",
        "id": 3,
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {"success": True, "stdout": "ok", "durationMs": 5, "data": {"usage_percent": 12.5}}
                    ),
                }
            ]
        },
    }

    async def fake_post(endpoint, payload, tool, timeout_s):
        assert payload["method"] == "tools/call"
        assert payload["params"]["name"] == "linux__get_cpu_usage"
        return response

    monkeypatch.setattr(mc, "_post_json", fake_post)
    import asyncio

    out = asyncio.run(mc.call_tool("http://x/api/mcp", "linux__get_cpu_usage", {"host": "local"}))
    assert out.success is True
    assert out.stdout == "ok"
    assert out.data.get("transport") == "mcp"
    assert out.durationMs == 5


def test_call_tool_maps_remote_failure(monkeypatch):
    async def fake_post(endpoint, payload, tool, timeout_s):
        raise mc.McpProbeError("MCP endpoint 返回 502 (POST http://x/api/mcp)")

    monkeypatch.setattr(mc, "_post_json", fake_post)
    import asyncio

    out = asyncio.run(mc.call_tool("http://x/api/mcp", "linux__get_memory_info", {"host": "local"}))
    assert out.success is False
    assert "502" in (out.error or "")
