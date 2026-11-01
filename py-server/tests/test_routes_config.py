"""Phase 4/5 路由契约测试：/api/config/*、/api/data-sources/*、/api/skills/*。"""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from infrapilot.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_error_body_uses_error_key(client):
    res = client.get("/api/sessions/does-not-exist")
    assert res.status_code == 404
    assert res.json() == {"error": "not found"}


def test_memory_roundtrip(client):
    assert client.get("/api/config/memory").json() == {"enabled": True, "recallTopK": 3}
    res = client.put("/api/config/memory", json={"enabled": False, "recallTopK": 5})
    assert res.json() == {"ok": True, "enabled": False, "recallTopK": 5}
    client.put("/api/config/memory", json={"enabled": True, "recallTopK": 3})


def test_mcp_config_and_secret(client):
    assert client.get("/api/config/mcp").json()["serverPort"] == 8443
    assert client.put("/api/config/mcp", json={"serverPort": 9443, "jwtSecret": "abc"}).json() == {"ok": True}
    assert client.get("/api/config/mcp").json()["serverPort"] == 9443
    assert client.post("/api/config/mcp/generate-secret").json()["secret"]


def test_metric_system_crud_and_validation(client):
    assert client.get("/api/config/metric-systems").json() == {"systems": []}
    assert client.post("/api/config/metric-systems", json={"id": "p1"}).status_code == 400
    res = client.post("/api/config/metric-systems", json={"id": "p1", "name": "Prom", "url": "http://127.0.0.1:9090"})
    assert res.json()["ok"] is True
    assert res.json()["systems"][0]["type"] == "prometheus"
    assert client.get("/api/data-sources/prom").json()["systems"][0]["id"] == "p1"
    assert client.delete("/api/config/metric-systems/p1").json()["systems"] == []


def test_host_crud_validation_and_error_envelope(client):
    assert client.get("/api/config/hosts").json() == {"hosts": []}
    assert client.post("/api/config/hosts", json={"name": "n1"}).status_code == 400
    assert client.post("/api/config/hosts", json={"name": "n1", "auth": {"type": "password"}}).status_code == 400
    res = client.post(
        "/api/config/hosts",
        json={"name": "node-1", "hostname": "10.0.0.1", "username": "root", "auth": {"type": "password"}},
    )
    assert res.json()["hosts"][0]["port"] == 22
    assert client.delete("/api/config/hosts/missing").status_code == 404
    assert client.delete("/api/config/hosts/missing").json() == {"error": "host not found"}
    assert client.delete("/api/config/hosts/node-1").json()["hosts"] == []


def test_llm_provider_crud(client):
    providers = client.get("/api/config/llm-providers").json()["providers"]
    assert any(p["id"] == "deepseek" for p in providers)
    assert client.post("/api/config/llm-providers", json={"id": "x"}).status_code == 400
    res = client.post(
        "/api/config/llm-providers",
        json={"id": "my-provider", "type": "generic", "name": "My", "baseURL": "http://llm.local/v1"},
    )
    assert {p["id"] for p in res.json()["providers"]} == {"my-provider"}
    assert client.post("/api/config/llm-providers/my-provider/default").json()["providers"][0]["isDefault"] is True
    # 与 Node 一致：运行时列表被清空后回退到内置默认 provider
    remaining = client.delete("/api/config/llm-providers/my-provider").json()["providers"]
    assert {p["id"] for p in remaining} == {"openai", "deepseek"}


def test_database_system_sqlite_query(client, tmp_path):
    db_file = tmp_path / "demo.sqlite"
    conn = sqlite3.connect(db_file)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO t (id, name) VALUES (1, 'alpha'), (2, 'beta')")
    conn.commit()
    conn.close()

    res = client.post(
        "/api/config/database-systems",
        json={"id": "local-sqlite", "name": "Local", "dialect": "sqlite", "host": str(db_file)},
    )
    assert res.json()["systems"][0]["type"] == "database"
    assert client.post("/api/data-sources/db/local-sqlite/test").json()["reachable"] is True

    rows = client.post("/api/data-sources/db/local-sqlite/query", json={"sql": "SELECT * FROM t ORDER BY id"}).json()
    assert rows["ok"] is True
    assert rows["columns"] == ["id", "name"]
    assert rows["rows"] == [{"id": 1, "name": "alpha"}, {"id": 2, "name": "beta"}]

    forbidden = client.post("/api/data-sources/db/local-sqlite/query", json={"sql": "DROP TABLE t"})
    assert forbidden.status_code == 403
    assert "只读" in forbidden.json()["error"]


def test_data_sources_prom_missing_backend(client):
    assert client.post("/api/data-sources/prom/nope/query", json={"query": "up"}).status_code == 404
    assert client.post("/api/data-sources/prom/nope/query", json={"query": "up"}).json() == {
        "error": "prometheus backend not found"
    }


def test_skills_list_and_curated(client):
    skills = client.get("/api/skills").json()["skills"]
    assert isinstance(skills, list)
    curated = client.get("/api/skills/curated").json()["skills"]
    assert any(s["name"] == "ceph-rbd-108" for s in curated)


def test_drawio_generate_and_download(client):
    res = client.post(
        "/api/skills/drawio/generate",
        json={"log_relations": [{"source": "order-api", "target": "redis", "relation": "读缓存"}], "title": "T"},
    )
    body = res.json()
    assert body["ok"] is True and body["node_count"] == 2 and body["edge_count"] == 1
    download = client.get("/api/skills/drawio/download", params={"path": body["output_path"]})
    assert download.status_code == 200
    assert b"mxfile" in download.content


def test_log_system_accepts_es8_backend(client):
    # P2：ES 8 后端类型（走 REST + compatible-with: 8）
    payload = {
        "id": "es8-ci",
        "type": "es8",
        "name": "Elasticsearch 8",
        "enabled": True,
        "node": "https://es8.local:9200",
        "skipTlsVerify": True,
        "targets": [{"namespace": "ns1", "podNamePrefix": "app", "indexPrefix": "app-logs"}],
    }
    res = client.post("/api/config/log-systems", json=payload)
    assert res.json()["ok"] is True
    systems = client.get("/api/config/log-systems").json()["systems"]
    assert any(s["id"] == "es8-ci" and s["type"] == "es8" for s in systems)
    assert client.delete("/api/config/log-systems/es8-ci").json()["ok"] is True
