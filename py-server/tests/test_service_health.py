"""服务健康聚合：真实 Prometheus 结果的纯函数组合 + 采集层的缓存/回退。"""

from __future__ import annotations

import pytest

from infrapilot import service_health
from infrapilot.service_health import collect_service_health, compose_service_health


@pytest.fixture(autouse=True)
def _reset_cache(monkeypatch):
    """每个用例重置模块级短缓存，并固定数据源为可用的 prometheus。"""
    monkeypatch.setattr(
        service_health, "get_default_prometheus_backend", lambda: {"id": "test", "url": "http://prom"}
    )
    with service_health._CACHE_LOCK:
        service_health._CACHE.update(at=0.0, services=[], total=0)
    yield


def _instant(value=3.0):
    return {
        "resultType": "vector",
        "samples": [{"metric": {"namespace": "ems", "deployment": "ecp-api"}, "value": [0, str(value)]}],
    }


def _matrix():
    return {
        "resultType": "matrix",
        "samples": [
            {"metric": {"namespace": "ems", "deployment": "ecp-api"}, "values": [[0, "3"], [300, "3"]]}
        ],
    }


def test_composes_cards_and_flags_degraded_first():
    available = {("openstack", "nova-api"): 1.0, ("openstack", "aodh-api"): 3.0, ("ems", "ems-api"): 0.0}
    spec = {("openstack", "nova-api"): 3.0, ("openstack", "aodh-api"): 3.0, ("ems", "ems-api"): 2.0}
    series = {("openstack", "aodh-api"): [3, 3, 3, 3]}

    cards = compose_service_health(available, spec, series, limit=10)

    by_name = {card["name"]: card for card in cards}
    assert by_name["ems-api"]["status"] == "err"
    assert by_name["nova-api"]["status"] == "warn"
    assert by_name["aodh-api"]["status"] == "ok"
    # 降级优先排序：err -> warn -> ok
    assert [card["status"] for card in cards] == ["err", "warn", "ok"]
    assert by_name["aodh-api"]["metricValue"] == "3/3"
    assert by_name["aodh-api"]["meta"] == "openstack · 3/3 副本"
    assert by_name["aodh-api"]["chart"] == [3, 3, 3, 3]
    # 无区间数据时退化为单点，避免 Sparkline 崩溃
    assert by_name["nova-api"]["chart"] == [1.0, 1.0]


def test_respects_limit():
    available = {("ns", f"app-{i}"): 1.0 for i in range(20)}
    spec = {("ns", f"app-{i}"): 1.0 for i in range(20)}
    assert len(compose_service_health(available, spec, {}, limit=5)) == 5


def test_collect_queries_concurrently_and_caches(monkeypatch):
    calls = {"instant": 0, "range": 0}

    def fake_instant(backend, query, time_=None, timeout=None):
        calls["instant"] += 1
        return _instant(3.0 if query.endswith("replicas_available") else 3.0)

    def fake_range(backend, query, start, end, step, timeout=None):
        calls["range"] += 1
        return _matrix()

    monkeypatch.setattr(service_health.prom, "prom_instant_query", fake_instant)
    monkeypatch.setattr(service_health.prom, "prom_range_query", fake_range)

    first = collect_service_health(force=True)
    assert first["error"] is None
    assert first["total"] == 1
    assert first["services"][0]["namespace"] == "ems"
    assert first["services"][0]["status"] == "ok"
    assert calls == {"instant": 2, "range": 1}

    second = collect_service_health()
    assert second.get("cached") is True
    assert calls == {"instant": 2, "range": 1}  # 命中缓存，未再打 Prometheus


def test_collect_falls_back_to_stale_on_error(monkeypatch):
    monkeypatch.setattr(service_health.prom, "prom_instant_query", lambda *a, **k: _instant(3.0))
    monkeypatch.setattr(service_health.prom, "prom_range_query", lambda *a, **k: _matrix())
    good = collect_service_health(force=True)
    assert good["error"] is None

    def boom(*a, **k):
        raise RuntimeError("timed out")

    monkeypatch.setattr(service_health.prom, "prom_instant_query", boom)
    stale = collect_service_health(force=True)
    assert stale.get("stale") is True
    assert stale["error"] == "timed out"
    assert stale["services"] == good["services"]


def test_collect_returns_error_when_no_cache(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("timed out")

    monkeypatch.setattr(service_health.prom, "prom_instant_query", boom)
    monkeypatch.setattr(service_health.prom, "prom_range_query", boom)

    result = collect_service_health(force=True)
    assert result["services"] == []
    assert result["error"] == "timed out"
    assert result["total"] == 0
