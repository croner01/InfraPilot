"""P0（用量统计 / 认证）与 P1（告警接入 / Skill Factory）测试。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from infrapilot import auth, db, llm, sessions, usage
from infrapilot.main import app
from infrapilot.orchestrator import start_agent_turn


class _FakeStream:
    """模拟开启 include_usage 的流式响应。"""

    def __init__(self, text: str, prompt: int, completion: int):
        self._chunks = []
        for piece in text:
            delta = SimpleNamespace(content=piece, tool_calls=None)
            self._chunks.append(SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=None))
        self._chunks.append(SimpleNamespace(choices=[], usage=SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion)))

    def __aiter__(self):
        self._iter = iter(self._chunks)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _FakeCompletions:
    def __init__(self, chunks):
        self._chunks = chunks

    async def create(self, **kwargs):
        return self._chunks.pop(0)


class _FakeClient:
    def __init__(self, chunks):
        self.chat = SimpleNamespace(completions=_FakeCompletions(chunks))


def test_runner_records_llm_usage(monkeypatch):
    stream = _FakeStream("【根因分析结论】\n内存不足，置信度 0.9", prompt=120, completion=30)
    monkeypatch.setattr(llm, "get_client", lambda: _FakeClient([stream]))

    session = sessions.create_session("用量统计测试")
    asyncio.run(start_agent_turn(session.id, "看看内存"))

    calls = db.list_llm_calls(session_id=session.id)
    assert len(calls) == 1
    assert calls[0]["prompt_tokens"] == 120
    assert calls[0]["completion_tokens"] == 30
    assert calls[0]["total_tokens"] == 150
    assert calls[0]["cost"] > 0

    summary = usage.summarize(days=14)
    assert summary["totals"]["total"] >= 150
    assert any(s["date"] for s in summary["series"])
    assert any(m["model"] for m in summary["models"])
    assert summary["prices"]


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_auth_login_me_and_rbac(client):
    ok = client.post("/api/auth/login", json={"username": "oncall-zhang", "password": "oncall123"})
    assert ok.status_code == 200
    body = ok.json()
    assert body["user"]["role"] == "on-call"
    assert body["token"]

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.json()["user"]["username"] == "oncall-zhang"

    # 非 admin 访问用户管理 → 403
    assert client.get("/api/auth/users", headers={"Authorization": f"Bearer {body['token']}"}).status_code == 403

    admin = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()
    users = client.get("/api/auth/users", headers={"Authorization": f"Bearer {admin['token']}"})
    assert {u["username"] for u in users.json()["users"]} >= {"admin", "oncall-zhang", "viewer"}

    assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401


def test_auth_middleware_optional_by_default(client, monkeypatch):
    assert client.get("/api/sessions").status_code == 200
    monkeypatch.setenv("INFRAPILOT_REQUIRE_AUTH", "1")
    assert client.get("/api/sessions").status_code == 401
    assert client.get("/api/sessions").json() == {"error": "未认证"}
    monkeypatch.delenv("INFRAPILOT_REQUIRE_AUTH")


def test_alert_patch_and_webhook_ingest(client):
    payload = {
        "alerts": [
            {
                "status": "firing",
                "labels": {"alertname": "OrderApiOOM", "severity": "critical", "service": "order-api", "namespace": "order-service"},
                "annotations": {"summary": "order-api 内存超限", "runbook_url": "http://x"},
                "startsAt": "2026-09-29T10:00:00Z",
                "fingerprint": "fp-oom-1",
            }
        ]
    }
    res = client.post("/api/webhooks/alertmanager", json=payload).json()
    assert res["ok"] is True and len(res["created"]) == 1
    alert = res["created"][0]
    assert alert["severity"] == "p0"
    assert alert["source_type"] == "alertmanager"
    assert alert["labels"] == {"alertname": "OrderApiOOM", "severity": "critical", "service": "order-api", "namespace": "order-service"}
    assert res["sessions"] and res["sessions"][0]["sessionId"]

    # 同一 fingerprint 再次触发 → 去重合并 count
    again = client.post("/api/webhooks/alertmanager", json=payload).json()
    assert again["created"] == [] and len(again["updated"]) == 1
    assert again["updated"][0]["count"] == 2

    patched = client.patch(f"/api/alerts/{alert['id']}", json={"status": "resolved"}).json()
    assert patched["alert"]["status"] == "resolved"
    assert patched["alert"]["resolvedAt"]

    listed = client.get("/api/alerts").json()["alerts"]
    row = next(a for a in listed if a["id"] == alert["id"])
    assert row["sourceType"] == "alertmanager"
    assert row["fingerprint"] == "fp-oom-1"


def test_skill_factory_generate_and_approve(client, monkeypatch):
    # 构造一个已得出结论的会话
    session = sessions.create_session("order-api 内存泄漏排查")
    from infrapilot.models import Evidence, RootCause

    def _mutate(s):
        s.status = "concluded"
        s.rootCause = RootCause(summary="JVM 堆外内存增长导致 OOMKilled", confidence=0.9, evidenceIds=[])
        s.evidence.append(Evidence(id="e1", sessionId=s.id, sourceAgent="a", sourceSkill="k8s", type="k8s.get_pod_logs", summary="OOMKilled 事件", raw={}, confidence=0.9, collectedAt="2026-09-29T00:00:00.000Z", createdAt="2026-09-29T00:00:00.000Z"))

    sessions.update_session(session.id, _mutate)

    cands = client.get("/api/skills/factory/sessions").json()["sessions"]
    assert any(c["id"] == session.id for c in cands)

    draft = client.post("/api/skills/factory/generate", json={"sessionId": session.id}).json()
    assert draft["ok"] is True
    assert draft["content"].startswith("---")
    assert "OOMKilled" in draft["content"]

    approve = client.post("/api/skills/factory/approve", json={"name": draft["name"], "content": draft["content"]})
    assert approve.status_code == 200, approve.text
    skills_now = {s["name"] for s in client.get("/api/skills").json()["skills"]}
    assert draft["name"] in skills_now

    # 清理：移除刚生成的技能包，避免污染共享 skills 目录
    client.delete(f"/api/skills/{draft['name']}")
