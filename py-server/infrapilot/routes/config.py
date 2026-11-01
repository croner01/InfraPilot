"""Configuration API —— 对应 `server/src/routes/config.ts`。

日志系统（ELK/ClickHouse/Generic）、指标系统（Prometheus）、数据库系统、
远程主机注册表、LLM Provider、MCP 与记忆配置。
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import socket
import uuid
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request

from .. import config_store as store

config_router = APIRouter()


# -------------------- Log Systems --------------------


@config_router.get("/log-systems")
def get_log_systems() -> dict[str, Any]:
    return {"systems": store.get_log_systems()}


@config_router.put("/log-systems")
def put_log_systems(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    systems = (payload or {}).get("systems")
    if not isinstance(systems, list):
        raise HTTPException(status_code=400, detail="systems must be an array")
    store.set_log_systems(systems)
    store.reload_ship_targets()
    return {"ok": True, "systems": store.get_log_systems()}


@config_router.post("/log-systems")
def post_log_system(system: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    system = system or {}
    if not system.get("id") or not system.get("type") or not system.get("name"):
        raise HTTPException(status_code=400, detail="id, type and name are required")
    store.upsert_log_system(system)
    store.reload_ship_targets()
    return {"ok": True, "systems": store.get_log_systems()}


@config_router.delete("/log-systems/{system_id}")
def delete_log_system(system_id: str) -> dict[str, Any]:
    store.delete_log_system(system_id)
    store.reload_ship_targets()
    return {"ok": True, "systems": store.get_log_systems()}


@config_router.post("/log-systems/{system_id}/test")
async def test_log_system(system_id: str) -> dict[str, Any]:
    system = next((s for s in store.get_log_systems() if s.get("id") == system_id), None)
    if not system:
        raise HTTPException(status_code=404, detail="log system not found")
    try:
        reachable = await _check_log_system(system)
        return {"ok": True, "reachable": reachable, "systemId": system_id}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err), "systemId": system_id}


@config_router.get("/log-systems/{system_id}/ship-status")
def ship_status(system_id: str) -> dict[str, Any]:
    system = next((s for s in store.get_log_systems() if s.get("id") == system_id), None)
    if not system:
        raise HTTPException(status_code=404, detail="log system not found")
    if system.get("type") not in ("elk", "es8", "elasticsearch"):
        return {"ok": True, "statuses": []}
    from .. import log_shipper

    return {"ok": True, "statuses": log_shipper.get_ship_status()}


async def _check_log_system(system: dict[str, Any]) -> bool:
    stype = system.get("type")
    if stype in ("elk", "es8", "elasticsearch"):
        import httpx

        from ..datasource_client import auth_tuple, build_headers

        # 与 ELK Skill 共用 REST 客户端语义：支持 OpenSearch 与 ES8（compatible-with: 8），
        # 以及 username/passwordEnv 基本鉴权。
        async with httpx.AsyncClient(timeout=10, verify=False, auth=auth_tuple(system)) as client:
            res = await client.get(
                f"{system['node'].rstrip('/')}/_cluster/health",
                params={"wait_for_status": "yellow", "timeout": "5s"},
                headers=build_headers(system),
            )
        if res.status_code >= 400:
            kind = "Elasticsearch" if stype in ("es8", "elasticsearch") else "OpenSearch"
            raise RuntimeError(f"{kind} 返回 {res.status_code}")
        return True
    if stype == "clickhouse":
        import httpx

        port = system.get("port") or 8123
        headers = {"X-ClickHouse-User": system.get("username") or "default"}
        if system.get("passwordEnv") and os.environ.get(system["passwordEnv"]):
            headers["X-ClickHouse-Key"] = os.environ[system["passwordEnv"]]
        query = f"SELECT 1 FROM system.databases WHERE name = '{system.get('database')}'"
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"http://{system['host']}:{port}/", params={"query": query}, headers=headers)
        if res.status_code >= 400:
            raise RuntimeError(f"ClickHouse 返回 {res.status_code}")
        return True
    if stype == "generic":
        import httpx

        headers = dict(system.get("headers") or {})
        for key, env_name in (system.get("headerEnv") or {}).items():
            if os.environ.get(env_name):
                headers[key] = os.environ[env_name]
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.head(system["url"], headers=headers)
        return res.status_code < 400
    raise RuntimeError(f"unsupported log system type: {stype}")


# -------------------- Metric Systems (Prometheus) --------------------


@config_router.get("/metric-systems")
def get_metric_systems() -> dict[str, Any]:
    return {"systems": store.get_metric_systems()}


@config_router.post("/metric-systems")
def post_metric_system(system: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    system = system or {}
    if not system.get("id") or not system.get("name") or not system.get("url"):
        raise HTTPException(status_code=400, detail="id, name and url are required")
    store.upsert_metric_system({**system, "type": "prometheus"})
    return {"ok": True, "systems": store.get_metric_systems()}


@config_router.delete("/metric-systems/{system_id}")
def delete_metric_system(system_id: str) -> dict[str, Any]:
    store.delete_metric_system(system_id)
    return {"ok": True, "systems": store.get_metric_systems()}


@config_router.post("/metric-systems/{system_id}/test")
async def test_metric_system(system_id: str) -> dict[str, Any]:
    from ..skills import prom

    system = next((s for s in store.get_metric_systems() if s.get("id") == system_id), None)
    if not system:
        raise HTTPException(status_code=404, detail="metric system not found")
    try:
        data = await asyncio.to_thread(prom._prom_request, system, "api/v1/status/buildinfo", {})
        return {"ok": True, "reachable": True, "version": (data or {}).get("version") or "unknown"}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err)}


# -------------------- Database Systems --------------------


@config_router.get("/database-systems")
def get_database_systems() -> dict[str, Any]:
    return {"systems": store.get_database_systems()}


@config_router.post("/database-systems")
def post_database_system(system: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    system = system or {}
    if not system.get("id") or not system.get("name") or not system.get("dialect") or not system.get("host"):
        raise HTTPException(status_code=400, detail="id, name, dialect and host are required")
    store.upsert_database_system({**system, "type": "database"})
    return {"ok": True, "systems": store.get_database_systems()}


@config_router.delete("/database-systems/{system_id}")
def delete_database_system(system_id: str) -> dict[str, Any]:
    store.delete_database_system(system_id)
    return {"ok": True, "systems": store.get_database_systems()}


@config_router.post("/database-systems/{system_id}/test")
async def test_database_system(system_id: str) -> dict[str, Any]:
    system = next((s for s in store.get_database_systems() if s.get("id") == system_id), None)
    if not system:
        raise HTTPException(status_code=404, detail="database system not found")
    try:
        if system.get("dialect") == "sqlite":
            reachable = os.path.exists(system["host"])
            result: dict[str, Any] = {"ok": True, "reachable": reachable}
            if not reachable:
                result["error"] = f"文件不存在: {system['host']}"
            return result
        port = system.get("port") or _default_db_port(system.get("dialect"))
        reachable = await _tcp_probe(system["host"], port)
        result = {"ok": True, "reachable": reachable}
        if not reachable:
            result["error"] = f"无法连接 {system['host']}:{port}"
        return result
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err)}


_DB_DEFAULT_PORTS = {"mysql": 3306, "mariadb": 3306, "postgres": 5432, "clickhouse": 8123, "elasticsearch": 9200}


def _default_db_port(dialect: Any) -> int:
    return _DB_DEFAULT_PORTS.get(str(dialect), 5432)


async def _tcp_probe(host: str, port: int, timeout: float = 5.0) -> bool:
    def _try() -> bool:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            return False

    return await asyncio.to_thread(_try)


# -------------------- Remote Hosts --------------------


@config_router.get("/hosts")
def get_hosts() -> dict[str, Any]:
    return store.get_host_registry()


@config_router.put("/hosts")
def put_hosts(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    hosts = (payload or {}).get("hosts")
    if not isinstance(hosts, list):
        raise HTTPException(status_code=400, detail="hosts must be an array")
    store.set_hosts(hosts)
    return {"ok": True, "hosts": hosts}


@config_router.post("/hosts")
def post_host(entry: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    entry = entry or {}
    auth = entry.get("auth") or {}
    if not entry.get("name") or not auth.get("type"):
        raise HTTPException(status_code=400, detail="name and auth.type are required")
    if auth.get("type") != "mcp" and (not entry.get("hostname") or not entry.get("username")):
        raise HTTPException(status_code=400, detail="hostname and username are required for SSH hosts")
    if auth.get("type") == "mcp" and not auth.get("endpoint"):
        raise HTTPException(status_code=400, detail="endpoint is required for MCP hosts")
    current = store.get_host_registry()
    filtered = [h for h in current["hosts"] if h.get("name") != entry["name"]]
    filtered.append({**entry, "port": entry.get("port") or 22})
    store.set_hosts(filtered)
    return {"ok": True, "hosts": filtered}


@config_router.delete("/hosts/{name}")
def delete_host(name: str) -> dict[str, Any]:
    current = store.get_host_registry()
    filtered = [h for h in current["hosts"] if h.get("name") != name]
    if len(filtered) == len(current["hosts"]):
        raise HTTPException(status_code=404, detail="host not found")
    store.set_hosts(filtered)
    return {"ok": True, "hosts": filtered}


@config_router.post("/hosts/{name}/test")
async def test_host(name: str) -> dict[str, Any]:
    registry = store.get_host_registry()
    host = store.find_host(registry, name)
    if not host:
        raise HTTPException(status_code=404, detail="host not found")
    try:
        auth = host.get("auth") or {}
        reachable = await _test_mcp_connection(host) if auth.get("type") == "mcp" else await _test_ssh_connection(host)
        return {"ok": True, "reachable": reachable, "host": name}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err), "host": name}


async def _test_mcp_connection(host: dict[str, Any]) -> bool:
    """MCP 主机探活：优先走标准 MCP `initialize`（真实协议探测）。

    兼容遗留部署：endpoint 是 gRPC linux-mcp-server 或其它非 JSON-RPC 服务时，
    端口可用即视为可达（与 gRPC 时代健康检查等价）。
    """
    from .. import mcp_client

    endpoint = (host.get("auth") or {}).get("endpoint")
    if not endpoint:
        raise RuntimeError("MCP endpoint not configured")
    try:
        info = await mcp_client.ping(endpoint)
        if isinstance(info, dict) and info.get("name"):
            return True
    except Exception:  # noqa: BLE001 - 非 JSON-RPC 端点退回 TCP 探测
        pass
    target = endpoint.split("://")[-1]
    hostname, _, port_text = target.partition(":")
    port = int(port_text or 8443)
    ok = await _tcp_probe(hostname, port, timeout=5)
    if not ok:
        raise RuntimeError("MCP health check failed")
    # 端口在但不是 MCP JSON-RPC：给配置者一个明确信号而不是静默成功
    raise RuntimeError("MCP endpoint 端口可达但未返回 MCP JSON-RPC 响应（tools/call 能力未确认）")


def _test_ssh_connection_sync(host: dict[str, Any]) -> bool:
    """凭据解析与连接复用 infrapilot.remote（唯一持有 SSH 凭据的模块）。"""
    from .. import remote as remote_exec

    return remote_exec.test_connection(host)


async def _test_ssh_connection(host: dict[str, Any]) -> bool:
    return await asyncio.to_thread(_test_ssh_connection_sync, host)


# -------------------- LLM Providers --------------------


@config_router.get("/llm-providers")
def get_llm_providers() -> dict[str, Any]:
    return {"providers": store.get_llm_providers()}


@config_router.post("/llm-providers")
def post_llm_provider(provider: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    provider = provider or {}
    if not provider.get("id") or not provider.get("type") or not provider.get("name") or not provider.get("baseURL"):
        raise HTTPException(status_code=400, detail="id, type, name and baseURL are required")
    store.upsert_llm_provider(provider)
    return {"ok": True, "providers": store.get_llm_providers()}


@config_router.delete("/llm-providers/{provider_id}")
def delete_llm_provider(provider_id: str) -> dict[str, Any]:
    store.delete_llm_provider(provider_id)
    return {"ok": True, "providers": store.get_llm_providers()}


@config_router.post("/llm-providers/{provider_id}/default")
def set_default_llm_provider(provider_id: str) -> dict[str, Any]:
    store.set_default_llm_provider(provider_id)
    return {"ok": True, "providers": store.get_llm_providers()}


@config_router.post("/llm-providers/{provider_id}/test")
async def test_llm_provider(provider_id: str) -> dict[str, Any]:
    provider = next((p for p in store.get_llm_providers() if p.get("id") == provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail="provider not found")
    try:
        reachable = await _check_llm_provider(provider)
        return {"ok": True, "reachable": reachable, "providerId": provider_id}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": str(err), "providerId": provider_id}


async def _check_llm_provider(provider: dict[str, Any]) -> bool:
    from openai import AsyncOpenAI

    api_key = provider.get("apiKey") or os.environ.get(provider.get("apiKeyEnv") or "", "") or "sk-test"
    if not api_key or api_key == "sk-test":
        raise RuntimeError("API Key 未配置")
    client = AsyncOpenAI(api_key=api_key, base_url=provider["baseURL"])
    model = provider.get("recommendedModel") or "gpt-4o"
    stream = await client.chat.completions.create(
        model=model, messages=[{"role": "user", "content": "hi"}], stream=True, max_tokens=5
    )
    async for _chunk in stream:
        return True
    return True


# -------------------- MCP Configuration --------------------


@config_router.get("/mcp")
def get_mcp() -> dict[str, Any]:
    return store.get_mcp_config()


@config_router.put("/mcp")
def put_mcp(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    store.set_mcp_config({"serverPort": body.get("serverPort"), "jwtSecret": body.get("jwtSecret")})
    return {"ok": True}


@config_router.post("/mcp/generate-secret")
def generate_mcp_secret() -> dict[str, Any]:
    return {"secret": store.generate_mcp_jwt_secret()}


# -------------------- Model Prices（P0 成本核算） --------------------


@config_router.get("/model-prices")
def get_model_prices() -> dict[str, Any]:
    from .. import usage

    return {"prices": usage.get_model_prices()}


@config_router.put("/model-prices")
def put_model_prices(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import usage

    prices = (payload or {}).get("prices")
    if not isinstance(prices, list):
        raise HTTPException(status_code=400, detail="prices must be an array")
    return {"ok": True, "prices": usage.set_model_prices(prices)}


# -------------------- Memory Configuration --------------------


@config_router.get("/memory")
def get_memory() -> dict[str, Any]:
    return store.get_memory_config()


@config_router.put("/memory")
def put_memory(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    store.set_memory_config({"enabled": body.get("enabled"), "recallTopK": body.get("recallTopK")})
    return {"ok": True, **store.get_memory_config()}


# -------------------- Trace Systems（Jaeger / Tempo，P2） --------------------


@config_router.get("/trace-systems")
def get_trace_systems() -> dict[str, Any]:
    return {"systems": store.get_trace_systems()}


@config_router.post("/trace-systems")
def post_trace_system(system: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    system = system or {}
    if not system.get("id") or not system.get("name") or not system.get("url"):
        raise HTTPException(status_code=400, detail="id, name and url are required")
    store.upsert_trace_system({**system, "type": system.get("type") or "jaeger"})
    return {"ok": True, "systems": store.get_trace_systems()}


@config_router.delete("/trace-systems/{system_id}")
def delete_trace_system(system_id: str) -> dict[str, Any]:
    store.delete_trace_system(system_id)
    return {"ok": True, "systems": store.get_trace_systems()}


@config_router.post("/trace-systems/{system_id}/test")
async def test_trace_system(system_id: str) -> dict[str, Any]:
    from ..skills import trace as trace_skill

    system = next((s for s in store.get_trace_systems() if s.get("id") == system_id), None)
    if not system:
        raise HTTPException(status_code=404, detail="trace system not found")
    try:
        services = await asyncio.to_thread(trace_skill.list_services, system)
        return {"ok": True, "reachable": True, "services": services, "count": len(services)}
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "services": [], "error": str(err)}


# -------------------- K8s Clusters（远端集群接入） --------------------

_SECRET_KEYS = ("token", "kubeconfig", "clientCert", "clientKey", "caCert")


def _slugify(name: str) -> str:
    """集群 id 必须是 ASCII，且能直接放进 URL 与工具参数里。

    中文名（如「生产集群 A」）会被清空，此时回落到 cluster-<短哈希>，
    避免出现需要转义的 id —— Agent 通过 `cluster` 参数引用时会踩这个坑。
    """
    raw = (name or "").strip()
    if raw and raw.isascii():
        slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in raw)
        while "--" in slug:
            slug = slug.replace("--", "-")
        slug = slug.strip("-")
        if slug:
            return slug
    # 非 ASCII 名称（中文等）没有可用的 slug，改用名称短哈希：稳定、URL 安全、可复现
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8] if raw else uuid.uuid4().hex[:8]
    return f"cluster-{digest}"


@config_router.get("/k8s-clusters")
def get_k8s_clusters() -> dict[str, Any]:
    from .. import k8s_clusters

    clusters = k8s_clusters.list_clusters(public=True)
    default = k8s_clusters.default_cluster()
    return {
        "clusters": clusters,
        "defaultClusterId": (default or {}).get("id"),
        # 未登记任何集群时，Agent 走进程内 kubeconfig（本地集群）
        "localFallback": not clusters,
        # 本地集群始终是一等可选目标（cluster="local"），与是否登记远端集群无关
        "localTarget": k8s_clusters.local_cluster(),
        "targets": k8s_clusters.list_targets(),
    }


@config_router.post("/k8s-clusters")
def post_k8s_cluster(cluster: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import k8s_clusters

    payload = dict(cluster or {})
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")

    cluster_id = str(payload.get("id") or "").strip() or _slugify(name)
    payload["id"] = cluster_id
    auth_type = str(payload.get("authType") or "kubeconfig")
    if auth_type not in k8s_clusters.VALID_AUTH_TYPES:
        raise HTTPException(status_code=400, detail=f"authType must be one of {list(k8s_clusters.VALID_AUTH_TYPES)}")

    existing = k8s_clusters.get_cluster(cluster_id)
    if existing is None:
        # 新建集群必须自带凭据，否则保存了也连不上
        if auth_type == "kubeconfig" and not payload.get("kubeconfig"):
            raise HTTPException(status_code=400, detail="kubeconfig is required")
        if auth_type in ("token", "clientCert") and not payload.get("server"):
            raise HTTPException(status_code=400, detail="server is required")
        if auth_type == "token" and not (payload.get("token") or payload.get("tokenEnv")):
            raise HTTPException(status_code=400, detail="token or tokenEnv is required")

    # 编辑时未回传的密钥沿用原值（前端只回显 hasToken/hasKubeconfig 等标记）
    for key in _SECRET_KEYS:
        if not payload.get(key) and existing and existing.get(key):
            payload[key] = existing[key]

    payload.setdefault("enabled", True)
    payload.setdefault("insecureSkipTlsVerify", False)

    clusters = [c for c in k8s_clusters.list_clusters(public=False) if c.get("id") != cluster_id]
    is_first = not clusters
    if payload.get("isDefault") or is_first:
        clusters = [{**c, "isDefault": False} for c in clusters]
        payload["isDefault"] = True
    else:
        payload["isDefault"] = bool(payload.get("isDefault"))
    clusters.append(payload)

    store.set_k8s_clusters(clusters)
    k8s_clusters.invalidate_cache()
    return {"ok": True, "clusters": k8s_clusters.list_clusters(public=True), "cluster": k8s_clusters.public_cluster(payload)}


@config_router.delete("/k8s-clusters/{cluster_id}")
def delete_k8s_cluster(cluster_id: str) -> dict[str, Any]:
    from .. import k8s_clusters

    if k8s_clusters.get_cluster(cluster_id) is None:
        raise HTTPException(status_code=404, detail="cluster not found")
    store.delete_k8s_cluster(cluster_id)
    remaining = k8s_clusters.list_clusters(public=False)
    # 删掉默认集群后，把剩下的第一个提为默认，避免后续变更没有明确目标
    if remaining and not any(c.get("isDefault") for c in remaining):
        remaining[0]["isDefault"] = True
        store.set_k8s_clusters(remaining)
    k8s_clusters.invalidate_cache()
    return {"ok": True, "clusters": k8s_clusters.list_clusters(public=True)}


@config_router.post("/k8s-clusters/{cluster_id}/test")
async def test_k8s_cluster(cluster_id: str) -> dict[str, Any]:
    from .. import k8s_clusters

    if k8s_clusters.get_cluster(cluster_id) is None and not k8s_clusters.is_local_ref(cluster_id):
        raise HTTPException(status_code=404, detail="cluster not found")
    try:
        result = await asyncio.to_thread(k8s_clusters.test_connection, cluster_id)
        return result
    except Exception as err:  # noqa: BLE001
        return {"ok": True, "reachable": False, "error": k8s_clusters.error_message(err), "clusterId": cluster_id}
