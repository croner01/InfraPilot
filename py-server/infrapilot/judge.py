"""LLM-as-judge 评测（P2）—— 对应差距分析 §3 #14。

Node 版只有确定性 check（evaluate.ts：hasTool / rootCauseMatches / hypothesisStatus），
没有语义评判；Python 版补充：
- `judge_session()`：用 JSON Schema 约束的 LLM 评判某次诊断的结论质量（可信度/证据支撑/
  可执行性/幻觉风险），输出 score/verdict/rationale；
- `heuristic_judge()`：完全离线的确定性兜底评分（无 LLM 时仍可用，也是单测基线）；
- 结论可只依赖启发式，也可与金标准（线上回流 case）对比。
"""

from __future__ import annotations

import re
from typing import Any, Optional

from . import sessions, structured

PASS_THRESHOLD = 0.6

JUDGE_RUBRIC = """请以资深 SRE 评审员的身份评判这次故障诊断，围绕四个维度：
1. 证据支撑（evidence）：结论是否被工具证据链支撑，是否存在无依据断言；
2. 根因准确（accuracy）：是否指向真正根因（若给出金标准则与之对比）；
3. 可执行性（actionability）：修复建议是否具体、可落地、风险可控；
4. 幻觉风险（hallucination）：是否编造了历史/指标/事件。
综合给出 0~1 的 score，>=0.6 记为 pass，并给出简短 rationale 与强弱项。"""

_STOPWORDS = {"the", "and", "for", "with", "that", "this", "from", "原因", "问题", "分析", "可能", "服务"}
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{2,}|[\u4e00-\u9fff]{2,}")


def _keywords(text: str) -> set[str]:
    return {t.lower() for t in _TOKEN_RE.findall(text or "") if t.lower() not in _STOPWORDS}


def collect_context(
    session: Any,
    *,
    expected: Optional[str] = None,
    events: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """把会话整理成评测上下文（供 judge 与确定性 check 共用）。"""
    tools: dict[str, dict[str, str]] = {}
    for call in getattr(session, "executedToolCalls", None) or []:
        skill, tool = getattr(call, "skill", None), getattr(call, "tool", None)
        if skill and tool:
            tools[f"{skill}.{tool}"] = {"skill": skill, "tool": tool}
    for event in events or []:
        if event.get("type") == "tool_call_start":
            payload = event.get("payload") or {}
            if payload.get("skill") and payload.get("tool"):
                tools[f"{payload['skill']}.{payload['tool']}"] = {"skill": payload["skill"], "tool": payload["tool"]}
    evidence = []
    for item in getattr(session, "evidence", None) or []:
        summary = getattr(item, "summary", None) or (item.get("summary") if isinstance(item, dict) else None)
        if summary:
            evidence.append(str(summary))
    return {
        "message": (getattr(session, "incidentSummary", None) or "").strip(),
        "rootCause": (session.rootCause.summary if getattr(session, "rootCause", None) else "") or "",
        "confidence": (session.rootCause.confidence if getattr(session, "rootCause", None) else 0.0) or 0.0,
        "toolsUsed": list(tools.values()),
        "evidence": evidence,
        "hypotheses": [h.model_dump() for h in (getattr(session, "hypotheses", None) or [])],
        "expected": expected or None,
    }


def heuristic_judge(context: dict[str, Any]) -> dict[str, Any]:
    """确定性兜底评分（离线可用，也是单测基线）。"""
    root_cause = str(context.get("rootCause") or "")
    evidence = list(context.get("evidence") or [])
    tools = list(context.get("toolsUsed") or [])
    expected = str(context.get("expected") or "")

    score = 0.0
    strengths: list[str] = []
    weaknesses: list[str] = []
    if root_cause.strip():
        score += 0.3
        strengths.append("给出了明确的根因摘要")
    else:
        weaknesses.append("没有根因结论")
    if evidence:
        score += min(0.25, 0.05 * len(evidence))
        strengths.append(f"包含 {len(evidence)} 条证据摘要")
    else:
        weaknesses.append("证据链为空")
    if len(tools) >= 2:
        score += min(0.2, 0.05 * len(tools))
        strengths.append(f"调用了 {len(tools)} 类工具交叉验证")
    elif tools:
        score += 0.05
        weaknesses.append("仅调用单一工具，交叉验证不足")
    else:
        weaknesses.append("未调用任何诊断工具")
    confidence = float(context.get("confidence") or 0)
    if 0.4 <= confidence <= 0.95:
        score += 0.1
    elif confidence > 0.95:
        weaknesses.append("置信度接近 1，可能过度自信")
    if expected:
        overlap = _keywords(root_cause) & _keywords(expected)
        ratio = len(overlap) / max(1, len(_keywords(expected)))
        score += round(min(0.25, ratio * 0.25), 4)
        if ratio >= 0.5:
            strengths.append("与金标准结论方向一致")
        else:
            weaknesses.append("与金标准结论关键词重合度低")
    score = round(max(0.0, min(1.0, score)), 4)
    return {
        "score": score,
        "verdict": "pass" if score >= PASS_THRESHOLD else "fail",
        "rationale": "（启发式评分，未调用 LLM）" + ("；".join(strengths[:3]) or "无可评内容"),
        "strengths": strengths,
        "weaknesses": weaknesses,
        "hallucination_risk": 0.0 if evidence else 0.5,
        "mode": "heuristic",
    }


def _render(context: dict[str, Any]) -> str:
    lines = [f"用户问题: {context.get('message') or '-'}", f"根因结论: {context.get('rootCause') or '-'}"]
    lines.append(f"自评置信度: {context.get('confidence')}")
    lines.append("调用工具: " + (", ".join(f"{t['skill']}.{t['tool']}" for t in context.get("toolsUsed") or []) or "无"))
    lines.append("证据摘要:")
    lines.extend(f"- {e}" for e in (context.get("evidence") or [])[:30] or ["(无)"])
    hypotheses = context.get("hypotheses") or []
    if hypotheses:
        lines.append("假设状态:")
        lines.extend(f"- [{h.get('status')}] {h.get('statement')}" for h in hypotheses[:20])
    if context.get("expected"):
        lines.append(f"金标准结论（参考答案）: {context['expected']}")
    return "\n".join(lines)


async def judge_conclusion(context: dict[str, Any], *, session_id: Optional[str] = None) -> dict[str, Any]:
    """LLM 评判；失败时回退到启发式评分。"""
    try:
        result = await structured.structured_completion(
            name="agent_judge",
            schema=structured.JUDGE_SCHEMA,
            system=JUDGE_RUBRIC,
            user=_render(context),
            session_id=session_id,
            call_type="judge",
        )
    except Exception as err:  # noqa: BLE001 - 评判失败不应中断评测
        fallback = heuristic_judge(context)
        fallback["error"] = str(err)
        return fallback
    score = round(max(0.0, min(1.0, float(result.get("score") or 0))), 4)
    result["score"] = score
    result["verdict"] = "pass" if score >= PASS_THRESHOLD else "fail"
    result["mode"] = "llm"
    return result


async def judge_session(
    session_id: str,
    *,
    expected: Optional[str] = None,
    allow_llm: bool = True,
) -> dict[str, Any]:
    """评判一个已结束/进行中的会话；返回 score/verdict/rationale 与上下文快照。"""
    session = sessions.get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    events = None
    try:
        from . import db

        events = db.list_timeline_events(session_id)
    except Exception:  # noqa: BLE001
        events = None
    context = collect_context(session, expected=expected, events=events)
    verdict = await judge_conclusion(context, session_id=session_id) if allow_llm else heuristic_judge(context)
    return {"sessionId": session_id, "status": session.status, **verdict}
