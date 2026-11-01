"""P3 A2A 协议：Agent Card / JSON-RPC / Task 状态映射 / 产物透出。"""

from __future__ import annotations

import asyncio

from infrapilot import a2a, artifacts, db, sessions


def run(coro):
    return asyncio.run(coro)


def test_agent_card_shape():
    card = a2a.agent_card("http://localhost:8787")
    assert card["protocolVersion"] == a2a.A2A_PROTOCOL_VERSION
    assert card["url"] == "http://localhost:8787/api/a2a"
    assert card["capabilities"]["streaming"] is True
    assert {s["id"] for s in card["skills"]} >= {"diagnose", "remediate", "topology", "evaluate"}


def test_extract_text_parts():
    assert a2a._text_of({"parts": [{"kind": "text", "text": "a"}, {"kind": "text", "text": "b"}]}) == "a\nb"
    assert a2a._text_of({"parts": [{"kind": "file", "file": {}}]}) == ""
    assert a2a._text_of({}) == ""


def test_state_mapping_and_error_paths():
    assert a2a._STATE_MAP["awaiting_approval"] == "input-required"
    assert a2a._STATE_MAP["concluded"] == "completed"

    def call(payload):
        return run(a2a.handle_request(payload))

    assert call({"jsonrpc": "2.0", "id": 1, "method": "ping"})["result"] == {}
    assert call({"jsonrpc": "2.0", "id": 2, "method": "nope"})["error"]["code"] == -32601
    assert call({"jsonrpc": "2.0", "method": "ping"}) is None
    missing = call({"jsonrpc": "2.0", "id": 3, "method": "tasks/get", "params": {"id": "nope"}})
    assert missing["error"]["code"] == -32001
    empty = call({"jsonrpc": "2.0", "id": 4, "method": "message/send", "params": {"message": {"parts": []}}})
    assert empty["error"]["code"] == -32001


def test_message_send_get_cancel_and_artifacts(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def fake_turn(session_id: str, text: str) -> None:
        calls.append((session_id, text))

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)

    async def scenario() -> None:
        sent = await a2a.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "message/send",
                "params": {"message": {"role": "user", "messageId": "m1", "parts": [{"kind": "text", "text": "kafka 起不来"}]}},
            }
        )
        task = sent["result"]
        assert task["kind"] == "task"
        assert task["status"]["state"] in ("submitted", "working")
        assert task["metadata"]["title"] == "kafka 起不来"
        await asyncio.sleep(0.05)

        # 产物透出为 A2A file part
        artifacts.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        path = artifacts.ARTIFACTS_DIR / "a2a.diagram.drawio"
        path.write_text("<mxfile/>", encoding="utf-8")
        artifacts.register(str(path), session_id=task["id"], kind="drawio")

        got = await a2a.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tasks/get", "params": {"id": task["id"]}})
        one = got["result"]
        assert one["artifacts"][0]["parts"][0]["kind"] == "file"
        assert one["artifacts"][0]["parts"][0]["file"]["uri"].startswith("/api/artifacts/")

        canceled = await a2a.handle_request({"jsonrpc": "2.0", "id": 3, "method": "tasks/cancel", "params": {"id": task["id"]}})
        assert canceled["result"]["status"]["state"] == "canceled"
        assert sessions.get_session(task["id"]).status == "closed"

    run(scenario())
    assert calls and calls[0][1] == "kafka 起不来"


def test_completed_task_carries_root_cause(monkeypatch):
    from infrapilot.models import RootCause

    async def fake_turn(session_id: str, text: str) -> None:
        sessions.update_session(session_id, lambda s: setattr(s, "rootCause", RootCause(summary="磁盘写满", confidence=0.8)))
        sessions.update_session(session_id, lambda s: setattr(s, "status", "concluded"))

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)
    result = run(
        a2a.handle_request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "message/send",
                "params": {"message": {"parts": [{"kind": "text", "text": "磁盘问题"}]}, "configuration": {"blocking": True}},
            }
        )
    )
    task = result["result"]
    assert task["status"]["state"] == "completed"
    assert task["status"]["message"]["parts"][0]["text"] == "磁盘写满"
    assert task["history"][-1]["role"] == "agent"


def _text_updates(events):
    return [
        e["status"]["message"]["parts"][0]["text"]
        for e in events
        if e.get("kind") == "status-update" and e.get("status", {}).get("message")
    ]


def test_stream_message_status_and_final(monkeypatch):
    from infrapilot.models import RootCause

    async def fake_turn(session_id: str, text: str) -> None:
        sessions.update_session(session_id, lambda s: setattr(s, "status", "executing"))
        sessions.emit_event(session_id, "status", {"status": "executing", "message": "正在执行诊断"})
        sessions.emit_event(session_id, "assistant_message", {"content": "收集到证据"})
        artifacts.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        path = artifacts.ARTIFACTS_DIR / "stream.diagram.drawio"
        path.write_text("<mxfile/>", encoding="utf-8")
        artifacts.register(str(path), session_id=session_id, kind="drawio")
        sessions.update_session(
            session_id,
            lambda s: setattr(s, "rootCause", RootCause(summary="磁盘写满", confidence=0.9)),
        )
        sessions.update_session(session_id, lambda s: setattr(s, "status", "concluded"))
        sessions.emit_event(session_id, "rca_conclusion", {"content": "磁盘写满"})
        sessions.emit_event(session_id, "done", {})

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)

    async def scenario():
        agen = await a2a.stream_message({"message": {"parts": [{"kind": "text", "text": "磁盘问题"}]}})
        return [event async for event in agen]

    events = run(scenario())
    assert events[0]["kind"] == "task"
    assert events[0]["id"] == events[-1]["id"]

    final = events[-1]
    assert final["kind"] == "status-update"
    assert final["final"] is True
    assert final["status"]["state"] == "completed"
    assert final["status"]["message"]["parts"][0]["text"] == "磁盘写满"

    texts = _text_updates(events)
    assert "正在执行诊断" in texts
    assert "收集到证据" in texts
    assert "磁盘写满" in texts

    artifact_events = [e for e in events if e.get("kind") == "artifact-update"]
    assert artifact_events and artifact_events[0]["artifact"]["parts"][0]["kind"] == "file"


def test_stream_message_input_required_without_done(monkeypatch):
    async def fake_turn(session_id: str, text: str) -> None:
        sessions.update_session(session_id, lambda s: setattr(s, "status", "awaiting_approval"))
        sessions.emit_event(session_id, "approval_request", {"approvalId": "a1"})

    monkeypatch.setattr(a2a, "_run_turn", fake_turn)

    async def scenario():
        agen = await a2a.stream_message({"message": {"parts": [{"kind": "text", "text": "重启服务"}]}})
        return [event async for event in agen]

    events = run(scenario())
    final = events[-1]
    assert final["final"] is True
    assert final["status"]["state"] == "input-required"


def test_stream_message_rejects_empty(monkeypatch):
    monkeypatch.setattr(a2a, "_run_turn", lambda *a, **k: None)

    async def scenario():
        await a2a.stream_message({"message": {"parts": []}})

    import pytest

    with pytest.raises(ValueError):
        run(scenario())


def test_resubscribe_replays_history_and_finalizes():
    session = sessions.create_session("历史会话")
    sessions.update_session(session.id, lambda s: setattr(s, "status", "executing"))
    sessions.emit_event(session.id, "status", {"status": "executing", "message": "执行中"})
    sessions.update_session(session.id, lambda s: setattr(s, "status", "concluded"))
    sessions.emit_event(session.id, "rca_conclusion", {"content": "根因A"})
    sessions.emit_event(session.id, "done", {})

    async def scenario():
        agen = await a2a.resubscribe_task({"id": session.id})
        return [event async for event in agen]

    events = run(scenario())
    # 无首帧 Task 快照；直接回放状态更新
    assert events[0]["kind"] == "status-update"
    assert events[-1]["final"] is True
    assert events[-1]["status"]["state"] == "completed"
    texts = _text_updates(events)
    assert "执行中" in texts and "根因A" in texts
    # 回放帧携带 SSE 续传游标（时间线事件 id）
    assert any(getattr(e, "event_id", None) for e in events)


def test_resubscribe_cursor_skips_delivered():
    session = sessions.create_session("游标会话")
    sessions.emit_event(session.id, "assistant_message", {"content": "第一条"})
    sessions.emit_event(session.id, "assistant_message", {"content": "第二条"})

    async def collect(cursor=None):
        agen = await a2a.resubscribe_task({"id": session.id}, last_event_id=cursor)
        return [event async for event in agen]

    full = run(collect())
    cursor = next((getattr(e, "event_id", None) for e in full if _text_updates([e]) == ["第一条"]), None)
    assert cursor
    assert "第一条" in _text_updates(full)

    rest = run(collect(cursor))
    texts = _text_updates(rest)
    assert "第一条" not in texts
    assert "第二条" in texts


def test_resubscribe_streams_live_events(monkeypatch):
    gate = asyncio.Event()

    async def slow_turn(session_id: str, text: str) -> None:
        sessions.emit_event(session_id, "assistant_message", {"content": "实时一"})
        await gate.wait()
        sessions.update_session(session_id, lambda s: setattr(s, "status", "concluded"))
        sessions.emit_event(session_id, "rca_conclusion", {"content": "实时二"})
        sessions.emit_event(session_id, "done", {})

    monkeypatch.setattr(a2a, "_run_turn", slow_turn)

    async def scenario():
        stream = await a2a.stream_message({"message": {"parts": [{"kind": "text", "text": "并发任务"}]}})
        first = await stream.__anext__()
        assert first["kind"] == "task"
        task_id = first["id"]

        sub = await a2a.resubscribe_task({"id": task_id})
        collected: list[dict] = []

        async def consume() -> None:
            async for event in sub:
                collected.append(event)

        consumer = asyncio.ensure_future(consume())
        await asyncio.sleep(0.05)
        gate.set()
        rest = [event async for event in stream]
        await asyncio.wait_for(consumer, timeout=5)
        return collected, rest

    collected, rest = run(scenario())
    assert collected[-1]["final"] is True
    # 实时续订接到轮次结束后的事件
    assert "实时二" in _text_updates(collected)
    # 原流也正常收尾
    assert rest[-1]["final"] is True


def test_resubscribe_unknown_task(monkeypatch):
    async def scenario():
        await a2a.resubscribe_task({"id": "does-not-exist"})

    import pytest

    with pytest.raises(ValueError):
        run(scenario())
