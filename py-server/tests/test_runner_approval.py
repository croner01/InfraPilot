"""Agent 循环 + 审批中断/恢复的端到端测试（用假 LLM，不依赖网络）。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from infrapilot import db, llm, skills, sessions
from infrapilot.models import ToolExecutionResult
from infrapilot.orchestrator import resume_agent_turn, start_agent_turn


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
        # 共享同一个队列：llm.get_client() 每次都会新建 client，必须保证响应只被消费一次
        self._responses = responses

    async def create(self, **kwargs):
        if not self._responses:
            raise AssertionError("fake LLM 没有更多预设响应")
        return self._responses.pop(0)


class _FakeClient:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=_FakeCompletions(responses))


def test_high_risk_tool_interrupts_for_approval_then_resumes(monkeypatch):
    responses = [
        _tool_call_response(
            "linux__restart_service", '{"host": "local", "service_name": "nginx"}'
        ),
        _text_response("【根因分析结论】\nnginx 服务异常退出，置信度 0.92"),
    ]
    fake_client = _FakeClient(responses)
    monkeypatch.setattr(llm, "get_client", lambda: fake_client)

    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, data={"restarted": tool}, durationMs=2)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)

    session = sessions.create_session("审批回路测试")
    asyncio.run(start_agent_turn(session.id, "生产环境有服务一直重启,帮我看看什么原因"))

    session = sessions.get_session(session.id)
    assert session.status == "awaiting_approval"
    assert len(session.pendingToolCalls) == 1
    approval_id = session.pendingToolCalls[0].approvalId
    assert approval_id
    approval = db.get_approval(approval_id)
    assert approval["decision"] == "pending"
    assert approval["risk_level"] == "high"

    # 审批通过后恢复执行
    db.decide_approval(approval_id, "approved", "on-call")
    asyncio.run(resume_agent_turn(session.id, approval_id))

    session = sessions.get_session(session.id)
    assert session.status == "concluded"
    assert session.rootCause is not None
    assert "nginx" in session.rootCause.summary
    assert session.pendingToolCalls == []
    assert len(session.executedToolCalls) == 1

    audits = db.list_audit_by_session(session.id)
    assert len(audits) == 1
    assert audits[0]["tool"] == "restart_service"
    assert audits[0]["approved_by"] == "on-call"
    assert audits[0]["risk_level"] == "high"

    # 审批中断点已持久化（可重启恢复）
    assert db.load_checkpoint_db(session.id) is not None


def test_readonly_tool_executes_without_approval_and_records_evidence(monkeypatch):
    responses = [
        _tool_call_response("linux__get_cpu_usage", '{"host": "local"}'),
        _text_response("【根因分析结论】\nCPU 正常，置信度 0.8"),
    ]
    fake_client = _FakeClient(responses)
    monkeypatch.setattr(llm, "get_client", lambda: fake_client)

    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, stdout="top output", durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)

    session = sessions.create_session("只读工具测试")
    asyncio.run(start_agent_turn(session.id, "看看 CPU 使用率"))
    session = sessions.get_session(session.id)

    assert session.status == "concluded"
    assert len(session.evidence) == 1
    assert session.evidence[0].type == "linux.get_cpu_usage"
    audits = db.list_audit_by_session(session.id)
    assert len(audits) == 1 and audits[0]["success"] == 1
    assert audits[0]["approved_by"] is None


def test_timeline_events_are_persisted(monkeypatch):
    responses = [_text_response("这是通用的排查流程说明。")]
    fake_client = _FakeClient(responses)
    monkeypatch.setattr(llm, "get_client", lambda: fake_client)

    session = sessions.create_session("事件持久化测试")
    asyncio.run(start_agent_turn(session.id, "如何排查 OOM"))

    types = [row["type"] for row in db.list_timeline_events(session.id)]
    assert "session_created" in types
    assert "user_message" in types or "assistant_message" in types
    assert "checkpoint_saved" in types
    assert "done" in types
