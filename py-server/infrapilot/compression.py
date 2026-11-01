"""上下文超长自动压缩（P2）—— 对应差距分析 §3 #13。

Node 版由 memoryStore 部分覆盖（只有跨会话摘要）；Python 版补充**会话内历史压缩**：
当 checkpoint.history 估算 token 超过阈值时，把「较早的消息」交给 LLM 结构化摘要成一条
system 消息，仅保留 system prompt + 最近 N 条消息，从而在长链路调查中不撞上下文上限。

两级降级（保证永远能前进）：
1. LLM 结构化摘要（``COMPRESSION_SCHEMA``）；
2. 失败时用确定性摘要（角色 + 内容截断），只是丢掉细节，绝不阻塞执行。
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Optional

from . import sessions, structured

# 实测长链路会话（10 轮）单轮 prompt 已涨到 4.9 万 token，而 6 万阈值在到达前就已因上下文膨胀
# 明显变慢（单轮 LLM 等待 28s）。提前在 ~2.8 万 token 触发压缩，用一次摘要调用换后续每轮更小的 prompt。
DEFAULT_MAX_TOKENS = 28_000
DEFAULT_KEEP_RECENT = 8
_MAX_SUMMARY_INPUT_CHARS = 24_000


def enabled() -> bool:
    return os.environ.get("INFRAPILOT_CONTEXT_COMPRESS", "1") not in ("0", "false", "False", "")


def max_tokens() -> int:
    try:
        return max(2000, int(os.environ.get("INFRAPILOT_CONTEXT_MAX_TOKENS") or DEFAULT_MAX_TOKENS))
    except ValueError:
        return DEFAULT_MAX_TOKENS


def estimate_tokens(text: str) -> int:
    """粗略 token 估算：中文按 ~1.5 字/token，其它按 ~4 字符/token。"""
    if not text:
        return 0
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = len(text) - cjk
    return int(math.ceil(cjk / 1.5 + other / 4))


def _message_tokens(message: dict[str, Any]) -> int:
    content = message.get("content")
    if isinstance(content, list):
        content = json.dumps(content, ensure_ascii=False)
    tokens = estimate_tokens(str(content or ""))
    for call in message.get("tool_calls") or []:
        tokens += estimate_tokens(json.dumps(call, ensure_ascii=False))
    return tokens + 8  # 每条消息的结构开销


def history_tokens(history: list[dict[str, Any]]) -> int:
    return sum(_message_tokens(m) for m in history or [])


def _split_index(rest: list[dict[str, Any]], keep_recent: int) -> int:
    index = max(0, len(rest) - keep_recent)
    # 不能让最近窗口以孤立 tool 结果开头（必须带上前面的 assistant tool_calls 消息）
    while index > 0 and rest[index].get("role") == "tool":
        index -= 1
    return index


def _render_for_summary(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if isinstance(content, list):
            content = json.dumps(content, ensure_ascii=False)
        text = str(content or "")
        if m.get("tool_calls"):
            text += " [tool_calls] " + json.dumps(m["tool_calls"], ensure_ascii=False)
        lines.append(f"### {role}\n{text[:2000]}")
    blob = "\n\n".join(lines)
    return blob[:_MAX_SUMMARY_INPUT_CHARS]


def deterministic_summary(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """无需 LLM 的兜底摘要：保留角色序列与每条消息的短摘要。"""
    facts: list[str] = []
    for m in messages:
        role = m.get("role")
        content = str(m.get("content") or "")
        if m.get("tool_calls"):
            names = [c.get("function", {}).get("name") for c in m["tool_calls"]]
            facts.append(f"[{role}] 调用工具: {', '.join(n for n in names if n)}")
        if content.strip():
            facts.append(f"[{role}] {content.strip()[:200]}")
    return {"summary": f"（离线压缩）共 {len(messages)} 条历史消息的要点如下。", "key_facts": facts[-40:]}


_SUMMARY_SYSTEM = """你是 SRE 会话上下文压缩器。把给定的诊断历史压缩为 JSON：
- summary: 保留故障现象、关键证据、已排除的假设、当前进展与待办（中文，300 字内）；
- key_facts: 关键事实列表（工具结论、观测数值、结论片段）；
- open_questions: 尚未解决的问题。
必须保留对后续判断重要的具体数值/名称；不要编造。"""


async def _summarize(messages: list[dict[str, Any]], session_id: str) -> tuple[dict[str, Any], str]:
    try:
        result = await structured.structured_completion(
            name="context_compression",
            schema=structured.COMPRESSION_SCHEMA,
            system=_SUMMARY_SYSTEM,
            user=_render_for_summary(messages),
            session_id=session_id,
            call_type="compression",
        )
        return result, "llm"
    except Exception as err:  # noqa: BLE001 - 摘要失败必须仍能压缩
        print(f"[compression] LLM 摘要失败，改用确定性摘要: {err}")
        return deterministic_summary(messages), "deterministic"


async def maybe_compress(
    session_id: str,
    checkpoint: Any,
    *,
    max_tokens_override: Optional[int] = None,
    keep_recent: int = DEFAULT_KEEP_RECENT,
) -> Optional[dict[str, Any]]:
    """按需压缩 checkpoint.history；返回压缩元信息（未压缩则 None）。"""
    if not enabled():
        return None
    history: list[dict[str, Any]] = list(getattr(checkpoint, "history", []) or [])
    budget = max_tokens_override or max_tokens()
    before = history_tokens(history)
    if before <= budget:
        return None

    head = [m for m in history if m.get("role") == "system"][:1]
    rest = history[len(head):]
    split = _split_index(rest, keep_recent)
    older, recent = rest[:split], rest[split:]
    if not older:
        return None

    summary, mode = await _summarize(older, session_id)
    facts = summary.get("key_facts") or []
    questions = summary.get("open_questions") or []
    lines = ["# 上下文压缩摘要（较早历史已被压缩，最新证据请以最近消息为准）", str(summary.get("summary") or "")]
    if facts:
        lines.append("## 关键事实")
        lines.extend(f"- {f}" for f in facts)
    if questions:
        lines.append("## 待解决问题")
        lines.extend(f"- {q}" for q in questions)
    compressed_message = {"role": "system", "content": "\n".join(lines)}

    checkpoint.history = [*head, compressed_message, *recent]
    after = history_tokens(checkpoint.history)
    info = {
        "beforeTokens": before,
        "afterTokens": after,
        "removedMessages": len(older),
        "keptMessages": len(recent),
        "mode": mode,
        "summary": str(summary.get("summary") or ""),
    }
    sessions.emit_event(session_id, "context_compressed", info)
    return info
