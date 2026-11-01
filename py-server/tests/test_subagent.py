"""P2 多 Agent / 子 Agent：隔离子会话、结论回传、递归护栏（LLM 打桩）。"""

from __future__ import annotations

import asyncio

import pytest

from infrapilot import orchestrator, sessions, subagent
from infrapilot.models import RootCause
from infrapilot.skills import subagent as skill


def run(coro):
    return asyncio.run(coro)


def test_subagent_tool_def():
    assert [t.name for t in skill.TOOLS] == ["task"]
    assert skill.TOOLS[0].skill == "subagent"
    assert skill.TOOLS[0].risk == "low"


def test_run_subagent_returns_structured_conclusion(monkeypatch):
    async def fake_turn(session_id: str, prompt: str) -> None:  # noqa: ARG001
        def _finish(s) -> None:
            s.status = "concluded"
            s.rootCause = RootCause(summary="order-api OOM 因内存限制过低", confidence=0.82)
        sessions.update_session(session_id, _finish)

    monkeypatch.setattr(orchestrator, "start_agent_turn", fake_turn)
    result = run(subagent.run_subagent("排查 order-api 最近错误日志"))
    assert result["ok"] is True
    assert result["conclusion"] == "order-api OOM 因内存限制过低"
    assert result["confidence"] == 0.82
    assert result["sessionId"]
    # 子会话确实被独立创建
    assert sessions.get_session(result["sessionId"]) is not None


def test_run_subagent_recursion_guard(monkeypatch):
    monkeypatch.setattr(subagent, "_MAX_DEPTH", 1)
    token = subagent._depth.set(1)
    try:
        result = run(subagent.run_subagent("递归"))
    finally:
        subagent._depth.reset(token)
    assert result["ok"] is False
    assert "递归深度" in result["error"]


def test_subagent_tool_execute_paths(monkeypatch):
    assert run(skill.execute("task", {})).success is False
    assert run(skill.execute("nope", {"task": "x"})).success is False

    async def fake_run(task: str, **kwargs):  # noqa: ARG001
        return {"ok": True, "sessionId": "s1", "conclusion": "done"}

    monkeypatch.setattr(skill, "run_subagent", fake_run)
    result = run(skill.execute("task", {"task": "子任务"}))
    assert result.success is True
    assert result.data["conclusion"] == "done"
