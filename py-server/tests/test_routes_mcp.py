"""P2 MCP HTTP 端点契约（需线程/本地 socket，放开沙箱执行）。"""

from __future__ import annotations

import jwt
from fastapi.testclient import TestClient

from infrapilot import config_store
from infrapilot.main import app


def _restore(original: dict) -> None:
    config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": original.get("jwtSecret") or ""})


def test_mcp_http_open_when_unconfigured():
    original = config_store.get_mcp_config()
    config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": ""})
    try:
        with TestClient(app) as client:
            info = client.get("/api/mcp").json()
            assert info["serverInfo"]["name"] == "infrapilot"
            assert info["toolCount"] > 0
            init = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}).json()
            assert init["result"]["protocolVersion"]
            listed = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).json()
            assert len(listed["result"]["tools"]) == info["toolCount"]
            called = client.post(
                "/api/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "drawio__generate_flowchart", "arguments": {"log_relations": [{"source": "a", "target": "b", "relation": "call"}], "output_path": "mcp-route.drawio"}},
                },
            ).json()
            assert called["result"]["isError"] is False, called["result"]["content"][0]["text"]
    finally:
        _restore(original)


def test_mcp_http_requires_bearer_when_secret_configured():
    original = config_store.get_mcp_config()
    secret = "mcp-secret-0123456789abcdefghijklmnopqrstuvwxyz"
    config_store.set_mcp_config({"serverPort": original.get("serverPort") or 8443, "jwtSecret": secret})
    try:
        with TestClient(app) as client:
            payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize"}
            assert client.post("/api/mcp", json=payload).status_code == 401
            token = jwt.encode({"sub": "external-agent"}, secret, algorithm="HS256")
            ok = client.post("/api/mcp", json=payload, headers={"Authorization": f"Bearer {token}"})
            assert ok.status_code == 200
            assert ok.json()["result"]["serverInfo"]["name"] == "infrapilot"
    finally:
        _restore(original)
