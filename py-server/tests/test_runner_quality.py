"""结论质量：置信度解析、知识沉淀字段、只读工具并发执行。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from infrapilot import db, knowledge, llm, sessions, skills
from infrapilot.models import Remediation, RemediationStep, RootCause, ToolExecutionResult
from infrapilot.orchestrator import start_agent_turn
from infrapilot.runner import extract_confidence, persist_root_cause_as_case


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


def _text_response(content: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, tool_calls=None))])


def _tool_call_response(name: str, arguments: str, call_id: str = "tc-1"):
    fn = SimpleNamespace(name=name, arguments=arguments)
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=[SimpleNamespace(id=call_id, function=fn)]))]
    )


def _multi_tool_response(calls):
    tool_calls = [
        SimpleNamespace(id=cid, function=SimpleNamespace(name=name, arguments=args)) for cid, name, args in calls
    ]
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=tool_calls))])


# -------------------- 置信度 --------------------


def test_extract_confidence_tolerates_markdown_and_percent():
    # 真实结论正文写法：**置信度**：**0.6** —— 旧正则跨不过 markdown，静默回退 0.75
    assert extract_confidence("- **根因摘要**：…。\n- **置信度**：**0.6**。") == 0.6
    assert extract_confidence("置信度：0.75") == 0.75
    assert extract_confidence("置信度 85%") == 0.85
    assert extract_confidence("置信度: 1") == 1.0


def test_extract_confidence_returns_none_instead_of_fabricating():
    assert extract_confidence("未给出置信度") is None
    assert extract_confidence("故不给更高置信度。") is None
    # 明显不是置信度的数字（年份）应被跳过，而不是算成 20.26 或 1.0
    assert extract_confidence("置信度 2026 年的数据") is None


def test_turn_without_stated_confidence_leaves_it_empty(monkeypatch):
    monkeypatch.setattr(llm, "get_client", lambda: _FakeClient([_text_response("【根因分析结论】\n磁盘写满导致 Pod 被驱逐。")]))
    session = sessions.create_session("缺置信度")
    asyncio.run(start_agent_turn(session.id, "排查磁盘"))
    root_cause = sessions.get_session(session.id).rootCause
    assert root_cause is not None and root_cause.summary
    assert root_cause.confidence is None


# -------------------- 知识沉淀 --------------------


def test_auto_persisted_case_has_clean_title_summary_and_solutions():
    session = sessions.create_session("t", subject="ems/ecp-dashboard-api")
    sessions.update_session(
        session.id,
        lambda s: setattr(
            s,
            "incidentSummary",
            "【服务健康】ems/ecp-dashboard-api\n- 健康状态: warn\n- 可用副本: 2/3\n请开始诊断：先确认该 Deployment 的期望/可用副本与最近事件。",
        ),
    )
    rca = "- **根因摘要**：\n  副本 8pq6f 被外部优雅终止。\n- **置信度**：**0.6**。"
    sessions.update_session(session.id, lambda s: setattr(s, "rootCause", RootCause(summary=rca, confidence=0.6)))
    sessions.update_session(
        session.id,
        lambda s: setattr(
            s,
            "remediation",
            Remediation(summary="修复方案", steps=[RemediationStep(description="删除卡死副本"), RemediationStep(description="cordon node-1")]),
        ),
    )

    asyncio.run(persist_root_cause_as_case(session.id, sessions.get_session(session.id), rca))

    case = next(c for c in knowledge.list_knowledge_cases() if c["sourceSessionId"] == session.id)
    assert case["title"] == "自动沉淀: ems/ecp-dashboard-api"
    assert "\n" not in case["title"]
    # 摘要应是根因结论而不是注入的提示词模板
    assert case["summary"].startswith("- **根因摘要**")
    assert "请开始诊断" not in case["summary"]
    assert case["solutions"] == ["删除卡死副本", "cordon node-1"]


# -------------------- 只读工具并发 --------------------


def test_parallel_readonly_calls_run_concurrently_and_record_in_order(monkeypatch):
    responses = [
        _multi_tool_response(
            [
                ("tc-1", "k8s__list_pods", '{"namespace": "ems"}'),
                ("tc-2", "k8s__get_events", '{"namespace": "ems", "pod_name": "p1"}'),
            ]
        ),
        _text_response("【根因分析结论】\n结论 X，置信度 0.6"),
        # 置信度 0.6 < 阈值：runner 会追加一轮「证据缺口自检」，模型补证后给出更高置信度
        _text_response("【根因分析结论】\n结论 X（已补齐探针证据），置信度 0.9"),
    ]
    monkeypatch.setattr(llm, "get_client", lambda: _FakeClient(responses))

    state = {"active": 0, "peak": 0}

    async def fake_dispatch(skill, tool, args):
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
        await asyncio.sleep(0.05)
        state["active"] -= 1
        return ToolExecutionResult(success=True, data={"tool": tool}, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)

    session = sessions.create_session("并发只读")
    asyncio.run(start_agent_turn(session.id, "看看 ems 的 Pod"))

    session = sessions.get_session(session.id)
    assert state["peak"] == 2, "只读调用应并发执行"
    # 并发执行但落库顺序必须与模型给出的一致（证据序号依赖它稳定）
    assert [e.type for e in session.evidence] == ["k8s.list_pods", "k8s.get_events"]
    assert session.status == "concluded"
    # 低置信度结论必须被自检追问改写，而不是直接收尾
    assert session.rootCause.confidence == 0.9
    assert any(e["type"] == "evidence_gap_probe" for e in db.list_timeline_events(session.id))


def test_tool_error_does_not_abort_sibling_calls(monkeypatch):
    responses = [
        _multi_tool_response(
            [
                ("tc-1", "k8s__list_pods", '{"namespace": "ems"}'),
                ("tc-2", "k8s__get_events", '{"namespace": "ems", "pod_name": "p1"}'),
            ]
        ),
        _text_response("【根因分析结论】\n结论 Y，置信度 0.5"),
        _text_response("【根因分析结论】\n结论 Y（补证后），置信度 0.9"),
    ]
    monkeypatch.setattr(llm, "get_client", lambda: _FakeClient(responses))

    async def fake_dispatch(skill, tool, args):
        if tool == "list_pods":
            raise RuntimeError("boom")
        return ToolExecutionResult(success=True, data={"ok": True}, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)

    session = sessions.create_session("并发异常")
    asyncio.run(start_agent_turn(session.id, "看看 ems 的 Pod"))

    session = sessions.get_session(session.id)
    assert session.status == "concluded"
    types = sorted(f"{t.skill}.{t.tool}" for t in session.executedToolCalls)
    assert types == ["k8s.get_events", "k8s.list_pods"]
    failed = [t for t in session.executedToolCalls if not t.result.success]
    assert len(failed) == 1 and "工具执行异常" in (failed[0].result.error or "")
