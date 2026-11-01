"""多 Agent / 子 Agent 任务分解（P2）。

对应差距分析 §3 #10「多 Agent 协作 / 子 Agent 任务分解」（设计文档 §15 已规划，Node 版未实现）。

机制：主 Agent 通过 `subagent__task` 工具派发一个**独立会话**去完成子任务。子会话拥有自己的
时间线、checkpoint 与审批上下文；主 Agent 只拿到结构化结论（rootCause / remediation / 证据数），
从而把长链路调查隔离出去，避免污染主会话上下文。

安全：子 Agent 的写操作同样走 Command Gateway 与审批；一旦需要审批即暂停并如实上报。
递归深度上限（默认 2）防止无限自我派发。
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
from typing import Any, Optional

from . import sessions

_MAX_DEPTH = 2

_depth: ContextVar[int] = ContextVar("subagent_depth", default=0)

_SUBAGENT_PROMPT = """你是主 Agent 派发的**子 Agent**，需要独立完成下面这个子任务并给出简洁、可执行的结论。
要求：
1. 只聚焦子任务本身，不要与用户交互、不要输出无关内容；
2. 优先使用只读工具快速取证；确实需要变更类操作时，明确说明"需要审批"，不要尝试绕过审批；
3. 结尾用一段话给出：结论 / 置信度 / 关键证据 / 建议动作。

子任务：
{task}
"""


def current_depth() -> int:
    return _depth.get()


async def run_subagent(
    task: str,
    *,
    title: Optional[str] = None,
    skills: Optional[list[str]] = None,
    max_iterations: int = 8,
    user_id: Optional[str] = None,
) -> dict[str, Any]:
    """启动一个隔离子会话执行子任务，返回结构化结果。"""
    depth = _depth.get()
    if depth >= _MAX_DEPTH:
        return {"ok": False, "error": f"子 Agent 递归深度已达上限({_MAX_DEPTH})，拒绝继续派发"}

    from .orchestrator import start_agent_turn

    session = sessions.create_session(title or f"[subagent] {task[:60]}", user_id)
    session.maxIterations = max(1, int(max_iterations))
    if skills:
        session.activeSkills = list(skills)

    prompt = _SUBAGENT_PROMPT.format(task=task)
    sessions.emit_event(session.id, "user_message", {"message": prompt, "role": "user", "source": "subagent"})

    token = _depth.set(depth + 1)
    try:
        await start_agent_turn(session.id, prompt)
    except Exception as err:  # noqa: BLE001 - 子任务失败要如实回报给主 Agent
        return {"ok": False, "sessionId": session.id, "error": str(err)}
    finally:
        _depth.reset(token)

    final = sessions.get_session(session.id)
    if final is None:
        return {"ok": False, "sessionId": session.id, "error": "子会话丢失"}

    root_cause = final.rootCause
    remediation = final.remediation
    return {
        "ok": final.status == "concluded",
        "sessionId": session.id,
        "status": final.status,
        "iteration": final.iteration,
        "conclusion": (root_cause.summary if root_cause else None) or final.incidentSummary,
        "confidence": root_cause.confidence if root_cause else None,
        "remediation": remediation.summary if remediation else None,
        "evidenceCount": len(final.evidence),
        "awaitingApproval": final.status == "awaiting_approval",
        "note": "子会话已暂停等待审批，需人工在主会话/审批页处理后其结论才会完整。"
        if final.status == "awaiting_approval"
        else None,
    }


async def _noop() -> None:  # pragma: no cover - 供测试替换的占位
    await asyncio.sleep(0)
