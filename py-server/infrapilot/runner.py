"""Agent Runner —— 可恢复的执行循环（对应 `server/src/agent/runner.ts`）。"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Optional

from . import compression, db, knowledge, llm, memory, registry, skill_packages, structured, usage
from .checkpoint import load_checkpoint, save_checkpoint
from .gateway import execute_tool_call
from .args_hash import compute_args_hash
from .hypotheses import build_evidence_chain, link_hypotheses_to_evidence, merge_hypotheses
from .models import (
    AgentCheckpoint,
    AgentSession,
    Evidence,
    ExecutedToolCall,
    PendingToolCall,
    Remediation,
    RootCause,
    ToolDef,
    ToolExecutionResult,
)
from .plan import extract_counter_evidence, extract_hypotheses, extract_plan, extract_rca, extract_remediation
from .tool_summary import summarize_evidence
from .policy import ALL_TOOLS, classify_risk, render_diff_preview
from .prompts import build_skill_context, build_system_prompt
from .sessions import check_cancelled, emit_event, emit_event_live, get_session, update_session
from .util import new_id, now_iso


# 流式思考增量合并参数：距上次广播 >=0.12s 或累计 >=200 字符即发送一次
_DELTA_FLUSH_SECONDS = 0.12
_DELTA_FLUSH_CHARS = 200


# 会话状态 → 对外展示的进展文案（随 `status` 事件广播）
_STATUS_MESSAGES: dict[str, str] = {
    "planning": "正在分析问题并制定诊断计划...",
    "executing": "正在执行诊断步骤...",
    "awaiting_approval": "等待人工审批...",
    "reflecting": "结论置信度不足，正在复核并补充关键证据...",
    "concluded": "已生成根因结论",
    "closed": "会话已结束",
}


def set_session_status(session_id: str, status: str, message: str | None = None) -> None:
    """更新会话状态并广播 `status` 事件（仅在状态真正变化时）。

    前端的执行进度线（第 N/M 步）以收到的会话状态为准；若阶段跃迁不广播事件，
    对话框会一直停留在上一阶段（例如整个证据采集阶段都显示「第 1 步」）。
    """
    session = get_session(session_id)
    if session is None or session.status == status:
        return
    update_session(session_id, lambda s, value=status: setattr(s, "status", value))
    emit_event(
        session_id,
        "status",
        {"status": status, "message": message or _STATUS_MESSAGES.get(status, "")},
    )


class _StreamDeltaCoalescer:
    """把高频流式增量合并为低频广播：距上次广播 >=min_seconds 或累计 >=max_chars 才发送。

    与旧实现的区别：**不丢内容**（旧实现只广播每第 4 个片段，实时文本是残缺的）。
    """

    def __init__(
        self,
        emit: Any,
        *,
        min_seconds: float = _DELTA_FLUSH_SECONDS,
        max_chars: int = _DELTA_FLUSH_CHARS,
        clock: Any = None,
    ) -> None:
        self._emit = emit
        self._min_seconds = min_seconds
        self._max_chars = max_chars
        self._clock = clock or time.monotonic
        self._buffer: list[str] = []
        self._last = self._clock()

    @property
    def pending_chars(self) -> int:
        return sum(len(part) for part in self._buffer)

    def add(self, piece: str) -> None:
        if not piece:
            return
        self._buffer.append(piece)
        if self._clock() - self._last >= self._min_seconds or self.pending_chars >= self._max_chars:
            self.flush()

    def flush(self) -> None:
        if not self._buffer:
            return
        self._emit("".join(self._buffer))
        self._buffer.clear()
        self._last = self._clock()


def _record_usage(
    session_id: str,
    model: str,
    collected: Any,
    started: float,
    call_type: str = "agent",
) -> None:
    """把本次 LLM 调用的 token/延迟落库（P0 用量统计）。"""
    try:
        usage.record_llm_call(
            session_id=session_id,
            model=model,
            prompt_tokens=getattr(collected, "promptTokens", 0) or 0,
            completion_tokens=getattr(collected, "completionTokens", 0) or 0,
            latency_ms=int((time.time() - started) * 1000),
            call_type=call_type,
        )
    except Exception as err:  # noqa: BLE001 - 统计失败不能影响主链路
        print(f"[runner] 记录 LLM 用量失败: {err}")

def to_openai_tools(tools: list[ToolDef]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": f"{t.skill}__{t.name}",
                "description": f"[{t.skill}][risk={t.risk}] {t.description}",
                "parameters": t.parameters,
            },
        }
        for t in tools
    ]


def build_tool_list_markdown(tools: list[ToolDef]) -> str:
    return "\n".join(f"- {t.skill}.{t.name}: {t.description}" for t in tools)


def fetch_similar_cases(query: str) -> str:
    try:
        cases = knowledge.search_knowledge_cases(query, limit=3)
        if not cases:
            return ""
        lines = "\n".join(
            f"- case_id={c['id']} [相似度 {c['score']:.3f}] {c['title']}\n"
            f"  摘要: {c['summary']}\n  根因: {'; '.join(c['rootCauses'])}\n  方案: {'; '.join(c['solutions'])}"
            for c in cases
        )
        return f"\n# 历史相似案例参考\n{lines}\n"
    except Exception:  # noqa: BLE001
        return ""


def parse_fn_name(fn_name: str) -> tuple[str, str]:
    idx = fn_name.find("__")
    return fn_name[:idx], fn_name[idx + 2 :]


def evidence_from_result(skill: str, tool: str, args: dict[str, Any], result_data: Any) -> Evidence:
    return Evidence(
        id=new_id(),
        sourceAgent=f"{skill}-skill",
        sourceSkill=skill,
        type=f"{skill}.{tool}",
        content=result_data,
        confidence=0.7,
        collectedAt=now_iso(),
        summary=summarize_evidence(skill, tool, args, result_data),
    )


# 容忍 markdown 装饰：**置信度**：**0.6** / 置信度 85% / 置信度：0.6
_CONFIDENCE_RE = re.compile(r"置信度[*\s]*[:：]?[*\s]*([0-9]+(?:\.[0-9]+)?)\s*%?")


def extract_confidence(text: str) -> Optional[float]:
    """解析结论正文里的置信度；解析不到返回 None，不用默认值掩盖分歧。"""
    for match in _CONFIDENCE_RE.finditer(text or ""):
        value = float(match.group(1))
        if value <= 1:
            return max(0.0, value)
        if value <= 100:
            return value / 100
        # 明显不是置信度的数字（如年份/时长），继续找下一个
    return None


# 结论自检：置信度不达标时，自动追加一轮「证据缺口」追问，而不是直接把半成品结论收尾。
_EVIDENCE_GAP_MARKER = "【证据缺口自检】"
_DEFAULT_MIN_CONCLUSION_CONFIDENCE = 0.75


def _min_conclusion_confidence() -> float:
    try:
        return float(os.environ.get("INFRAPILOT_MIN_CONCLUSION_CONFIDENCE") or _DEFAULT_MIN_CONCLUSION_CONFIDENCE)
    except ValueError:
        return _DEFAULT_MIN_CONCLUSION_CONFIDENCE


def evidence_gap_probe(session: AgentSession, checkpoint: AgentCheckpoint, max_iterations: int) -> Optional[str]:
    """置信度不足且还有余量时，返回要追加给模型的「补证据」指令；否则 None。

    约束（避免把会话拖进死循环或凭空发散）：
    - 每个会话最多补一次（历史里已出现标记即视为补过）；
    - 至少留 1 次迭代余量，且必须已经采集过证据（否则无据可补）；
    - 结论为空时不触发；置信度 >= 阈值 时不触发；**未给出置信度也算缺口**，要追问一次。
    """
    if os.environ.get("INFRAPILOT_CONFIDENCE_GATE", "1") in ("0", "false", "False", ""):
        return None
    if checkpoint.iteration + 1 >= max_iterations:
        return None
    if any(_EVIDENCE_GAP_MARKER in str(m.get("content") or "") for m in checkpoint.history):
        return None
    root_cause = session.rootCause
    if root_cause is None or not str(root_cause.summary or "").strip():
        return None
    if not session.evidence:
        return None
    threshold = _min_conclusion_confidence()
    confidence = root_cause.confidence
    if confidence is not None and confidence >= threshold:
        return None

    if confidence is None:
        gap_head = f"你的结论里没有给出置信度（要求 >= {threshold:g}）"
    else:
        gap_head = f"你的结论置信度为 {confidence:g}（低于 {threshold:g}）"
    returned = checkpoint.iteration
    tool_names = sorted({f"{c.skill}.{c.tool}" for c in session.executedToolCalls})
    return (
        f"{_EVIDENCE_GAP_MARKER} {gap_head}，说明还有未闭环的证据。请只做一轮收口，不要重复原结论：\n"
        f"1. 先列出当前结论中「仅靠推测、没有证据支撑」的 1-3 个关键环节；\n"
        "2. 针对每个环节立即调用**尚未用过（或参数不同）**的只读工具取证据 "
        "（例如 Deployment 探针定义、Pod lastState/退出码、事件时间线、重启前后的日志片段）；\n"
        f"3. 已调用过的工具（共 {returned} 轮 / {len(tool_names)} 类）："
        f"{', '.join(tool_names) if tool_names else '无'} —— 相同参数不要重跑，除非上一轮返回为空或报错；\n"
        "4. 拿到新证据后重新给出结论：若证据已足以支撑更高置信度，直接给最终结论并说明依据；"
        "若确实拿不到证据，明确写出「证据缺口」及由此带来的不确定性，不要为了凑置信度编造。"
    )


def _flatten(text: str, limit: int) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else f"{flat[: limit - 1]}…"


def _incident_head(session: AgentSession) -> str:
    """案例标题主体：优先会话 subject（如 `ems/ecp-dashboard-api`），否则取问题首行。"""
    subject = (session.subject or "").strip()
    if subject:
        return subject
    for line in (session.incidentSummary or "").splitlines():
        flat = " ".join(line.split())
        if flat:
            return flat
    return ""


async def persist_root_cause_as_case(session_id: str, session: AgentSession, rca_text: str) -> None:
    try:
        if not session.incidentSummary or not session.rootCause:
            return
        # 标题不要直接塞 incidentSummary：点击诊断等场景下它是注入模板（含换行与操作指令），
        # 会把知识库标题截断在半句；摘要也不该存提示词原文，而应存根因结论首段。
        solutions = [step.description for step in (session.remediation.steps if session.remediation else [])]
        case = knowledge.add_knowledge_case(
            {
                "title": f"自动沉淀: {_flatten(_incident_head(session), 60)}",
                "problemType": "auto_persisted",
                "severity": "p2",
                "summary": _flatten(rca_text, 400),
                "rootCauses": [rca_text],
                "solutions": solutions,
                "tags": ["auto_persisted"],
                "sourceSessionId": session_id,
            }
        )
        emit_event(session_id, "knowledge_case_added", {"caseId": case["id"], "title": case["title"]})
    except Exception:  # noqa: BLE001 - 知识库沉淀失败不应阻断主流程
        pass


def build_recovered_context(session: AgentSession) -> str:
    parts: list[str] = []
    if session.incidentSummary:
        parts.append(f"- 原始问题: {session.incidentSummary}")
    if session.plan:
        parts.append(f"- 诊断计划: {' -> '.join(session.plan)}")
    if session.evidence:
        recent = "\n".join(
            f"  - {e.sourceSkill or e.type}: {e.summary}" for e in session.evidence[-5:]
        )
        parts.append(f"- 已收集证据(最近 {min(5, len(session.evidence))} 条):\n{recent}")
    if session.executedToolCalls:
        names: list[str] = []
        for t in session.executedToolCalls:
            n = f"{t.skill}.{t.tool}"
            if n not in names:
                names.append(n)
        parts.append(f"- 已执行工具({len(session.executedToolCalls)} 次): {', '.join(names)}")
    if session.rootCause:
        parts.append(f"- 已有根因结论: {session.rootCause.summary}")
    if session.remediation:
        parts.append(f"- 修复方案: {session.remediation.summary}")
    return "\n".join(parts)


async def build_initial_history(session_id: str, user_message: str) -> list[dict[str, Any]]:
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")

    registry.build_registry(ALL_TOOLS)
    recall_query = "\n".join(x for x in [user_message, session.incidentSummary] if x)
    recalled = registry.recall_tools(recall_query, top_k=16)
    available_tools = [r.tool for r in recalled]

    similar_cases = fetch_similar_cases(recall_query)
    memory_context = memory.build_memory_context(recall_query)
    selected_skills = skill_packages.select_skills_for_turn(recall_query, [])
    skill_context = build_skill_context([skill_packages.to_skill_doc(s) for s in selected_skills])
    update_session(session_id, lambda s: setattr(s, "activeSkills", [p.name for p in selected_skills]))
    emit_event(session_id, "skills_activated", {"skills": [p.name for p in selected_skills], "turn": "initial"})

    recovered_context = build_recovered_context(session)
    system_prompt = (
        build_system_prompt(build_tool_list_markdown(available_tools) + similar_cases + memory_context)
        + (f"\n\n{skill_context}" if skill_context else "")
        + (
            f"\n\n# 会话历史上下文(自动恢复)\n{recovered_context}\n"
            "以上为历史会话已确认的状态与证据，仅作上下文参考，结论仍需结合实时证据交叉验证。"
            if recovered_context
            else ""
        )
    )

    def _mark(s: AgentSession) -> None:
        s.status = "planning"
        if not s.incidentSummary:
            s.incidentSummary = user_message

    update_session(session_id, _mark)
    emit_event(session_id, "status", {"status": "planning", "message": "正在分析问题并制定诊断计划..."})
    return [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]


# 历史里每类工具结果的字符预算：既要模型看得见要点，又不让单条结果挤爆后续每一轮 prompt。
# 实测（会话 235f9099）10 轮 prompt 累计 28.9 万 token，最大单项就是几万字符的工具返回。
_DEFAULT_TOOL_RESULT_CHARS = 2200
_TOOL_RESULT_CHARS: dict[str, int] = {
    # 定义/事件类结果字段多，放宽一些；日志/查询类按行裁剪
    "k8s.get_deployment": 4000,
    "k8s.describe_pod": 3500,
    "k8s.list_pods": 3500,
    "k8s.get_events": 3000,
    "k8s.get_pod_logs": 4000,
    "k8s.list_nodes": 3000,
    "clickhouse.search_logs": 3500,
    "elk.search_logs": 3500,
    "openstack.*": 3000,
}


def _tool_result_budget(skill: str, tool: str) -> int:
    return _TOOL_RESULT_CHARS.get(f"{skill}.{tool}", _TOOL_RESULT_CHARS.get(f"{skill}.*", _DEFAULT_TOOL_RESULT_CHARS))


def _trim_long_values(value: Any, per_value: int, list_cap: int = 20) -> Any:
    """按「长字符串截断 + 长列表截尾」递归瘦身，保持结构合法 JSON，避免硬切造成解析歧义。"""
    if isinstance(value, str):
        if len(value) <= per_value:
            return value
        return f"{value[:per_value]}…(字符串共 {len(value)} 字符，已截断)"
    if isinstance(value, list):
        items = [_trim_long_values(v, per_value, list_cap) for v in value[:list_cap]]
        if len(value) > list_cap:
            items.append(f"…(共 {len(value)} 项，已省略 {len(value) - list_cap} 项)")
        return items
    if isinstance(value, dict):
        return {k: _trim_long_values(v, per_value, list_cap) for k, v in value.items()}
    return value


def _clip_text(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}…(共 {len(text)} 字符)"


def format_tool_result(skill: str, tool: str, result: ToolExecutionResult) -> str:
    """把工具返回写进对话历史；超预算时按结构裁剪并显式标注，避免模型把截断当完整结论。

    裁剪始终保持 payload 是合法 JSON（截断说明写进 `_truncated` 字段），
    这样模型/下游解析都不会因为截断成半截 JSON 而误读。完整结果仍留在会话证据里。
    """
    body = {"success": result.success, "data": result.data, "stdout": result.stdout, "error": result.error}
    budget = _tool_result_budget(skill, tool)
    payload = json.dumps(body, ensure_ascii=False, default=str)
    if len(payload) > budget:
        note = (
            f"本结果超出 {budget} 字符预算，已按结构裁剪（长字符串截断、长列表截尾），只保留要点。"
            "完整返回已存入本会话「证据」面板。若确需被裁掉的细节，请改用更小范围的参数重查"
            "（收窄 namespace/pod/timeRange 或显式加 limit），不要用相同参数重跑，也不要把截断当成完整结论。"
        )
        for per_value in (1500, 600, 240):
            trimmed = _trim_long_values(body, per_value)
            trimmed["_truncated"] = note
            payload = json.dumps(trimmed, ensure_ascii=False, default=str)
            if len(payload) <= budget:
                break
        if len(payload) > budget:
            # 兜底：直接丢弃 data/stdout 正文，只留结论性字段，保证仍是合法 JSON
            payload = json.dumps(
                {
                    "success": body["success"],
                    "data": None,
                    "stdout": None,
                    "error": _clip_text(body["error"], 200),
                    "_truncated": f"{note} 原始返回过大已整体省略。",
                },
                ensure_ascii=False,
                default=str,
            )
    return f'<tool_result source="{skill}.{tool}" trust_level="untrusted_data">\n{payload}\n</tool_result>'


async def _invoke_tool(session_id: str, pending: PendingToolCall) -> ToolExecutionResult:
    """只负责调用（含审批校验），不写会话状态 —— 便于只读调用并发执行。"""
    approved_by: Optional[str] = None
    if pending.risk.requiresApproval:
        if not pending.approvalId:
            raise RuntimeError("pending high-risk tool call missing approvalId")
        approval = db.get_approval(pending.approvalId)
        if approval is None or approval["decision"] != "approved":
            raise RuntimeError(f"approval {pending.approvalId} not approved")
        approved_by = approval.get("decided_by")

    return await execute_tool_call(pending, session_id, f"{pending.skill}-skill", approved_by)


def _record_tool_result(session_id: str, pending: PendingToolCall, result: ToolExecutionResult) -> None:
    """落库 + 广播 + 证据沉淀。并发批次按原顺序调用本函数，保证证据序号确定。"""
    def _record(s: AgentSession) -> None:
        s.pendingToolCalls = [p for p in s.pendingToolCalls if p.id != pending.id]
        s.executedToolCalls.append(
            ExecutedToolCall(
                **pending.model_dump(),
                result=result,
                startedAt=now_iso(),
                finishedAt=now_iso(),
            )
        )

    update_session(session_id, _record)
    emit_event(
        session_id,
        "tool_call_result",
        {
            "toolCallId": pending.id,
            "skill": pending.skill,
            "tool": pending.tool,
            "args": pending.args,
            "result": result.model_dump(),
        },
    )

    if result.success and pending.risk.level == "readonly":
        evidence = evidence_from_result(
            pending.skill, pending.tool, pending.args, result.data if result.data is not None else result.stdout
        )
        update_session(session_id, lambda s: s.evidence.append(evidence))
        emit_event(session_id, "evidence_added", evidence.model_dump())


async def execute_single_tool_call(
    session_id: str, session: AgentSession, pending: PendingToolCall
) -> tuple[ToolExecutionResult, Optional[str]]:
    result = await _invoke_tool(session_id, pending)
    _record_tool_result(session_id, pending, result)
    return result, None


async def process_assistant_content(session_id: str, session: AgentSession, content: str) -> None:
    emit_event(session_id, "assistant_message", {"content": content})

    plan = extract_plan(content)
    if plan:
        update_session(session_id, lambda s: setattr(s, "plan", plan))
        emit_event(session_id, "plan_update", {"plan": plan})

    hypotheses = extract_hypotheses(content)
    if hypotheses:
        def _apply_hypotheses(s: AgentSession) -> None:
            s.hypotheses = link_hypotheses_to_evidence(merge_hypotheses(s.hypotheses or [], hypotheses), s.evidence)

        update_session(session_id, _apply_hypotheses)
        updated = get_session(session_id)
        emit_event(session_id, "hypothesis_update", {"hypotheses": [h.model_dump() for h in (updated.hypotheses if updated else [])]})

    remediation = extract_remediation(content)
    if remediation:
        remediation_model = Remediation.model_validate(remediation)
        update_session(session_id, lambda s: setattr(s, "remediation", remediation_model))
        emit_event(session_id, "remediation_plan", {"summary": remediation["summary"], "steps": remediation["steps"]})

    rca_text = extract_rca(content)
    if rca_text:
        # 先广播阶段跃迁（此时状态尚未写为 concluded，才有事件可发）
        set_session_status(session_id, "concluded")

        def _apply_rca(s: AgentSession) -> None:
            s.status = "concluded"
            s.rootCause = RootCause(
                summary=rca_text,
                confidence=extract_confidence(rca_text),
                evidenceChain=build_evidence_chain(s.hypotheses or [], s.evidence, rca_text),
                alternativeHypotheses=extract_counter_evidence(content),
            )

        update_session(session_id, _apply_rca)
        emit_event(session_id, "rca_conclusion", {"content": rca_text})
        await persist_root_cause_as_case(session_id, session, rca_text)


async def apply_structured_rca(session_id: str, session: AgentSession, rca: dict[str, Any]) -> None:
    """把 JSON Schema 约束后的结论写入会话（P2 结构化输出）。"""
    summary = str(rca.get("summary") or "")
    remediation_text = str(rca.get("remediation") or "").strip()

    try:
        confidence = float(rca["confidence"]) if rca.get("confidence") is not None else None
    except (TypeError, ValueError):
        confidence = None

    def _apply(s: AgentSession) -> None:
        s.status = "concluded"
        s.rootCause = RootCause(
            summary=summary,
            confidence=confidence,
            evidenceChain=build_evidence_chain(s.hypotheses or [], s.evidence, summary),
            alternativeHypotheses=[str(x) for x in (rca.get("alternative_hypotheses") or [])],
        )
        if remediation_text:
            s.remediation = Remediation(summary=remediation_text, steps=[])

    set_session_status(session_id, "concluded")
    update_session(session_id, _apply)
    emit_event(session_id, "rca_conclusion", {"content": summary, "structured": True})
    if remediation_text:
        emit_event(session_id, "remediation_plan", {"summary": remediation_text, "steps": []})
    await persist_root_cause_as_case(session_id, session, summary)


async def _conclude_from_existing_evidence(
    session_id: str, session: AgentSession, checkpoint: AgentCheckpoint
) -> None:
    try:
        _model = llm.reasoning_model()
        _t0 = time.time()
        # P2 结构化输出：请求 JSON Schema 约束的结论；不支持该参数的网关会自动回退到正则解析
        structured_rca = os.environ.get("INFRAPILOT_STRUCTURED_RCA", "1") not in ("0", "false", "False", "")
        extra: dict[str, Any] = (
            {"response_format": structured.build_response_format("root_cause", structured.RCA_SCHEMA)}
            if structured_rca
            else {}
        )
        completion = await llm.get_client().chat.completions.create(
            model=_model,
            messages=[
                *checkpoint.history,
                {
                    "role": "user",
                    "content": "已达最大迭代次数。请基于以上全部证据直接输出最终结论；"
                    "若要求 JSON 则输出 {summary, confidence, evidence_points, alternative_hypotheses, remediation}，"
                    "否则以【根因分析结论】开头，包含根因摘要、置信度(0-1)、支撑证据要点和修复建议；禁止调用任何工具。",
                },
            ],
            tools=[],
            tool_choice="none",
            **extra,
        )
        _usage = getattr(completion, "usage", None)
        _record_usage(
            session_id,
            _model,
            type(
                "_U",
                (),
                {
                    "promptTokens": int(getattr(_usage, "prompt_tokens", 0) or 0) if _usage else 0,
                    "completionTokens": int(getattr(_usage, "completion_tokens", 0) or 0) if _usage else 0,
                },
            )(),
            _t0,
            "conclusion",
        )
        choices = getattr(completion, "choices", None) or []
        content = getattr(choices[0].message, "content", None) if choices else None
        if content:
            checkpoint.history.append({"role": "assistant", "content": content})
            parsed_rca = structured.parse_conclusion(content) if structured_rca else None
            if parsed_rca:
                emit_event(session_id, "assistant_message", {"content": content})
                await apply_structured_rca(session_id, session, parsed_rca)
            else:
                await process_assistant_content(session_id, session, content)
    except Exception as err:  # noqa: BLE001
        print(f"[runner] 最终结论生成失败: {err}")


async def recall_available_tools(checkpoint: AgentCheckpoint) -> list[ToolDef]:
    registry.build_registry(ALL_TOOLS)
    last = next(
        (m for m in reversed(checkpoint.history) if m.get("role") in ("user", "assistant")), None
    )
    query = last.get("content") if last and isinstance(last.get("content"), str) else ""
    return [r.tool for r in registry.recall_tools(query or "", top_k=16)]


async def run_agent_step(
    session_id: str, existing_checkpoint: Optional[AgentCheckpoint] = None
) -> tuple[AgentCheckpoint, bool]:
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")

    checkpoint = existing_checkpoint or load_checkpoint(session_id)
    if checkpoint is None:
        raise ValueError(f"no checkpoint for session {session_id}")

    if checkpoint.pendingToolCall:
        check_cancelled(session_id)
        pending = checkpoint.pendingToolCall
        result, _ = await execute_single_tool_call(session_id, session, pending)
        checkpoint.history.append(
            {
                "role": "tool",
                "tool_call_id": pending.id,
                "content": format_tool_result(pending.skill, pending.tool, result),
            }
        )
        checkpoint.pendingToolCall = None
        checkpoint.status = "executing"
        set_session_status(session_id, "executing")
        save_checkpoint(checkpoint)
        emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})

    max_iterations = session.maxIterations or 20

    while checkpoint.iteration < max_iterations:
        check_cancelled(session_id)
        checkpoint.iteration += 1
        update_session(session_id, lambda s: setattr(s, "iteration", checkpoint.iteration))

        # P2 上下文压缩：超预算时把较早历史压成一条 system 摘要，保留 system prompt + 最近消息
        if await compression.maybe_compress(session_id, checkpoint):
            save_checkpoint(checkpoint)
            emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})

        available_tools = await recall_available_tools(checkpoint)
        _model = llm.reasoning_model()
        _t0 = time.time()
        completion = await llm.get_client().chat.completions.create(
            model=_model,
            messages=checkpoint.history,
            tools=to_openai_tools(available_tools),
            tool_choice="auto",
            parallel_tool_calls=True,
            stream=True,
            stream_options={"include_usage": True},
        )

        # 流式增量按「时间窗口 + 字节上限」合并后广播，既不丢内容也不刷爆事件总线
        delta = _StreamDeltaCoalescer(
            lambda text: emit_event_live(session_id, "assistant_delta", {"content": text})
        )
        collected = await llm.collect_streamed_completion(completion, delta.add)
        delta.flush()
        _record_usage(session_id, _model, collected, _t0, "agent")
        message: dict[str, Any] = {"role": "assistant", "content": collected.content or None}
        if collected.toolCalls:
            message["tool_calls"] = collected.toolCalls
        checkpoint.history.append(message)

        if collected.content:
            await process_assistant_content(session_id, session, collected.content)

        if not collected.toolCalls:
            current = get_session(session_id) or session
            probe = evidence_gap_probe(current, checkpoint, max_iterations)
            if probe:
                set_session_status(session_id, "reflecting")
                emit_event(session_id, "evidence_gap_probe", {"iteration": checkpoint.iteration, "message": probe})
                checkpoint.history.append({"role": "user", "content": probe})
                save_checkpoint(checkpoint)
                emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})
                continue

            def _close(s: AgentSession) -> None:
                if s.status != "concluded":
                    s.status = "closed"

            update_session(session_id, _close)
            emit_event(session_id, "done", {})
            save_checkpoint(checkpoint)
            _store_memory(session_id)
            return checkpoint, True

        set_session_status(session_id, "executing")

        # 同一轮里的只读调用彼此无依赖：先入队、循环结束后并发执行，再按原顺序落库。
        # 顺序固定很关键 —— 证据序号（证据#N）依赖它保持稳定。
        batch: list[tuple[PendingToolCall, str]] = []

        async def flush_readonly_batch() -> None:
            if not batch:
                return
            items, batch[:] = list(batch), []
            outcomes = await asyncio.gather(
                *(_invoke_tool(session_id, pending) for pending, _ in items), return_exceptions=True
            )
            for (pending, call_id), outcome in zip(items, outcomes):
                result = (
                    outcome
                    if isinstance(outcome, ToolExecutionResult)
                    else ToolExecutionResult(success=False, error=f"工具执行异常: {outcome}", durationMs=0)
                )
                _record_tool_result(session_id, pending, result)
                checkpoint.history.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": format_tool_result(pending.skill, pending.tool, result),
                    }
                )
                save_checkpoint(checkpoint)
                emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})

        for tc in collected.toolCalls:
            check_cancelled(session_id)
            if tc.get("type") != "function":
                continue
            skill, tool = parse_fn_name(tc["function"]["name"])
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except ValueError:
                args = {}

            risk = classify_risk(skill, tool, args)
            pending = PendingToolCall(
                id=tc["id"],
                skill=skill,
                tool=tool,
                args=args,
                risk=risk,
                diffPreview=render_diff_preview(skill, tool, args) if risk.requiresApproval else None,
            )

            update_session(session_id, lambda s, p=pending: s.pendingToolCalls.append(p))
            emit_event(
                session_id,
                "tool_call_start",
                {"toolCallId": tc["id"], "skill": skill, "tool": tool, "args": args, "risk": risk.model_dump()},
            )

            if risk.requiresApproval:
                # 审批类调用会中断本轮：先把已排队的只读批次执行并落库，保证历史顺序
                await flush_readonly_batch()
                # 会话级白名单：仅 medium 风险、且用户已在本会话显式放行时才自动批准；
                # 仍走完整审批记录 + argsHash 校验路径，审计可追溯（approvedBy=session-allowlist）。
                allowlisted = risk.level == "medium" and db.is_allowlisted(session_id, skill, tool)
                approval_id = new_id()
                args_hash = compute_args_hash(skill, tool, args)
                pending.approvalId = approval_id
                pending.argsHash = args_hash
                db.insert_approval(
                    {
                        "id": approval_id,
                        "sessionId": session_id,
                        "skill": skill,
                        "tool": tool,
                        "args": json.dumps(args, ensure_ascii=False),
                        "argsHash": args_hash,
                        "riskLevel": risk.level,
                        "diffPreview": pending.diffPreview or "",
                    }
                )
                if allowlisted:
                    db.decide_approval(approval_id, "approved", "session-allowlist")
                    emit_event(
                        session_id,
                        "approval_decision",
                        {
                            "approvalId": approval_id,
                            "toolCallId": tc["id"],
                            "decision": "approved",
                            "approvedBy": "session-allowlist",
                            "skill": skill,
                            "tool": tool,
                            "auto": True,
                        },
                    )
                else:
                    set_session_status(session_id, "awaiting_approval")
                    emit_event(
                        session_id,
                        "approval_request",
                        {
                            "approvalId": approval_id,
                            "toolCallId": tc["id"],
                            "skill": skill,
                            "tool": tool,
                            "args": args,
                            "risk": risk.model_dump(),
                            "diffPreview": pending.diffPreview,
                        },
                    )
                    checkpoint.status = "awaiting_approval"
                    checkpoint.pendingToolCall = pending
                    save_checkpoint(checkpoint)
                    emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})
                    return checkpoint, False

            else:
                batch.append((pending, tc["id"]))
                continue

            result, _ = await execute_single_tool_call(session_id, session, pending)
            checkpoint.history.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": format_tool_result(pending.skill, pending.tool, result),
                }
            )
            save_checkpoint(checkpoint)
            emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})

        # 本轮只读批次必须在本轮结束前落地：否则下一轮推理看不到工具结果
        await flush_readonly_batch()

    await _conclude_from_existing_evidence(session_id, session, checkpoint)
    emit_event(
        session_id,
        "status",
        {"status": "max_iterations_reached", "message": "已达最大迭代次数,已基于现有证据生成阶段性结论"},
    )
    emit_event(session_id, "done", {})
    save_checkpoint(checkpoint)
    _store_memory(session_id)
    return checkpoint, True


def _store_memory(session_id: str) -> None:
    """会话记忆沉淀失败不得阻断主流程（对齐 Node 的 .catch(()=>{}) 语义）。"""
    try:
        memory.extract_and_store_session_memory(session_id)
    except Exception as err:  # noqa: BLE001
        print(f"[runner] 会话记忆沉淀失败: {err}")


async def create_initial_checkpoint(session_id: str, user_message: str) -> AgentCheckpoint:
    history = await build_initial_history(session_id, user_message)
    checkpoint = AgentCheckpoint(
        sessionId=session_id, history=history, iteration=0, status="planning", createdAt=now_iso()
    )
    save_checkpoint(checkpoint)
    emit_event(session_id, "checkpoint_saved", {"checkpoint": checkpoint.model_dump()})
    return checkpoint


def mark_approval_decided(approval_id: str, approved: bool, approved_by: str) -> None:
    db.decide_approval(approval_id, "approved" if approved else "rejected", approved_by)
