"""日志采集管道（log_shipper）：CRI/Docker 行解析、Pod 名提取、增量采集与状态、文档指纹。"""

from __future__ import annotations

import json
import os

import pytest

from infrapilot import log_shipper as ls


@pytest.fixture(autouse=True)
def _reset_shipper_state(monkeypatch):
    ls.SHIP_STATUS.clear()
    ls._warned_zero_files.clear()
    ls._shipper_states.clear()


def test_parse_cri_line():
    parsed = ls.parse_log_line("2026-07-17T05:33:11.53346851Z stdout F {\"level\":\"INFO\"}")
    assert parsed == {"time": "2026-07-17T05:33:11.53346851Z", "stream": "stdout", "content": '{"level":"INFO"}'}


def test_parse_docker_json_line_strips_trailing_newline():
    parsed = ls.parse_log_line(json.dumps({"log": "boom\n", "stream": "stdout", "time": "2026-07-18T01:01:01Z"}))
    assert parsed is not None
    assert parsed["content"] == "boom"
    assert parsed["stream"] == "stdout"


def test_parse_garbage_returns_none():
    assert ls.parse_log_line("random output without format") is None


def test_extract_pod_name():
    assert ls.extract_pod_name(
        "order-service_order-api-6fd4898b94-dbzbn_746b16e6-d3b5-41f2-8d1c-481cbb151538", "order-service"
    ) == "order-api-6fd4898b94-dbzbn"
    # 目录名不属于该 namespace 时不做手术
    assert ls.extract_pod_name("other", "order-service") == "other"


def test_ship_status_placeholder_for_unscanned_target():
    status = ls.get_ship_status()
    assert status, "默认应有 order-api 采集目标"
    assert all(s.get("warning") == "尚未扫描,等待下一次采集" for s in status)


def test_ship_once_enriches_docs_and_is_idempotent(tmp_path, monkeypatch):
    root = tmp_path / "pods"
    pod_dir = root / "order-service_order-api-abc_746b16e6"
    cont_dir = pod_dir / "containerd"
    cont_dir.mkdir(parents=True)
    (cont_dir / "a.log").write_text(
        '2026-07-17T05:33:11Z stdout F {"level":"INFO","msg":"first"}\n'
        'not-a-cri-line\n'
        '{"log":"plain banner\\n","stream":"stderr","time":"2026-07-17T05:33:12Z"}\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("PODS_LOG_ROOT", str(root))

    captured: dict[str, list] = {}

    def fake_bulk(index_docs):
        captured["index_docs"] = index_docs

    import asyncio

    monkeypatch.setattr(ls, "_bulk_write", fake_bulk)
    target = {"namespace": "order-service", "podNamePrefix": "order-api", "indexPrefix": "order-api-logs"}
    result = asyncio.run(ls.ship_once(target))
    assert result["shipped"] == 2
    with_index = [d for _, d in captured["index_docs"]]
    enriched = [d for d in with_index if d.get("msg") == "first"][0]
    assert enriched["pod_name"] == "order-api-abc"
    assert enriched["namespace"] == "order-service"
    assert enriched["container"] == "containerd"
    assert enriched["@timestamp"] == "2026-07-17T05:33:11Z"
    index_of, _ = captured["index_docs"][0]
    assert index_of.startswith("order-api-logs-")
    plain = [d for d in with_index if "message" in d][0]
    assert plain["message"] == "plain banner"
    assert plain["stream"] == "stderr"

    # 幂等：同文件同 offset 再采一次应为 0
    again = asyncio.run(ls.ship_once(target))
    assert again["shipped"] == 0
    assert os.stat(cont_dir / "a.log").st_size == ls._shipper_states[str(cont_dir / "a.log")]["offset"]


def test_ship_once_zero_files_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("PODS_LOG_ROOT", str(tmp_path / "does-not-exist"))
    target = {"namespace": "order-service", "podNamePrefix": "order-api", "indexPrefix": "order-api-logs"}
    import asyncio

    result = asyncio.run(ls.ship_once(target))
    assert result["shipped"] == 0
    status = ls.get_ship_status()[0]
    assert "匹配到 0 个日志文件" in status["warning"]


def test_ship_once_truncation_restarts_offset(tmp_path, monkeypatch):
    root = tmp_path / "pods"
    cont_dir = root / "order-service_order-api-abc_746b16e6" / "containerd"
    cont_dir.mkdir(parents=True)
    log_file = cont_dir / "a.log"
    log_file.write_text(
        "2026-07-17T05:33:11Z stdout F one\n2026-07-17T05:33:12Z stdout F two\n", encoding="utf-8"
    )
    monkeypatch.setenv("PODS_LOG_ROOT", str(root))

    consumed: list[list] = []
    import asyncio

    monkeypatch.setattr(ls, "_bulk_write", lambda index_docs: consumed.append(index_docs))

    target = {"namespace": "order-service", "podNamePrefix": "order-api", "indexPrefix": "order-api-logs"}
    assert asyncio.run(ls.ship_once(target))["shipped"] == 2
    # 轮转截断 → 从头重读
    log_file.write_text("2026-07-17T06:00:00Z stdout F rotated\n", encoding="utf-8")
    assert asyncio.run(ls.ship_once(target))["shipped"] == 1
    assert consumed[-1][0][1]["message"] == "rotated"
