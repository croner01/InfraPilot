"""任务中断（「停止执行」）测试：确认进行中的轮次能被真正打断并收敛状态。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from infrapilot import a2a, db, llm, sessions, skills
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


def _cancel_events(session_id: str) -> list[dict]:
    rows = db.list_timeline_events(session_id)
    return [
        {**r, "payload": db.parse_json(r["payload"], None)}
        for r in rows
        if r["type"] in ("status", "done")
    ]


def test_cancel_interrupts_running_turn(monkeypatch):
    """工具执行中被中断：轮次立即结束，会话收敛为 closed 并广播 done。"""
    started = asyncio.Event()
    release = asyncio.Event()

    fake_client = _FakeClient(
        [
            _tool_call_response("linux__get_disk_usage", '{"host": "local"}'),
            _text_response("不应该执行到这里"),
        ]
    )
    monkeypatch.setattr(llm, "get_client", lambda: fake_client)

    async def blocking_dispatch(skill, tool, args):
        started.set()
        await release.wait()
        return ToolExecutionResult(success=True, data={}, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", blocking_dispatch)

    session = sessions.create_session("中断测试")

    async def scenario():
        task = asyncio.create_task(start_agent_turn(session.id, "磁盘满了，帮我看看"))
        await asyncio.wait_for(started.wait(), timeout=5)
        assert sessions.is_turn_active(session.id) is True
        interrupted = sessions.request_cancel(session.id)
        assert interrupted is True
        await asyncio.wait_for(task, timeout=5)
        return task

    asyncio.run(scenario())

    assert sessions.is_turn_active(session.id) is False
    refreshed = sessions.get_session(session.id)
    assert refreshed is not None and refreshed.status == "closed"
    kinds = [e["type"] for e in _cancel_events(session.id)]
    assert "done" in kinds
    status_payloads = [
        e["payload"] for e in _cancel_events(session.id) if e["type"] == "status"
    ]
    assert any((p or {}).get("status") == "canceled" for p in status_payloads)


def test_cancel_endpoint_closes_session_and_invalidates_approval(monkeypatch):
    """停在等待审批的会话：停止后状态收敛，且审批卡不再能恢复执行。"""
    fake_client = _FakeClient(
        [
            _tool_call_response(
                "linux__restart_service", '{"host": "local", "service_name": "nginx"}'
            )
        ]
    )
    monkeypatch.setattr(llm, "get_client", lambda: fake_client)

    session = sessions.create_session("审批中断测试")
    asyncio.run(start_agent_turn(session.id, "nginx 一直重启"))

    session = sessions.get_session(session.id)
    assert session is not None and session.status == "awaiting_approval"
    approval_id = session.pendingToolCalls[0].approvalId

    with TestClient(app) as client:
        res = client.post(f"/api/sessions/{session.id}/cancel").json()
        assert res["ok"] is True
        assert res["changed"] is True
        assert res["interrupted"] is False  # 没有活动轮次，只是收尾状态
        assert res["session"]["status"] == "closed"

        decided = client.post(
            f"/api/approvals/{approval_id}/decide", json={"approved": True, "approvedBy": "on-call"}
        ).json()
        assert decided["resumed"] is False

        # 幂等：重复停止不再改变状态
        again = client.post(f"/api/sessions/{session.id}/cancel").json()
        assert again["changed"] is False

    assert db.get_approval(approval_id)["decision"] == "rejected"


def test_cancel_unknown_session_returns_404():
    with TestClient(app) as client:
        res = client.post("/api/sessions/does-not-exist/cancel")
        assert res.status_code == 404


def test_a2a_cancel_requests_interrupt():
    session = sessions.create_session("A2A 取消测试")
    task = a2a.cancel_task({"id": session.id})
    assert task["status"]["state"] == "canceled"
    assert sessions.is_cancel_requested(session.id) is True
    refreshed = sessions.get_session(session.id)
    assert refreshed is not None and refreshed.status == "closed"


def test_new_turn_clears_stale_cancel_flag(monkeypatch):
    """中断后用户再次发消息：新一轮可正常执行（标记被清除）。"""
    fake_client = _FakeClient([_text_response("【根因分析结论】\n已恢复，置信度 0.9")])
    monkeypatch.setattr(llm, "get_client", lambda: fake_client)

    session = sessions.create_session("中断后重启测试")
    sessions.request_cancel(session.id)
    assert sessions.is_cancel_requested(session.id) is True

    asyncio.run(start_agent_turn(session.id, "继续排查"))

    assert sessions.is_cancel_requested(session.id) is False
    refreshed = sessions.get_session(session.id)
    assert refreshed is not None and refreshed.status == "concluded"
