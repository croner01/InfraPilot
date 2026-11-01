"""Agent Orchestrator —— 核心推理循环入口（对应 `server/src/agent/orchestrator.ts`）。"""

from __future__ import annotations

import asyncio

from .checkpoint import load_checkpoint, save_checkpoint
from .prompts import build_skill_context
from .runner import create_initial_checkpoint, run_agent_step
from .sessions import (
    SessionCancelled,
    begin_turn,
    check_cancelled,
    clear_cancel,
    emit_event,
    end_turn,
    get_session,
    update_session,
)
from .skill_packages import select_skills_for_turn, to_skill_doc


def _finalize_cancel(session_id: str, message: str) -> None:
    """中断收尾：状态置为已关闭并补一条 `done`，让前端停止「思考中」并刷新会话。"""
    update_session(session_id, lambda s: setattr(s, "status", "closed"))
    emit_event(session_id, "status", {"status": "canceled", "message": message})
    emit_event(session_id, "done", {})


async def _run_turn(session_id: str, checkpoint) -> None:
    """统一的轮次执行包装：登记活动任务，任何中断/异常都保证状态收敛。"""
    begin_turn(session_id)
    try:
        # 覆盖「任务已创建但尚未登记为活动轮次」的时间窗：此时的中断请求也能生效
        check_cancelled(session_id)
        await run_agent_step(session_id, checkpoint)
    except SessionCancelled:
        _finalize_cancel(session_id, "任务已被用户中断")
    except asyncio.CancelledError:
        # task.cancel() 直接打在 LLM 流式/工具等待上；这里吞掉并收尾，避免会话卡在「执行中」
        _finalize_cancel(session_id, "任务已被用户中断")
    except Exception as err:  # noqa: BLE001 - 致命错误需收尾会话，避免永久卡在执行中
        update_session(session_id, lambda s: setattr(s, "status", "closed"))
        emit_event(session_id, "error", {"message": str(err)})
        emit_event(session_id, "done", {})
        raise
    finally:
        end_turn(session_id)


async def start_agent_turn(session_id: str, user_message: str) -> None:
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")

    # 用户主动发起的新任务：清除上一轮遗留的中断标记
    clear_cancel(session_id)

    checkpoint = load_checkpoint(session_id)
    if checkpoint is not None:
        selected = select_skills_for_turn(user_message, session.activeSkills or [])
        skill_context = build_skill_context([to_skill_doc(p) for p in selected])
        if skill_context:
            checkpoint.history.append(
                {
                    "role": "system",
                    "content": f"# 本轮技能更新（替代之前的技能选择；会话历史保持完整）\n\n{skill_context}",
                }
            )
        update_session(session_id, lambda s: setattr(s, "activeSkills", [p.name for p in selected]))
        emit_event(
            session_id,
            "skills_activated",
            {"skills": [p.name for p in selected], "previous": session.activeSkills or []},
        )
        checkpoint.history.append({"role": "user", "content": user_message})
        checkpoint.iteration = 0
        checkpoint.status = "planning"
        save_checkpoint(checkpoint)

        def _planning(s) -> None:
            s.status = "planning"
            s.iteration = 0
            if not s.incidentSummary:
                s.incidentSummary = user_message

        update_session(session_id, _planning)
    else:
        checkpoint = await create_initial_checkpoint(session_id, user_message)

    await _run_turn(session_id, checkpoint)


async def resume_agent_turn(session_id: str, approval_id: str | None = None) -> None:
    session = get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    checkpoint = load_checkpoint(session_id)
    if checkpoint is None:
        return
    await _run_turn(session_id, checkpoint)


async def run_agent_turn(session_id: str, user_message: str) -> None:
    """向后兼容别名。"""
    return await start_agent_turn(session_id, user_message)
