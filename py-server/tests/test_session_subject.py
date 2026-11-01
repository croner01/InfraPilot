"""会话「对象」（subject）：建会话时记录被诊断对象，右栏跟踪面板的「对象」行使用。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from infrapilot import sessions
from infrapilot.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_subject_is_returned_on_create(client):
    created = client.post(
        "/api/sessions", json={"title": "诊断: order-api", "subject": "order-service/order-api"}
    ).json()
    assert created["subject"] == "order-service/order-api"


def test_subject_defaults_to_none(client):
    created = client.post("/api/sessions", json={"title": "新会话"}).json()
    assert created["subject"] is None


def test_subject_survives_reload_from_db(client):
    created = client.post(
        "/api/sessions", json={"title": "诊断: node-08", "subject": "Node node-08"}
    ).json()
    # 模拟进程重启：清掉内存缓存后必须仍能从 SQLite 读回
    sessions._sessions.clear()
    reloaded = client.get(f"/api/sessions/{created['id']}").json()
    assert reloaded["subject"] == "Node node-08"
