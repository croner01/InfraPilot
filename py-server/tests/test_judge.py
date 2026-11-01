"""P2 LLM-as-judge：启发式基线 / LLM 评分 / 降级 / 会话级评判。"""

from __future__ import annotations

import asyncio

from infrapilot import judge, sessions, structured


def run(coro):
    return asyncio.run(coro)


RICH_CONTEXT = {
    "message": "order-api 频繁 OOMKilled",
    "rootCause": "容器内存限制 512Mi 过低，导致 OOMKilled 后反复重启",
    "confidence": 0.82,
    "toolsUsed": [{"skill": "k8s", "tool": "list_pods"}, {"skill": "elk", "tool": "search_logs"}],
    "evidence": ["pod 状态 OOMKilled x5", "日志出现 OOM 关键字", "limit=512Mi"],
    "hypotheses": [{"statement": "内存限制过低", "status": "confirmed"}],
}


def test_heuristic_judge_scores_rich_context_pass():
    result = judge.heuristic_judge(RICH_CONTEXT)
    assert result["mode"] == "heuristic"
    assert result["score"] >= judge.PASS_THRESHOLD
    assert result["verdict"] == "pass"


def test_heuristic_judge_flags_empty_context():
    result = judge.heuristic_judge({"rootCause": "", "toolsUsed": [], "evidence": []})
    assert result["verdict"] == "fail"
    assert result["score"] < judge.PASS_THRESHOLD
    assert result["weaknesses"]


def test_heuristic_judge_compares_against_golden():
    matching = judge.heuristic_judge({**RICH_CONTEXT, "expected": "内存限制过低导致 OOMKilled"})
    unrelated = judge.heuristic_judge({**RICH_CONTEXT, "expected": "DNS 解析失败导致连接超时"})
    assert matching["score"] > unrelated["score"]
    assert "与金标准结论方向一致" in matching["strengths"]


def test_judge_conclusion_uses_llm(monkeypatch):
    async def fake(**kwargs):
        assert kwargs["name"] == "agent_judge"
        return {"score": 0.91, "verdict": "fail", "rationale": "证据充分", "strengths": ["a"], "weaknesses": [], "hallucination_risk": 0.05}

    monkeypatch.setattr(structured, "structured_completion", fake)
    result = run(judge.judge_conclusion(RICH_CONTEXT))
    assert result["mode"] == "llm"
    assert result["score"] == 0.91
    # verdict 由 score 归一化，不受模型返回影响
    assert result["verdict"] == "pass"


def test_judge_conclusion_falls_back_to_heuristic(monkeypatch):
    async def boom(**kwargs):
        raise RuntimeError("judge llm down")

    monkeypatch.setattr(structured, "structured_completion", boom)
    result = run(judge.judge_conclusion(RICH_CONTEXT))
    assert result["mode"] == "heuristic"
    assert "judge llm down" in result["error"]


def test_judge_session_offline():
    session = sessions.create_session("judge-session")
    result = run(judge.judge_session(session.id, allow_llm=False))
    assert result["sessionId"] == session.id
    assert result["verdict"] in ("pass", "fail")
    assert "score" in result
