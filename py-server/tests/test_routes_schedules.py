"""P2 定时任务路由契约（需线程/本地 socket，放开沙箱执行）。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from infrapilot import scheduler
from infrapilot.main import app


def test_schedules_crud_and_validate(monkeypatch):
    async def _noop(session_id: str, prompt: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(scheduler, "_run_diagnosis", _noop)
    with TestClient(app) as client:
        assert client.post("/api/schedules/validate", json={"cron": "nope"}).status_code == 400
        assert client.post("/api/schedules/validate", json={"cron": "@every 5m"}).json()["nextRun"]

        assert client.post("/api/schedules", json={"cron": "*/5 * * * *"}).status_code == 400
        created = client.post("/api/schedules", json={"name": "jc", "cron": "@every 5m", "prompt": "巡检"}).json()
        assert created["ok"] is True
        sid = created["schedule"]["id"]
        assert created["schedule"]["nextRunAt"]

        assert any(s["id"] == sid for s in client.get("/api/schedules").json()["schedules"])
        assert client.get("/api/schedules/status").json()["count"] >= 1

        updated = client.put(f"/api/schedules/{sid}", json={"enabled": False, "name": "jc2"}).json()
        assert updated["schedule"]["enabled"] is False

        run = client.post(f"/api/schedules/{sid}/run").json()
        assert run["ok"] is True and run["sessionId"]

        assert client.delete(f"/api/schedules/{sid}").json() == {"ok": True}
        assert client.delete(f"/api/schedules/{sid}").status_code == 404
