"""Phase 3 Skill 层纯函数测试（不依赖网络 / 集群 / LLM）。"""

from __future__ import annotations

import asyncio

import pytest

from infrapilot import skills
from infrapilot.skills import clickhouse as ch
from infrapilot.skills import drawio, openstack, packages, prom


def run(coro):
    return asyncio.run(coro)


def test_tool_registry_matches_node_tool_count():
    tools = skills.all_tools()
    by_skill: dict[str, int] = {}
    for t in tools:
        by_skill[t.skill] = by_skill.get(t.skill, 0) + 1
    # linux 5 + agentTools 11 = 16，再增至 17：inspect_files（跨主机宿主路径指纹差分）
    # k8s 由 11 增至 13：list_clusters（远端多集群）+ get_pod_logs（Pod 日志走 K8s API，不依赖 kubectl）
    # 再增至 14：delete_pod（审批型变更工具，重建卡死副本）
    assert by_skill == {
        "linux": 17,
        "k8s": 14,
        "elk": 4,
        "clickhouse": 4,
        "prom": 3,
        "trace": 5,
        "knowledge": 3,
        "openstack": 7,
        "drawio": 2,
        "skills": 2,
        "subagent": 1,
        "interpreter": 1,
    }
    assert len(tools) == 63


# -------------------- prom --------------------


def test_prom_window_to_range_units():
    rng = prom._window_to_range("30m", "15s")
    assert rng["step"] == "15s"
    assert int(rng["end"]) - int(rng["start"]) == 1800


def test_prom_window_defaults_to_one_hour():
    rng = prom._window_to_range("garbage", "1m")
    assert int(rng["end"]) - int(rng["start"]) == 3600


def test_prom_resolve_backend_falls_back_to_env(monkeypatch):
    monkeypatch.delenv("PROMETHEUS_URL", raising=False)
    backend = prom._resolve_backend()
    assert backend["url"] == "http://127.0.0.1:9090"
    monkeypatch.setenv("PROMETHEUS_URL", "http://prom.example:9090")
    assert prom._resolve_backend()["url"] == "http://prom.example:9090"


def test_prom_format_instant_empty():
    assert prom._format_instant({"resultType": "vector", "samples": []}) == "(空结果，无匹配时间序列)"


def test_prom_matrix_to_series():
    result = {
        "resultType": "matrix",
        "samples": [{"metric": {"__name__": "up", "job": "api"}, "values": [[1700000000, "1"], [1700000060, "0"]]}],
    }
    series = prom._matrix_to_series(result)
    assert series == [{"name": "up{job=api}", "points": [[1700000000000, 1.0], [1700000060000, 0.0]]}]


# -------------------- clickhouse --------------------


def test_clickhouse_escape_like_and_template():
    assert ch._escape_like("a%b_c") == "a\\%b\\_c"
    tmpl = ch._template_of("2026-09-29T10:00:00Z req 550e8400-e29b-41d4-a716-446655440000 cost 12.5ms")
    # Node 正则的时区分组只匹配 [+-]HH:MM 形式，单独的 Z 不消费，保持一致
    assert tmpl == "<TIMESTAMP>Z req <UUID> cost <NUM>ms"


def test_clickhouse_where_clauses_defaults():
    clauses, params = ch._build_where_clauses({"namespace": "islap", "level": "error"})
    assert any("l.namespace" in c for c in clauses)
    assert params["levelNorm"] == "ERROR"
    assert params["minutesAgo"] == 30


def test_clickhouse_rejects_unknown_group_field():
    result = run(ch.execute("aggregate_by_field", {"field": "message"}))
    assert result.success is False
    assert "不允许的分组字段" in result.error


# -------------------- drawio --------------------


def test_drawio_build_mx_file_structure():
    xml = drawio._build_mx_file(
        [{"source": "order-api", "target": "redis", "relation": "读缓存"}], "拓扑"
    )
    assert xml.startswith("<?xml")
    assert 'id="node-0"' in xml and 'id="node-1"' in xml
    assert 'id="edge-0"' in xml
    assert "读缓存" in xml


def test_drawio_path_normalization_escapes_dir(tmp_path):
    normalized = drawio._normalize_diagram_path("/etc/passwd.drawio")
    assert normalized.startswith(str(drawio.DIAGRAMS_DIR))


# -------------------- openstack --------------------


def test_openstack_from_env_requires_credentials(monkeypatch):
    for key in ("OS_AUTH_URL", "OS_USERNAME", "OS_PASSWORD", "OS_PROJECT_NAME"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(openstack.OpenStackClientError):
        openstack.from_env()


def test_openstack_resolve_endpoint_prefers_public_and_region():
    catalog = [
        {
            "type": "compute",
            "endpoints": [
                {"interface": "internal", "region": "r1", "url": "http://int"},
                {"interface": "public", "region": "r1", "url": "http://pub-r1/"},
                {"interface": "public", "region": "r2", "url": "http://pub-r2/"},
            ],
        }
    ]
    assert openstack._resolve_endpoint(catalog, "compute", {"regionName": "r2"}) == "http://pub-r2"
    assert openstack._resolve_endpoint(catalog, "compute", {}) == "http://pub-r1"


# -------------------- knowledge / packages --------------------


def test_knowledge_tool_roundtrip():
    added = run(
        skills.dispatch(
            "knowledge",
            "add_case",
            {
                "title": "order-api OOMKilled",
                "problem_type": "OOMKilled",
                "severity": "p1",
                "summary": "容器因内存超限被 OOMKiller 终止",
                "root_causes": ["memory limit 过低"],
                "solutions": ["提高 memory limit"],
            },
        )
    )
    assert added.success is True
    found = run(skills.dispatch("knowledge", "search_similar_cases", {"query": "OOMKilled 内存"}))
    assert found.success is True
    assert any(c["title"] == "order-api OOMKilled" for c in found.data)


def test_packages_list_installed():
    result = run(packages.execute("list_installed", {}))
    assert result.success is True
    assert "skills" in result.data


def test_placeholder_skills_stub():
    topo_result = run(skills.dispatch("topology", "x", {}))
    assert topo_result.success is False and "尚未实现" in topo_result.error


# -------------------- trace (P2) --------------------


def test_trace_normalizes_jaeger_span():
    from infrapilot.skills import trace as tr

    span = {
        "spanID": "s1",
        "operationName": "GET /orders",
        "startTime": 1700000000000000,
        "duration": 25000,
        "tags": [{"key": "error", "value": "true"}],
        "processID": "p1",
    }
    normalized = tr._norm_span(span, "order-api")
    assert normalized["service"] == "order-api"
    assert normalized["durationMs"] == 25.0
    assert normalized["status"] == "error"


def test_trace_backend_resolution_falls_back_to_env(monkeypatch):
    from infrapilot.skills import trace as tr

    monkeypatch.setenv("JAEGER_URL", "http://jaeger.local:16686")
    backend = tr._resolve_backend()
    assert backend["url"] == "http://jaeger.local:16686"
    assert backend["type"] == "jaeger"


def test_trace_tool_defs_are_readonly():
    from infrapilot.skills import trace as tr

    assert {t.name for t in tr.TOOLS} == {"list_services", "list_operations", "find_traces", "get_trace", "get_dependencies"}
    assert all(t.risk == "readonly" and t.skill == "trace" for t in tr.TOOLS)


# -------------------- ES8 客户端兼容 (P2) --------------------


def test_datasource_client_flavor_detection_and_compat_header():
    from infrapilot import datasource_client as ds

    assert ds.is_rest_flavor({"type": "es8"}) is True
    assert ds.is_rest_flavor({"type": "elasticsearch"}) is True
    assert ds.is_rest_flavor({"type": "elk"}) is False
    assert ds.is_rest_flavor(None) is False

    es8_headers = ds.build_headers({"type": "es8"})
    assert es8_headers["Accept"] == ds.ES8_COMPAT_ACCEPT
    assert es8_headers["Content-Type"] == ds.ES8_COMPAT_CONTENT_TYPE

    os_headers = ds.build_headers({"type": "elk"})
    assert os_headers["Accept"] == "application/json"
    assert "compatible-with" not in os_headers["Content-Type"]


def test_datasource_client_header_env_and_auth(monkeypatch):
    from infrapilot import datasource_client as ds

    monkeypatch.setenv("MY_LOG_TOKEN", "s3cret")
    headers = ds.build_headers({"type": "elk", "headers": {"X-Team": "sre"}, "headerEnv": {"Authorization": "MY_LOG_TOKEN"}})
    assert headers["X-Team"] == "sre"
    assert headers["Authorization"] == "s3cret"
    assert ds.auth_tuple({"node": "http://x", "username": "u"}) is None
    assert ds.auth_tuple({"node": "http://x", "username": "u", "password": "p"}) == ("u", "p")


def test_es8_backend_selects_rest_path():
    from infrapilot import config_store as store
    from infrapilot.skills import elk

    original = store.get_log_systems()
    try:
        store.set_log_systems(
            [
                {
                    "id": "es8-prod",
                    "type": "es8",
                    "name": "Elasticsearch 8",
                    "enabled": True,
                    "node": "https://es8.local:9200",
                    "skipTlsVerify": True,
                    "targets": [{"namespace": "ns1", "podNamePrefix": "app", "indexPrefix": "app-logs"}],
                }
            ]
        )
        backend = elk.active_backend()
        assert backend["id"] == "es8-prod"
        from infrapilot import datasource_client as ds

        assert ds.is_rest_flavor(backend) is True
        # 索引模式解析复用同一份 targets 逻辑
        assert elk.resolve_index_pattern("ns1") == "app-logs-*"
    finally:
        store.set_log_systems(original)
