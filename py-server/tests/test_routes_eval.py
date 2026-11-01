"""P2 评测路由契约（需线程/本地 socket，放开沙箱执行）。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from infrapilot import db, sessions
from infrapilot.main import app
from infrapilot.models import RootCause


def test_eval_routes_cases_judge_promote_runs():
    with TestClient(app) as client:
        cases = client.get("/api/eval/cases").json()
        assert any(c["case"]["id"] == "kafka-evicted-oom" for c in cases["cases"])

        assert client.post("/api/eval/cases", json={"id": "route-case"}).status_code == 400
        created = client.post(
            "/api/eval/cases",
            json={"id": "route-case", "message": "m", "checks": [{"type": "rootCauseMatches", "regex": "x"}]},
        ).json()
        assert created["case"]["case"]["id"] == "route-case"
        assert client.delete("/api/eval/cases/route-case").json() == {"ok": True}
        assert client.delete("/api/eval/cases/route-case").status_code == 404

        # judge（离线启发式，不调 LLM）
        session = sessions.create_session("route-judge")
        judged = client.post("/api/eval/judge", json={"sessionId": session.id, "allowLlm": False}).json()
        assert judged["ok"] is True and judged["sessionId"] == session.id
        assert judged["mode"] == "heuristic"
        assert client.post("/api/eval/judge", json={}).status_code == 400

        # 线上回流
        sessions.update_session(session.id, lambda s: setattr(s, "rootCause", RootCause(summary="根因A", confidence=0.7)))
        sessions.update_session(session.id, lambda s: setattr(s, "incidentSummary", "订单服务异常"))
        promoted = client.post("/api/eval/promote", json={"sessionId": session.id, "id": "route-online"}).json()
        assert promoted["ok"] is True
        assert promoted["case"]["origin"] == "online"
        assert any(c["type"] == "judgeScore" for c in promoted["case"]["case"]["checks"])

        runs = client.get("/api/eval/runs?caseId=route-online").json()
        assert "runs" in runs
        db.delete_eval_case("route-online")
