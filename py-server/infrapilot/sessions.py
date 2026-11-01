"""Session Store — 会话状态管理 + 时间线事件广播。

对应 `server/src/agent/sessionStore.ts`。
"""

from __future__ import annotations

import asyncio
from typing import Callable, Optional

from . import db
from .bus import bus
from .models import AgentSession, TimelineEvent
from .util import new_id, now_iso

_sessions: dict[str, AgentSession] = {}


_session_user_ids: dict[str, str] = {}

# 仍在执行中的会话状态（用于判断「停止」是否有实际作用）
RUNNING_STATUSES = frozenset(
    {"intake", "planning", "executing", "awaiting_approval", "reflecting", "remediating"}
)


class SessionCancelled(Exception):
    """会话执行被中断（用户点击「停止」或 A2A `tasks/cancel`）。"""


# session_id -> 正在执行的 asyncio 任务集合；把中断信号即时送进 LLM 流式请求等 await 点。
# 用集合而非单值：同一会话可能有并发轮次（用户在任务执行中输入引导语）。
_active_turns: dict[str, set[asyncio.Task]] = {}
# session_id -> 本轮已请求中断（协作式检查用；用户主动发起新任务时清除）
_cancel_requested: set[str] = set()


def begin_turn(session_id: str) -> None:
    """登记当前 asyncio 任务为本会话的活动轮次。"""
    task = asyncio.current_task()
    if task is not None:
        _active_turns.setdefault(session_id, set()).add(task)


def end_turn(session_id: str) -> None:
    """轮次结束（含被中断）时注销任务，并清掉本轮的中断标记。

    清除是安全的：中断后的会话状态已是 `closed`，`resume_agent_turn` 与审批恢复
    都会被状态校验拦住；用户再次发消息时会重新开始一轮。
    """
    task = asyncio.current_task()
    tasks = _active_turns.get(session_id)
    if tasks is not None:
        if task is not None:
            tasks.discard(task)
        if not tasks:
            _active_turns.pop(session_id, None)
    _cancel_requested.discard(session_id)


def clear_cancel(session_id: str) -> None:
    """用户主动发起新任务：清除上一轮遗留的中断标记。"""
    _cancel_requested.discard(session_id)


def is_turn_active(session_id: str) -> bool:
    return any(not t.done() for t in _active_turns.get(session_id, ()))


def is_cancel_requested(session_id: str) -> bool:
    return session_id in _cancel_requested


def request_cancel(session_id: str) -> bool:
    """请求中断会话执行：置位协作标记，并立即取消进行中的 asyncio 任务。

    返回 True 表示当时确有正在运行的轮次被 `task.cancel()` 打断；
    False 表示没有活动轮次（例如停在等待审批，此时只需收尾状态）。
    即使没有活动轮次也会置位标记，覆盖「任务已创建但尚未登记」的极窄窗口。
    """
    _cancel_requested.add(session_id)
    tasks = [t for t in _active_turns.get(session_id, ()) if not t.done()]
    for task in tasks:
        task.cancel()
    return bool(tasks)


def check_cancelled(session_id: str) -> None:
    """在 Agent 循环的关键节点调用；命中中断标记则抛出 `SessionCancelled`。"""
    if session_id in _cancel_requested:
        raise SessionCancelled(f"session {session_id} canceled")


DEFAULT_SESSION_TITLE = "新的故障排查会话"
# 视为「尚未命名」的占位标题：收到首个用户问题时会被真实问题替换
_PLACEHOLDER_TITLES = {DEFAULT_SESSION_TITLE, "新的诊断会话", ""}

# 侧边栏/顶栏标题长度上限（超出截断加省略号）
_TITLE_LIMIT = 36


def derive_session_title(message: str, limit: int = _TITLE_LIMIT) -> str:
    """从用户首条消息推导会话标题（对齐 A2A 用消息命名会话的做法）。

    只取第一行、压缩空白，超长截断；空消息回落到占位标题。
    """
    text = " ".join((message or "").split()).strip()
    if not text:
        return DEFAULT_SESSION_TITLE
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def maybe_auto_title(session_id: str, message: str) -> Optional[AgentSession]:
    """会话仍是占位标题时，用首条用户消息命名（用户已手动改名则不覆盖）。"""
    session = get_session(session_id)
    if session is None:
        return None
    if (session.title or "").strip() not in _PLACEHOLDER_TITLES:
        return None
    return update_session_title(session_id, derive_session_title(message))


def create_session(
    title: str, user_id: Optional[str] = None, subject: Optional[str] = None
) -> AgentSession:
    now = now_iso()
    session = AgentSession(
        id=new_id(), title=title, status="intake", createdAt=now, updatedAt=now, subject=subject
    )
    _sessions[session.id] = session
    if user_id:
        _session_user_ids[session.id] = user_id
    _persist(session)
    emit_event(session.id, "session_created", {"title": title})
    return session


def get_session(session_id: str) -> Optional[AgentSession]:
    if session_id in _sessions:
        return _sessions[session_id]
    row = db.get_session_row(session_id)
    if not row:
        return None
    session = AgentSession.model_validate_json(row["state_json"])
    _sessions[session_id] = session
    return session


def list_session_summaries() -> list[dict]:
    return db.list_sessions()


def update_session(session_id: str, mutator: Callable[[AgentSession], None]) -> AgentSession:
    session = get_session(session_id)
    if session is None:
        raise ValueError(f"session {session_id} not found")
    mutator(session)
    session.updatedAt = now_iso()
    _persist(session)
    return session


def terminate_session(session_id: str) -> Optional[AgentSession]:
    session = get_session(session_id)
    if session is None:
        return None
    session.status = "closed"
    session.updatedAt = now_iso()
    _persist(session)
    return session


def delete_session(session_id: str) -> bool:
    removed = db.delete_session(session_id)
    if removed:
        _sessions.pop(session_id, None)
    return removed


def update_session_title(session_id: str, title: str) -> Optional[AgentSession]:
    session = get_session(session_id)
    if session is None:
        return None
    session.title = title or session.title
    session.updatedAt = now_iso()
    _persist(session)
    return session


def _persist(session: AgentSession) -> None:
    db.upsert_session(
        session.id,
        session.title,
        session.status,
        session.model_dump_json(),
        _session_user_ids.get(session.id),
    )


def emit_event(session_id: str, event_type: str, payload: object) -> TimelineEvent:
    event = TimelineEvent(id=new_id(), sessionId=session_id, type=event_type, timestamp=now_iso(), payload=payload)
    try:
        db.insert_timeline_event(
            {
                "id": event.id,
                "session_id": session_id,
                "type": event_type,
                "payload": _payload_json(payload),
                "timestamp": event.timestamp,
            }
        )
    except Exception as err:  # noqa: BLE001 - 事件持久化失败不应阻断实时推送
        print(f"[emit_event] failed to persist timeline event: {err}")
    bus.publish(event.model_dump())
    return event


def emit_event_live(session_id: str, event_type: str, payload: object) -> TimelineEvent:
    """只广播不落库：用于 assistant_delta 这类高频流式事件。"""
    event = TimelineEvent(id=new_id(), sessionId=session_id, type=event_type, timestamp=now_iso(), payload=payload)
    bus.publish(event.model_dump())
    return event


def _payload_json(payload: object) -> str:
    import json

    if hasattr(payload, "model_dump"):
        return json.dumps(payload.model_dump(), ensure_ascii=False)  # type: ignore[union-attr]
    return json.dumps(payload, ensure_ascii=False, default=str)
