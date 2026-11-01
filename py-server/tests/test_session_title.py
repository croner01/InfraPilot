"""会话命名：新建会话用首个问题命名，而不是一律叫「新的故障排查会话」。"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from infrapilot import sessions
from infrapilot.main import app
from infrapilot.routes import api as api_routes


def test_derive_session_title_collapses_and_truncates():
    assert sessions.derive_session_title("  order-api   频繁重启  ") == "order-api 频繁重启"
    assert sessions.derive_session_title("第一行\n第二行") == "第一行 第二行"
    long_msg = "order-api 从 15 点开始一直重启，Pod 状态 CrashLoopBackOff，帮我看看根因"
    title = sessions.derive_session_title(long_msg)
    assert len(title) <= 36
    assert title.endswith("…")
    assert title.startswith("order-api 从 15 点开始一直重启")


def test_derive_session_title_falls_back_to_placeholder():
    assert sessions.derive_session_title("") == sessions.DEFAULT_SESSION_TITLE
    assert sessions.derive_session_title("   \n  ") == sessions.DEFAULT_SESSION_TITLE


def test_maybe_auto_title_only_replaces_placeholder():
    session = sessions.create_session(sessions.DEFAULT_SESSION_TITLE)
    updated = sessions.maybe_auto_title(session.id, "节点磁盘水位 92% 处理")
    assert updated is not None and updated.title == "节点磁盘水位 92% 处理"
    # 已按问题命名过 -> 第二条消息不再改名
    again = sessions.maybe_auto_title(session.id, "换一个问题")
    assert again is None
    assert sessions.get_session(session.id).title == "节点磁盘水位 92% 处理"


def test_user_renamed_session_is_not_overwritten():
    session = sessions.create_session("我手动起的名字")
    assert sessions.maybe_auto_title(session.id, "随便什么问题") is None
    assert sessions.get_session(session.id).title == "我手动起的名字"


def test_post_message_names_session_from_first_question(monkeypatch):
    async def fake_turn(session_id: str, message: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(api_routes, "start_agent_turn", fake_turn)

    with TestClient(app) as client:
        created = client.post("/api/sessions", json={}).json()
        assert created["title"] == sessions.DEFAULT_SESSION_TITLE

        res = client.post(
            f"/api/sessions/{created['id']}/messages",
            json={"message": "ELK 索引写入延迟上升，帮我看下"},
        )
        assert res.json()["accepted"] is True

        refreshed = client.get(f"/api/sessions/{created['id']}").json()
        assert refreshed["title"] == "ELK 索引写入延迟上升，帮我看下"

    # 后台轮次任务不阻塞断言
    asyncio.run(asyncio.sleep(0))


def test_alert_sourced_title_is_kept(monkeypatch):
    async def fake_turn(session_id: str, message: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(api_routes, "start_agent_turn", fake_turn)

    with TestClient(app) as client:
        created = client.post("/api/sessions", json={"title": "诊断: order-api OOMKilled"}).json()
        client.post(f"/api/sessions/{created['id']}/messages", json={"message": "继续排查"})
        refreshed = client.get(f"/api/sessions/{created['id']}").json()
        assert refreshed["title"] == "诊断: order-api OOMKilled"
