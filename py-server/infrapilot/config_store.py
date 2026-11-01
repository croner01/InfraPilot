"""RuntimeConfig 持久化 —— 对应 `server/src/config/store.ts`（按需增量移植）。

配置落盘于 data/runtime-config.json；缺失时回退到内置默认值 / 环境变量。
"""

from __future__ import annotations

import json
import os
import random
import string
from typing import Any, Optional

from .settings import RUNTIME_CONFIG_PATH, LlmEnv


def _load() -> dict[str, Any]:
    try:
        with open(RUNTIME_CONFIG_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def _save(cfg: dict[str, Any]) -> None:
    RUNTIME_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = RUNTIME_CONFIG_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    tmp.replace(RUNTIME_CONFIG_PATH)


# -------------------- LLM Providers --------------------


def default_llm_providers() -> list[dict[str, Any]]:
    return [
        {
            "id": "openai",
            "type": "openai",
            "name": "OpenAI",
            "enabled": False,
            "baseURL": "https://api.openai.com/v1",
            "models": "GPT-4o / GPT-4 / GPT-3.5 系列",
            "recommendedModel": "gpt-4o",
        },
        {
            "id": "deepseek",
            "type": "deepseek",
            "name": "DeepSeek",
            "enabled": True,
            "isDefault": True,
            "baseURL": "https://www.genspark.ai/api/llm_proxy/v1",
            "models": "DeepSeek V4, 支持 deepseek-v4-flash / deepseek-v4-pro, 1M 上下文",
            "recommendedModel": "deepseek-v4-flash",
        },
    ]


def get_llm_providers() -> list[dict[str, Any]]:
    runtime = _load().get("llmProviders")
    if runtime:
        return runtime
    return default_llm_providers()


def get_default_llm_provider() -> Optional[dict[str, Any]]:
    providers = get_llm_providers()
    return next((p for p in providers if p.get("enabled") and p.get("isDefault")), None) or next(
        (p for p in providers if p.get("enabled")), None
    )


def set_llm_providers(providers: list[dict[str, Any]]) -> None:
    cfg = _load()
    cfg["llmProviders"] = providers
    _save(cfg)
    sync_llm_env(providers)


def upsert_llm_provider(provider: dict[str, Any]) -> list[dict[str, Any]]:
    cfg = _load()
    providers = [p for p in (cfg.get("llmProviders") or []) if p.get("id") != provider.get("id")]
    providers.append(provider)
    cfg["llmProviders"] = providers
    _save(cfg)
    sync_llm_env(providers)
    return providers


def delete_llm_provider(provider_id: str) -> list[dict[str, Any]]:
    cfg = _load()
    providers = [p for p in (cfg.get("llmProviders") or []) if p.get("id") != provider_id]
    cfg["llmProviders"] = providers
    _save(cfg)
    sync_llm_env(providers)
    return providers


def set_default_llm_provider(provider_id: str) -> list[dict[str, Any]]:
    providers = [{**p, "isDefault": p.get("id") == provider_id} for p in get_llm_providers()]
    set_llm_providers(providers)
    return providers


def sync_llm_env(providers: list[dict[str, Any]]) -> None:
    default = next((p for p in providers if p.get("enabled") and p.get("isDefault")), None) or next(
        (p for p in providers if p.get("enabled")), None
    )
    if not default:
        return
    os.environ["OPENAI_BASE_URL"] = default.get("baseURL") or ""
    os.environ["REASONING_MODEL"] = default.get("recommendedModel") or "deepseek-v4-pro"
    os.environ["FAST_MODEL"] = default.get("recommendedModel") or "deepseek-v4-flash"
    api_key = default.get("apiKey") or os.environ.get(default.get("apiKeyEnv") or "", "")
    if api_key:
        os.environ["OPENAI_API_KEY"] = api_key


# -------------------- Memory --------------------

DEFAULT_MEMORY_CONFIG = {"enabled": True, "recallTopK": 3}


def get_memory_config() -> dict[str, Any]:
    return _load().get("memory") or dict(DEFAULT_MEMORY_CONFIG)


def set_memory_config(cfg: dict[str, Any]) -> dict[str, Any]:
    current = _load()
    merged = {
        "enabled": cfg.get("enabled", DEFAULT_MEMORY_CONFIG["enabled"]),
        "recallTopK": int(cfg.get("recallTopK") or DEFAULT_MEMORY_CONFIG["recallTopK"]),
    }
    current["memory"] = merged
    _save(current)
    return merged


# -------------------- MCP --------------------

DEFAULT_MCP_PORT = 8443


def get_mcp_config() -> dict[str, Any]:
    runtime = _load().get("mcp") or {}
    return {
        "serverPort": runtime.get("serverPort") or int(os.environ.get("MCP_SERVER_PORT") or DEFAULT_MCP_PORT),
        "jwtSecret": os.environ.get("MCP_JWT_SECRET") or runtime.get("jwtSecret") or "",
    }


def set_mcp_config(config: dict[str, Any]) -> None:
    current = _load()
    current["mcp"] = config
    _save(current)
    sync_mcp_env(config)


def sync_mcp_env(config: Optional[dict[str, Any]] = None) -> None:
    mcp = config or get_mcp_config()
    if mcp.get("serverPort"):
        os.environ["MCP_SERVER_PORT"] = str(mcp["serverPort"])
    if mcp.get("jwtSecret"):
        os.environ["MCP_JWT_SECRET"] = mcp["jwtSecret"]
    else:
        # 清空时必须同步移除环境变量，否则旧的 secret 会残留（MCP Server 鉴权仍会生效）
        os.environ.pop("MCP_JWT_SECRET", None)


def generate_mcp_jwt_secret() -> str:
    chars = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(random.choice(chars) for _ in range(48))


# -------------------- 通用读写（后续数据源配置复用） --------------------


def get_raw() -> dict[str, Any]:
    return _load()


def update_raw(mutate: Any) -> dict[str, Any]:
    cfg = _load()
    mutate(cfg)
    _save(cfg)
    return cfg


def get_list(key: str) -> list[dict[str, Any]]:
    return _load().get(key) or []


# -------------------- Log Systems（ELK / ClickHouse / Generic） --------------------


# ELK Skill 可消费的日志后端类型：OpenSearch SDK（elk）与 ES 8 REST（es8/elasticsearch）
ELK_LIKE_TYPES = ("elk", "es8", "elasticsearch")


def default_elk_backend() -> dict[str, Any]:
    targets_env = os.environ.get("LOG_SHIP_TARGETS")
    return {
        "id": "default-elk",
        "type": os.environ.get("LOG_BACKEND_TYPE") or "elk",
        "name": "默认 OpenSearch",
        "enabled": True,
        "node": os.environ.get("OPENSEARCH_NODE") or "http://127.0.0.1:9200",
        "username": os.environ.get("OPENSEARCH_USERNAME") or None,
        "passwordEnv": "OPENSEARCH_PASSWORD" if os.environ.get("OPENSEARCH_PASSWORD") else None,
        "skipTlsVerify": True,
        "targets": json.loads(targets_env)
        if targets_env
        else [{"namespace": "order-service", "podNamePrefix": "order-api", "indexPrefix": "order-api-logs"}],
    }


def get_log_systems() -> list[dict[str, Any]]:
    runtime = _load().get("logSystems")
    if runtime:
        return runtime
    return [default_elk_backend()]


def get_enabled_log_systems() -> list[dict[str, Any]]:
    return [b for b in get_log_systems() if b.get("enabled")]


def get_default_elk_backend() -> Optional[dict[str, Any]]:
    systems = get_log_systems()
    return next((b for b in systems if b.get("type") in ELK_LIKE_TYPES and b.get("enabled")), None) or next(
        (b for b in systems if b.get("type") in ELK_LIKE_TYPES), None
    )


def set_log_systems(systems: list[dict[str, Any]]) -> None:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["logSystems"] = systems

    update_raw(_mutate)
    sync_elk_env(systems)


def upsert_log_system(backend: dict[str, Any]) -> list[dict[str, Any]]:
    current = _load()
    systems = [b for b in (current.get("logSystems") or []) if b.get("id") != backend.get("id")]
    systems.append(backend)

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["logSystems"] = systems

    update_raw(_mutate)
    sync_elk_env(systems)
    return systems


def delete_log_system(backend_id: str) -> list[dict[str, Any]]:
    current = _load()
    systems = [b for b in (current.get("logSystems") or []) if b.get("id") != backend_id]

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["logSystems"] = systems

    update_raw(_mutate)
    sync_elk_env(systems)
    return systems


def sync_elk_env(systems: list[dict[str, Any]]) -> None:
    elk = next((b for b in systems if b.get("type") in ELK_LIKE_TYPES), None)
    if elk:
        os.environ["OPENSEARCH_NODE"] = elk.get("node") or ""
        os.environ["LOG_SHIP_TARGETS"] = json.dumps(elk.get("targets") or [], ensure_ascii=False)


def get_legacy_elk_config() -> dict[str, Any]:
    elk = get_default_elk_backend()
    if elk:
        return {"node": elk.get("node"), "targets": elk.get("targets") or []}
    default = default_elk_backend()
    return {"node": default["node"], "targets": default["targets"]}


# -------------------- Metric Systems（Prometheus） --------------------


def get_metric_systems() -> list[dict[str, Any]]:
    return _load().get("metricSystems") or []


def get_enabled_metric_systems() -> list[dict[str, Any]]:
    return [b for b in get_metric_systems() if b.get("enabled")]


def get_default_prometheus_backend() -> Optional[dict[str, Any]]:
    systems = get_metric_systems()
    return next((b for b in systems if b.get("type") == "prometheus" and b.get("enabled")), None) or next(
        (b for b in systems if b.get("type") == "prometheus"), None
    )


def set_metric_systems(systems: list[dict[str, Any]]) -> None:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["metricSystems"] = systems

    update_raw(_mutate)


def upsert_metric_system(backend: dict[str, Any]) -> list[dict[str, Any]]:
    systems = [b for b in get_metric_systems() if b.get("id") != backend.get("id")]
    systems.append(backend)

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["metricSystems"] = systems

    update_raw(_mutate)
    return systems


def delete_metric_system(backend_id: str) -> list[dict[str, Any]]:
    systems = [b for b in get_metric_systems() if b.get("id") != backend_id]

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["metricSystems"] = systems

    update_raw(_mutate)
    return systems


def get_legacy_prometheus_config() -> dict[str, Any]:
    return {"url": os.environ.get("PROMETHEUS_URL") or "http://127.0.0.1:9090"}


# -------------------- Database Systems（只读查询） --------------------


def get_database_systems() -> list[dict[str, Any]]:
    return _load().get("databaseSystems") or []


def get_enabled_database_systems() -> list[dict[str, Any]]:
    return [b for b in get_database_systems() if b.get("enabled")]


def set_database_systems(systems: list[dict[str, Any]]) -> None:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["databaseSystems"] = systems

    update_raw(_mutate)


def upsert_database_system(backend: dict[str, Any]) -> list[dict[str, Any]]:
    systems = [b for b in get_database_systems() if b.get("id") != backend.get("id")]
    systems.append(backend)

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["databaseSystems"] = systems

    update_raw(_mutate)
    return systems


def delete_database_system(backend_id: str) -> list[dict[str, Any]]:
    systems = [b for b in get_database_systems() if b.get("id") != backend_id]

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["databaseSystems"] = systems

    update_raw(_mutate)
    return systems


# -------------------- Remote Hosts（SSH / MCP 主机注册表） --------------------


def get_host_registry() -> dict[str, Any]:
    runtime_hosts = _load().get("hosts")
    if runtime_hosts:
        return {"hosts": runtime_hosts}
    env_hosts = os.environ.get("SSH_HOSTS")
    if env_hosts:
        try:
            parsed = json.loads(env_hosts)
            return parsed if isinstance(parsed, dict) else {"hosts": []}
        except ValueError:
            return {"hosts": []}
    return {"hosts": []}


def set_hosts(hosts: list[dict[str, Any]]) -> None:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["hosts"] = hosts

    update_raw(_mutate)
    os.environ["SSH_HOSTS"] = json.dumps({"hosts": hosts}, ensure_ascii=False)


def sync_runtime_hosts_to_env() -> None:
    hosts = _load().get("hosts")
    if hosts:
        os.environ["SSH_HOSTS"] = json.dumps({"hosts": hosts}, ensure_ascii=False)


def find_host(registry: dict[str, Any], name: str) -> Optional[dict[str, Any]]:
    return next((h for h in registry.get("hosts") or [] if h.get("name") == name), None)


# -------------------- Log Shipper 状态 --------------------

def get_ship_status() -> list[dict[str, Any]]:
    """真实采集状态由 log_shipper 记录（Node 版 logShipper.ts 的移植）。"""
    from . import log_shipper

    return log_shipper.get_ship_status()


def reload_ship_targets() -> None:
    # 采集目标每轮循环都从 config_store 重新读取，热更新即生效；此处保留为无操作。
    return None


# -------------------- Trace Systems（Jaeger / Tempo） --------------------


def get_trace_systems() -> list[dict[str, Any]]:
    return _load().get("traceSystems") or []


def get_enabled_trace_systems() -> list[dict[str, Any]]:
    return [b for b in get_trace_systems() if b.get("enabled")]


def get_default_trace_backend() -> Optional[dict[str, Any]]:
    systems = get_trace_systems()
    return next((b for b in systems if b.get("enabled")), None) or (systems[0] if systems else None)


def set_trace_systems(systems: list[dict[str, Any]]) -> None:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["traceSystems"] = systems

    update_raw(_mutate)


def upsert_trace_system(backend: dict[str, Any]) -> list[dict[str, Any]]:
    systems = [b for b in get_trace_systems() if b.get("id") != backend.get("id")]
    systems.append(backend)

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["traceSystems"] = systems

    update_raw(_mutate)
    return systems


def delete_trace_system(backend_id: str) -> list[dict[str, Any]]:
    systems = [b for b in get_trace_systems() if b.get("id") != backend_id]

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["traceSystems"] = systems

    update_raw(_mutate)
    return systems


def get_legacy_trace_config() -> dict[str, Any]:
    return {
        "url": os.environ.get("JAEGER_URL") or os.environ.get("TEMPO_URL") or "http://127.0.0.1:16686",
        "type": "jaeger" if os.environ.get("JAEGER_URL") else ("tempo" if os.environ.get("TEMPO_URL") else "jaeger"),
    }


# -------------------- K8s Clusters（远端集群接入） --------------------


def get_k8s_clusters() -> list[dict[str, Any]]:
    runtime = _load().get("k8sClusters")
    return runtime if isinstance(runtime, list) else []


def set_k8s_clusters(clusters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["k8sClusters"] = clusters

    update_raw(_mutate)
    return clusters


def upsert_k8s_cluster(cluster: dict[str, Any]) -> list[dict[str, Any]]:
    clusters = [c for c in get_k8s_clusters() if c.get("id") != cluster.get("id")]
    clusters.append(cluster)
    return set_k8s_clusters(clusters)


def delete_k8s_cluster(cluster_id: str) -> list[dict[str, Any]]:
    return set_k8s_clusters([c for c in get_k8s_clusters() if c.get("id") != cluster_id])
