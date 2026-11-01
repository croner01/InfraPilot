"""会话级免审批白名单：DB 往返、路由契约与 Runner 自动批准路径。

需要本地 socket 的用例（TestClient）请在放开沙箱的环境执行。
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from infrapilot import db, llm, skills, sessions
from infrapilot.main import app
from infrapilot.models import ToolExecutionResult
from infrapilot.orchestrator import start_agent_turn


def _tool_call_response(name: str, arguments: str, call_id: str = "tc-1"):
    fn = SimpleNamespace(name=name, arguments=arguments)
    tool_call = SimpleNamespace(id=call_id, function=fn)
    message = SimpleNamespace(content=None, tool_calls=[tool_call])
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _text_response(content: str):
    message = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class _FakeCompletions:
    def __init__(self, responses):
        self._responses = responses

    async def create(self, **kwargs):
        if not self._responses:
            raise AssertionError("fake LLM 没有更多预设响应")
        return self._responses.pop(0)


class _FakeClient:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=_FakeCompletions(responses))


def test_allowlist_db_roundtrip():
    session = sessions.create_session("白名单 DB 往返")
    assert db.is_allowlisted(session.id, "interpreter", "run_python") is False
    db.upsert_allowlist(session.id, "interpreter", "run_python", "on-call")
    # 幂等：重复写入不产生重复行
    db.upsert_allowlist(session.id, "interpreter", "run_python", "on-call")
    rows = db.list_allowlist(session.id)
    assert len(rows) == 1
    assert rows[0] == {
        "skill": "interpreter",
        "tool": "run_python",
        "createdAt": rows[0]["createdAt"],
        "createdBy": "on-call",
    }
    assert db.is_allowlisted(session.id, "interpreter", "run_python") is True
    assert db.delete_allowlist(session.id, "interpreter", "run_python") is True
    assert db.list_allowlist(session.id) == []


def test_allowlist_routes_and_risk_gate():
    with TestClient(app) as client:
        sid = client.post("/api/sessions", json={"title": "白名单路由"}).json()["id"]

        assert client.get(f"/api/sessions/{sid}/allowlist").json() == {"allowlist": []}

        created = client.post(
            f"/api/sessions/{sid}/allowlist", json={"skill": "interpreter", "tool": "run_python"}
        )
        assert created.status_code == 200
        body = created.json()
        assert body["ok"] is True
        assert body["allowlist"][0]["skill"] == "interpreter"
        assert body["allowlist"][0]["tool"] == "run_python"

        # high 风险工具不允许加入白名单
        assert (
            client.post(
                f"/api/sessions/{sid}/allowlist", json={"skill": "linux", "tool": "restart_service"}
            ).status_code
            == 400
        )
        # 未注册工具拒绝
        assert (
            client.post(f"/api/sessions/{sid}/allowlist", json={"skill": "nope", "tool": "nope"}).status_code
            == 400
        )
        # 缺少字段拒绝
        assert client.post(f"/api/sessions/{sid}/allowlist", json={"skill": "interpreter"}).status_code == 400
        # 会话不存在拒绝
        assert (
            client.post(
                "/api/sessions/__missing__/allowlist", json={"skill": "interpreter", "tool": "run_python"}
            ).status_code
            == 404
        )

        removed = client.delete(f"/api/sessions/{sid}/allowlist/interpreter/run_python")
        assert removed.status_code == 200
        assert removed.json()["allowlist"] == []


def test_medium_tool_interrupts_without_allowlist(monkeypatch):
    responses = [
        _tool_call_response("interpreter__run_python", '{"code": "print(1)"}'),
    ]
    monkeypatch.setattr(llm, "get_client", lambda: _FakeClient(responses))

    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, data={"stdout": "1"}, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)

    session = sessions.create_session("未白名单 medium 中断")
    asyncio.run(start_agent_turn(session.id, "帮我跑个脚本"))
    session = sessions.get_session(session.id)
    assert session.status == "awaiting_approval"
    assert len(session.pendingToolCalls) == 1
    assert db.get_approval(session.pendingToolCalls[0].approvalId)["decision"] == "pending"


def test_allowlisted_medium_tool_auto_approves(monkeypatch):
    responses = [
        _tool_call_response("interpreter__run_python", '{"code": "print(1)"}'),
        _text_response("【根因分析结论】\n脚本执行完成，置信度 0.9"),
    ]
    monkeypatch.setattr(llm, "get_client", lambda: _FakeClient(responses))

    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, data={"stdout": "1"}, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)

    session = sessions.create_session("白名单自动批准")
    db.upsert_allowlist(session.id, "interpreter", "run_python", "on-call")
    asyncio.run(start_agent_turn(session.id, "帮我跑个脚本"))

    session = sessions.get_session(session.id)
    assert session.status == "concluded"
    assert session.pendingToolCalls == []
    assert len(session.executedToolCalls) == 1

    audits = db.list_audit_by_session(session.id)
    assert len(audits) == 1
    assert audits[0]["tool"] == "run_python"
    assert audits[0]["risk_level"] == "medium"
    assert audits[0]["approved_by"] == "session-allowlist"

    types = [row["type"] for row in db.list_timeline_events(session.id)]
    assert "approval_decision" in types
    assert "approval_request" not in types
