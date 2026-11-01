"""Prometheus ALERTS -> alerts 表同步：幂等 upsert 与过期自动 resolve。"""

from __future__ import annotations

import pytest

from infrapilot import alerts_ingest, config_store, db
from infrapilot.skills import prom


class _FakeProm:
    def __init__(self, samples):
        self.samples = samples

    def __call__(self, backend, query, time_=None):
        return {"resultType": "vector", "samples": self.samples}


@pytest.fixture(autouse=True)
def _clean_alerts():
    for row in db.list_alerts():
        db.execute("DELETE FROM alerts WHERE id=?", (row["id"],))
    yield
    for row in db.list_alerts():
        db.execute("DELETE FROM alerts WHERE id=?", (row["id"],))


def _sample(alertname, **labels):
    metric = {"__name__": "ALERTS", "alertname": alertname, "alertstate": "firing", "severity": "critical"}
    metric.update(labels)
    return {"metric": metric, "value": [1, "1"]}


def _fake_backend():
    return {"id": "t", "type": "prometheus", "name": "t", "enabled": True, "url": "http://prom"}


def test_sync_inserts_then_resolves(monkeypatch):
    monkeypatch.setattr(config_store, "get_default_prometheus_backend", _fake_backend)
    monkeypatch.setattr(prom, "prom_instant_query", _FakeProm([_sample("节点网卡链路中断", group_id="g1", node_name="node-3")]))
    first = alerts_ingest.sync_prometheus_alerts()
    assert first["ok"] is True and first["created"] == 1 and first["firing"] == 1
    rows = db.list_alerts()
    assert len(rows) == 1
    assert rows[0]["severity"] == "p0"
    assert rows[0]["source"] == "prometheus"
    assert rows[0]["status"] == "firing"

    # 第二次同步同样一条：不重复插入
    second = alerts_ingest.sync_prometheus_alerts()
    assert second["created"] == 0 and second["updated"] == 1
    assert len(db.list_alerts()) == 1

    # 告警消失后再次同步 -> 自动 resolved
    monkeypatch.setattr(prom, "prom_instant_query", _FakeProm([]))
    third = alerts_ingest.sync_prometheus_alerts()
    assert third["resolved"] == 1
    assert db.list_alerts()[0]["status"] == "resolved"
