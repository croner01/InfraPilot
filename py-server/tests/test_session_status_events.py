"""阶段跃迁必须广播 `status` 事件。

前端的执行进度线（第 N/M 步）以收到的会话状态为准；后端若只改库不发事件
（历史上 executing / awaiting_approval 就是这样），对话框会一直停在上一阶段。
"""

from __future__ import annotations

from infrapilot import db, sessions
from infrapilot.runner import set_session_status


def _status_events(session_id: str) -> list[dict]:
    return [e for e in db.list_timeline_events(session_id) if e["type"] == "status"]


def test_emits_status_event_on_transition():
    session = sessions.create_session("进度事件")
    assert _status_events(session.id) == []

    set_session_status(session.id, "executing")

    events = _status_events(session.id)
    assert len(events) == 1
    payload = db.parse_json(events[0]["payload"], {})
    assert payload["status"] == "executing"
    assert payload["message"] == "正在执行诊断步骤..."
    assert sessions.get_session(session.id).status == "executing"


def test_dedupes_repeated_status():
    session = sessions.create_session("进度事件去重")
    set_session_status(session.id, "executing")
    set_session_status(session.id, "executing")
    assert len(_status_events(session.id)) == 1


def test_transitions_are_emitted_in_order():
    session = sessions.create_session("进度事件顺序")
    for status in ("planning", "executing", "awaiting_approval", "executing", "concluded"):
        set_session_status(session.id, status)
    payloads = [db.parse_json(e["payload"], {}) for e in _status_events(session.id)]
    assert [p["status"] for p in payloads] == [
        "planning",
        "executing",
        "awaiting_approval",
        "executing",
        "concluded",
    ]
    assert all(p["message"] for p in payloads)


def test_unknown_session_is_ignored():
    set_session_status("missing-session", "executing")
