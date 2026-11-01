"""服务拓扑路由契约测试。

回归背景：`topology.py` 曾引用 `skills.k8s._load_kube_config`，该符号在远端集群
接入改造中被 `k8s_clusters` 取代。由于导入发生在请求处理函数内部，pytest 全绿
也掩盖了 `/api/topology` 必 500 的事实。这里同时守住「模块可导入」与「路由可用」。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from infrapilot import k8s_clusters, topology
from infrapilot.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _ns(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(**kw)


def _deployment(name: str, namespace: str, labels: dict[str, str], replicas: int, available: int) -> Any:
    return _ns(
        metadata=_ns(namespace=namespace, name=name, labels=labels),
        spec=_ns(replicas=replicas),
        status=_ns(available_replicas=available),
    )


def _service(name: str, namespace: str, selector: dict[str, str]) -> Any:
    return _ns(
        metadata=_ns(namespace=namespace, name=name, labels={}),
        spec=_ns(selector=selector),
    )


def _ingress(name: str, namespace: str, backend_service: str | None) -> Any:
    service = _ns(name=backend_service) if backend_service else None
    path = _ns(backend=_ns(service=service))
    rule = _ns(http=_ns(paths=[path]))
    return _ns(metadata=_ns(namespace=namespace, name=name, labels={}), spec=_ns(rules=[rule]))


class _FakeDeployments:
    def __init__(self, replicas: int = 2, available: int = 2) -> None:
        self._replicas = replicas
        self._available = available

    def _items(self, namespace: str) -> list[Any]:
        return [_deployment("web", namespace, {"app": "web"}, self._replicas, self._available)]

    def list_deployment_for_all_namespaces(self) -> Any:
        return _ns(items=self._items("default"))

    def list_namespaced_deployment(self, namespace: str) -> Any:
        return _ns(items=self._items(namespace))


class _FakeServices:
    def list_service_for_all_namespaces(self) -> Any:
        return _ns(items=[_service("web-svc", "default", {"app": "web"})])

    def list_namespaced_service(self, namespace: str) -> Any:
        return _ns(items=[_service("web-svc", namespace, {"app": "web"})])


class _FakeNetworking:
    def list_ingress_for_all_namespaces(self) -> Any:
        return _ns(items=[_ingress("web-ing", "default", "web-svc")])

    def list_namespaced_ingress(self, namespace: str) -> Any:
        return _ns(items=[_ingress("web-ing", namespace, "web-svc")])


def _install_fakes(monkeypatch, deployments: _FakeDeployments) -> None:
    """把三套 k8s API 换成内存桩，避免测试依赖真实集群。"""
    monkeypatch.setattr(topology, "_core", lambda *a, **k: _FakeServices())
    monkeypatch.setattr(topology, "_apps", lambda *a, **k: deployments)
    monkeypatch.setattr(k8s_clusters, "networking_api", lambda *a, **k: _FakeNetworking())


@pytest.fixture()
def fake_cluster(monkeypatch):
    _install_fakes(monkeypatch, _FakeDeployments())


@pytest.fixture()
def fake_cluster_idle(monkeypatch):
    """副本数为 0 的工作负载：应判为 idle，而不是告警。"""
    _install_fakes(monkeypatch, _FakeDeployments(replicas=0, available=0))


def test_collect_sync_no_longer_needs_kubeconfig_symbol():
    """守住导入路径：曾经的 _load_kube_config 已不存在，模块必须仍可导入可调用。"""
    assert hasattr(topology, "discover")
    assert not hasattr(topology, "_load_kube_config")


def test_collect_sync_builds_nodes_and_edges(fake_cluster):
    data = topology._collect_sync(None, 200)
    ids = {n["id"] for n in data["nodes"]}
    assert ids == {"default/web", "default/web-svc", "default/web-ing"}

    web = next(n for n in data["nodes"] if n["id"] == "default/web")
    assert web["replicas"] == "2/2"
    assert web["status"] == "ok"

    edges = {(e["from"], e["to"]) for e in data["edges"]}
    assert ("default/web-svc", "default/web") in edges  # Service → Deployment（selector 命中）
    assert ("default/web-ing", "default/web-svc") in edges  # Ingress → Service（backend 解析）


def test_topology_route_returns_payload(client, fake_cluster):
    res = client.get("/api/topology")
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"nodes", "edges", "generatedAt"}
    assert len(body["nodes"]) == 3
    assert body["generatedAt"]


def test_topology_route_surfaces_cluster_errors_as_500(client, monkeypatch):
    def boom(*_a: Any, **_k: Any) -> Any:
        raise k8s_clusters.K8sClusterError("目标集群 nope 未登记")

    monkeypatch.setattr(topology, "_core", boom)
    monkeypatch.setattr(topology, "_apps", boom)
    monkeypatch.setattr(k8s_clusters, "networking_api", boom)

    res = client.get("/api/topology")
    assert res.status_code == 500
    # 错误体统一为 {"error": ...}（见 main.py 的异常处理器，与 Node 版一致）
    assert "拓扑发现失败" in res.json()["error"]


@pytest.mark.parametrize(
    ("desired", "available", "expected"),
    [
        (0, 0, "idle"),  # 未部署副本：不是故障
        (2, 0, "err"),  # 期望有副本却一个都没起来
        (2, 1, "warn"),  # 部分可用
        (2, 2, "ok"),
    ],
)
def test_status_from_replicas(desired, available, expected):
    assert topology._status_from_replicas(desired, available) == expected


def test_zero_replica_workload_is_idle_not_warn(fake_cluster_idle):
    data = topology._collect_sync(None, 200)
    web = next(n for n in data["nodes"] if n["id"] == "default/web")
    assert web["status"] == "idle"
    assert web["replicas"] == "0/0"
    # 指向该工作负载的调度链路应继承 idle；整张图里不应出现任何 err
    edge_status = {(e["from"], e["to"]): e["status"] for e in data["edges"]}
    assert edge_status[("default/web-svc", "default/web")] == "idle"
    assert "err" not in set(edge_status.values())


def test_topology_route_reports_idle_without_error_count(client, fake_cluster_idle):
    body = client.get("/api/topology").json()
    assert body["nodes"][0]["status"] == "idle"
