"""K8s 服务拓扑发现（P1）—— 纯 k8s API 聚合，不依赖新增数据源。

聚合 Namespace → Deployment/StatefulSet → Service → Ingress，按 label selector
推导调用/归属关系，输出与前端 TopologyPage 的 TopoNode/TopoEdge 同构的 JSON。
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from . import k8s_clusters
from .skills.k8s import _apps, _core

_DATA_HINTS = ("mysql", "mariadb", "postgres", "redis", "mongo", "clickhouse", "elastic", "opensearch", "tidb", "ceph", "minio")
_MW_HINTS = ("kafka", "rabbit", "rocketmq", "zookeeper", "nats", "prometheus", "grafana", "etcd")
_OPENSTACK_HINTS = ("nova", "neutron", "keystone", "cinder", "glance", "ironic", "placement", "heat", "swift", "openstack", "rabbitmq")


def _kind_of(name: str, namespace: str, is_ingress: bool = False) -> str:
    if is_ingress:
        return "ingress"
    lower = f"{name} {namespace}".lower()
    if any(h in lower for h in _OPENSTACK_HINTS) and any(h in lower for h in ("nova", "neutron", "keystone", "cinder", "glance", "ironic", "placement", "heat", "swift")):
        return "openstack"
    if any(h in lower for h in _DATA_HINTS):
        return "data"
    if any(h in lower for h in _MW_HINTS):
        return "middleware"
    return "service"


def _status_from_replicas(desired: int, available: int) -> str:
    """按副本数推导节点/链路状态。

    desired == 0 表示"就没打算起副本"（如按需启动或已下线），不是故障，
    因此单独给 idle，避免拓扑页把它渲染成告警色造成误报。
    """
    if desired == 0:
        return "idle"
    if available == 0:
        return "err"
    if available < desired:
        return "warn"
    return "ok"


def _collect_sync(namespace: Optional[str], limit: int) -> dict[str, Any]:
    # 集群解析（含未登记远端集群时的本地 kubeconfig 兜底）统一由 k8s_clusters 负责。
    core, apps = _core(), _apps()
    networking = k8s_clusters.networking_api()

    deploy_items: list[Any] = []
    svc_items: list[Any] = []
    ing_items: list[Any] = []
    try:
        deploy_items = apps.list_deployment_for_all_namespaces().items if not namespace else apps.list_namespaced_deployment(namespace).items
    except Exception:  # noqa: BLE001
        deploy_items = []
    try:
        svc_items = core.list_service_for_all_namespaces().items if not namespace else core.list_namespaced_service(namespace).items
    except Exception:  # noqa: BLE001
        svc_items = []
    try:
        ing_items = (
            networking.list_ingress_for_all_namespaces().items if not namespace else networking.list_namespaced_ingress(namespace).items
        )
    except Exception:  # noqa: BLE001
        ing_items = []

    nodes: list[dict[str, Any]] = []
    node_ids: set[str] = set()

    def node_id(ns: str, name: str) -> str:
        return f"{ns}/{name}"

    def add_node(item: dict[str, Any]) -> None:
        if item["id"] in node_ids:
            return
        node_ids.add(item["id"])
        nodes.append(item)

    deploy_by_ns: dict[str, list[Any]] = {}
    for d in deploy_items:
        ns, name = (d.metadata.namespace or "default"), d.metadata.name
        desired = int(getattr(d.spec, "replicas", 0) or 0)
        available = int(getattr(d.status, "available_replicas", 0) or 0)
        labels = dict(d.metadata.labels or {})
        add_node(
            {
                "id": node_id(ns, name),
                "label": name,
                "kind": _kind_of(name, ns),
                "ns": ns,
                "status": _status_from_replicas(desired, available),
                "replicas": f"{available}/{desired}",
                "labels": labels,
            }
        )
        deploy_by_ns.setdefault(ns, []).append(d)

    for s in svc_items:
        ns, name = (s.metadata.namespace or "default"), s.metadata.name
        labels = dict(s.metadata.labels or {})
        add_node(
            {
                "id": node_id(ns, name),
                "label": name,
                "kind": _kind_of(name, ns),
                "ns": ns,
                "status": "ok",
                "labels": labels,
            }
        )

    edges: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str]] = set()

    def add_edge(source: str, target: str, label: Optional[str] = None, status: str = "ok") -> None:
        if source == target or (source, target) in seen_edges:
            return
        seen_edges.add((source, target))
        edges.append({"from": source, "to": target, "label": label, "status": status})

    # Service → Deployment：selector 匹配 Deployment labels
    for s in svc_items:
        ns, name = (s.metadata.namespace or "default"), s.metadata.name
        selector = dict((s.spec.selector if s.spec else None) or {})
        if not selector:
            continue
        for d in deploy_by_ns.get(ns, []):
            d_labels = dict(d.metadata.labels or {})
            if all(d_labels.get(k) == v for k, v in selector.items()):
                desired = int(getattr(d.spec, "replicas", 0) or 0)
                available = int(getattr(d.status, "available_replicas", 0) or 0)
                add_edge(node_id(ns, name), node_id(ns, d.metadata.name), "调度", _status_from_replicas(desired, available))

    # Ingress → Service：规则 backend
    for ing in ing_items:
        ns, name = (ing.metadata.namespace or "default"), ing.metadata.name
        add_node(
            {
                "id": node_id(ns, name),
                "label": name,
                "kind": "ingress",
                "ns": ns,
                "status": "ok",
                "labels": dict(ing.metadata.labels or {}),
            }
        )
        for rule in (ing.spec.rules if ing.spec else None) or []:
            paths = (rule.http.paths if rule.http else None) or []
            for path in paths:
                backend = getattr(path, "backend", None)
                svc = getattr(backend, "service", None) if backend else None
                svc_name = getattr(svc, "name", None) if svc else None
                if svc_name:
                    add_edge(node_id(ns, name), node_id(ns, svc_name), "http")

    if limit and len(nodes) > limit:
        nodes = nodes[:limit]
        allowed = {n["id"] for n in nodes}
        edges = [e for e in edges if e["from"] in allowed and e["to"] in allowed]

    return {"nodes": nodes, "edges": edges}


async def discover(namespace: Optional[str] = None, limit: int = 200) -> dict[str, Any]:
    data = await asyncio.to_thread(_collect_sync, namespace, limit)
    from .util import now_iso

    return {**data, "generatedAt": now_iso()}
