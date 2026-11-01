"""P3 A2A 路由契约（需线程/本地 socket，放开沙箱执行）。"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from infrapilot import a2a, sessions
from infrapilot.main import app


def test_agent_card_endpoints():
    with TestClient(app) as client:
        for path in ("/.well-known/agent.json", "/.well-known/agent-card.json"):
            card = client.get(path).json()
            assert card["name"] == "InfraPilot"
            assert card["url"].endswith("/api/a2a")
            assert card["capabilities"]["streaming"] is True
        info = client.get("/api/a2a").json()
        assert info["ok"] is True and info["agent"] == "InfraPilot"


def test_a2a_jsonrpc_roundtrip(monkeypatch):
    async def fake_turn(session_id: str, text: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)
    with TestClient(app) as client:
        ping = client.post("/api/a2a", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).json()
        assert ping["result"] == {}

        unknown = client.post("/api/a2a", json={"jsonrpc": "2.0", "id": 2, "method": "nope"}).json()
        assert unknown["error"]["code"] == -32601

        sent = client.post(
            "/api/a2a",
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "message/send",
                "params": {"message": {"role": "user", "messageId": "m1", "parts": [{"kind": "text", "text": "disk full"}]}},
            },
        ).json()
        task = sent["result"]
        assert task["kind"] == "task"

        got = client.post("/api/a2a", json={"jsonrpc": "2.0", "id": 4, "method": "tasks/get", "params": {"id": task["id"]}}).json()
        assert got["result"]["id"] == task["id"]

        canceled = client.post("/api/a2a", json={"jsonrpc": "2.0", "id": 5, "method": "tasks/cancel", "params": {"id": task["id"]}}).json()
        assert canceled["result"]["status"]["state"] == "canceled"

        missing = client.post("/api/a2a", json={"jsonrpc": "2.0", "id": 6, "method": "tasks/get", "params": {"id": "nope"}}).json()
        assert missing["error"]["code"] == -32001


def test_a2a_message_stream_sse(monkeypatch):
    async def fake_turn(session_id: str, text: str) -> None:  # noqa: ARG001
        sessions.update_session(session_id, lambda s: setattr(s, "status", "concluded"))
        sessions.emit_event(session_id, "rca_conclusion", {"content": "网络抖动"})
        sessions.emit_event(session_id, "done", {})

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)
    with TestClient(app) as client:
        resp = client.post(
            "/api/a2a",
            json={
                "jsonrpc": "2.0",
                "id": 11,
                "method": "message/stream",
                "params": {"message": {"role": "user", "messageId": "m1", "parts": [{"kind": "text", "text": "网络问题"}]}},
            },
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = resp.text

        assert body.count("data:") >= 2
        assert '"kind": "task"' in body
        assert '"kind": "status-update"' in body
        assert '"final": true' in body
        assert "网络抖动" in body

        # 空 parts：返回 JSON-RPC 错误而非建流
        bad = client.post(
            "/api/a2a",
            json={"jsonrpc": "2.0", "id": 12, "method": "message/stream", "params": {"message": {"parts": []}}},
        )
        assert bad.headers["content-type"].startswith("application/json")
        assert bad.json()["error"]["code"] == -32001


def test_a2a_tasks_resubscribe_sse(monkeypatch):
    async def fake_turn(session_id: str, text: str) -> None:  # noqa: ARG001
        sessions.update_session(session_id, lambda s: setattr(s, "status", "concluded"))
        sessions.emit_event(session_id, "rca_conclusion", {"content": "重连内容"})
        sessions.emit_event(session_id, "done", {})

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)
    with TestClient(app) as client:
        sent = client.post(
            "/api/a2a",
            json={
                "jsonrpc": "2.0",
                "id": 20,
                "method": "message/send",
                "params": {"message": {"parts": [{"kind": "text", "text": "重连任务"}]}},
            },
        ).json()
        task_id = sent["result"]["id"]
        time.sleep(0.2)  # 等待后台轮次结束，使 resubscribe 走回放路径

        resp = client.post(
            "/api/a2a",
            json={"jsonrpc": "2.0", "id": 21, "method": "tasks/resubscribe", "params": {"id": task_id}},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = resp.text
        assert '"final": true' in body
        assert "重连内容" in body
        assert "id: " in body  # SSE 续传游标

        missing = client.post(
            "/api/a2a",
            json={"jsonrpc": "2.0", "id": 22, "method": "tasks/resubscribe", "params": {"id": "nope"}},
        )
        assert missing.headers["content-type"].startswith("application/json")
        assert missing.json()["error"]["code"] == -32001
