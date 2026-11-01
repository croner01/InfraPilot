"""P3 会话产物路由契约（需线程/本地 socket，放开沙箱执行）。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from infrapilot import artifacts
from infrapilot.main import app


def test_artifact_routes_roundtrip():
    artifacts.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    path = artifacts.ARTIFACTS_DIR / "route-artifact.txt"
    path.write_text("route-artifact-body", encoding="utf-8")

    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={"title": "artifact-route"}).json()["id"]

        assert client.post("/api/artifacts", json={}).status_code == 400
        assert client.post("/api/artifacts", json={"path": "/etc/passwd"}).status_code == 400

        created = client.post("/api/artifacts", json={"sessionId": session_id, "path": str(path), "kind": "test"}).json()
        assert created["ok"] is True
        artifact_id = created["artifact"]["id"]

        listed = client.get(f"/api/sessions/{session_id}/artifacts").json()
        assert any(a["id"] == artifact_id for a in listed["artifacts"])
        assert any(a["id"] == artifact_id for a in client.get("/api/artifacts").json()["artifacts"])
        assert any(a["id"] == artifact_id for a in client.get(f"/api/artifacts?sessionId={session_id}").json()["artifacts"])

        download = client.get(f"/api/artifacts/{artifact_id}/download")
        assert download.status_code == 200
        assert download.text == "route-artifact-body"
        assert "route-artifact.txt" in download.headers["content-disposition"]

        assert client.get("/api/artifacts/missing/download").status_code == 404
        assert client.delete(f"/api/artifacts/{artifact_id}").json() == {"ok": True}
        assert client.delete(f"/api/artifacts/{artifact_id}").status_code == 404
