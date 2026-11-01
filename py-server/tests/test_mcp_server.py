"""P2 MCP Server 模式：JSON-RPC 协议 + 工具暴露 + 鉴权（纯离线）。"""

from __future__ import annotations

import asyncio

import jwt
import pytest

from infrapilot import config_store, mcp_server


def run(coro):
    return asyncio.run(coro)


def test_list_tools_matches_registry():
    tools = mcp_server.list_tools()
    assert len(tools) == len(__import__("infrapilot.skills", fromlist=["skills"]).all_tools())
    names = {t["name"] for t in tools}
    assert "k8s__describe_pod" in names
    assert "drawio__generate_flowchart" in names
    sample = next(t for t in tools if t["name"] == "k8s__describe_pod")
    assert sample["inputSchema"]["type"] == "object"
    assert "[risk=readonly]" in sample["description"]


def test_initialize_and_ping():
    init = run(mcp_server.handle_payload({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}))
    assert init["result"]["protocolVersion"] == mcp_server.PROTOCOL_VERSION
    assert init["result"]["serverInfo"]["name"] == "infrapilot"
    assert "tools" in init["result"]["capabilities"]
    ping = run(mcp_server.handle_payload({"jsonrpc": "2.0", "id": 2, "method": "ping"}))
    assert ping["result"] == {}


def test_tools_call_readonly_executes():
    response = run(
        mcp_server.handle_payload(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "drawio__generate_flowchart", "arguments": {"log_relations": [{"source": "a", "target": "b", "relation": "调用"}], "output_path": "mcp-test.drawio"}},
            }
        )
    )
    assert response["result"]["isError"] is False
    assert "drawio" in response["result"]["content"][0]["text"]


def test_tools_call_blocks_write_risk():
    response = run(
        mcp_server.handle_payload(
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "k8s__patch_resource_limits", "arguments": {}}}
        )
    )
    assert response["result"]["isError"] is True
    assert "风险" in response["result"]["content"][0]["text"]


def test_unknown_method_and_notification():
    err = run(mcp_server.handle_payload({"jsonrpc": "2.0", "id": 5, "method": "does/not/exist"}))
    assert err["error"]["code"] == -32601
    assert run(mcp_server.handle_payload({"jsonrpc": "2.0", "method": "notifications/initialized"})) is None


def test_batch_request():
    responses = run(
        mcp_server.handle_payload(
            [
                {"jsonrpc": "2.0", "id": 1, "method": "ping"},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            ]
        )
    )
    assert [r["id"] for r in responses] == [1, 2]


def test_verify_bearer_with_secret():
    original = config_store.get_mcp_config()
    try:
        config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": "s3cret-key-0123456789abcdefghijklmn"})
        token = jwt.encode({"sub": "agent-x"}, "s3cret-key-0123456789abcdefghijklmn", algorithm="HS256")
        assert mcp_server.verify_bearer(token)["sub"] == "agent-x"
        assert mcp_server.verify_bearer("garbage") is None
        assert mcp_server.verify_bearer(None) is None
    finally:
        config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": original.get("jwtSecret") or ""})


def test_verify_bearer_open_when_unconfigured():
    original = config_store.get_mcp_config()
    try:
        config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": ""})
        assert mcp_server.verify_bearer(None)["sub"] == "anonymous"
    finally:
        config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": original.get("jwtSecret") or ""})
