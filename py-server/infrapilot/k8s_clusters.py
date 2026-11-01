"""远端 K8s 集群接入 —— 集群登记、ApiClient 工厂与连通性探测。

对应「接入远端 K8s 环境」需求，设计要点：

1. 集群清单存放于 `runtime-config.json` 的 `k8sClusters`（与 logSystems / metricSystems 同构），
   通过 `/api/config/k8s-clusters` 增删改查；
2. **未登记任何集群时行为完全不变**：回退到进程内 kubeconfig
   （in-cluster → KUBECONFIG → /etc/rancher/k3s/k3s.yaml → ~/.kube/config），集群 id 固定为 `local`，
   因此单机 / 容器内既有的部署零改动；
3. ApiClient 按集群 id + 配置指纹缓存，配置变更即失效，避免每次工具调用重建连接池；
4. token / client-key / CA 等敏感材料只在构造客户端时写入 0600 私有目录，对外一律脱敏。

审批不在这里做：变更类操作仍由 Policy Engine 定级、Command Gateway 校验审批令牌后执行。
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Optional

from kubernetes import client as k8s_client
from kubernetes import config as k8s_config
from kubernetes.client.exceptions import ApiException

from . import config_store
from .settings import DATA_DIR

LOCAL_CLUSTER_ID = "local"
LOCAL_CLUSTER_NAME = "本地集群（进程内 kubeconfig）"

VALID_AUTH_TYPES = ("kubeconfig", "token", "clientCert")


class K8sClusterError(RuntimeError):
    """集群配置缺失或不可用。"""


# -------------------- 脱敏 / 对外视图 --------------------


_SECRET_FIELDS = ("token", "clientKey", "clientCert", "caCert", "kubeconfig")


def public_cluster(cluster: dict[str, Any]) -> dict[str, Any]:
    """对外视图：去掉密钥正文，只保留「是否已配置」的布尔标记。"""
    view = {k: v for k, v in cluster.items() if k not in _SECRET_FIELDS}
    view["hasToken"] = bool(cluster.get("token") or cluster.get("tokenEnv"))
    view["hasKubeconfig"] = bool(cluster.get("kubeconfig"))
    view["hasClientCert"] = bool(cluster.get("clientCert") or cluster.get("clientCertPath"))
    view["hasCaCert"] = bool(cluster.get("caCert") or cluster.get("caCertPath"))
    return view


def list_clusters(*, public: bool = True) -> list[dict[str, Any]]:
    clusters = config_store.get_k8s_clusters()
    return [public_cluster(c) for c in clusters] if public else clusters


def is_local_ref(ref: Optional[str]) -> bool:
    """`local` / 本地集群名都指向进程内 kubeconfig（一等可选目标，而非仅兜底）。"""
    return bool(ref) and str(ref).strip() in (LOCAL_CLUSTER_ID, LOCAL_CLUSTER_NAME)


def local_cluster() -> dict[str, Any]:
    """本地集群的对外视图；未登记任何集群时它同时是默认集群。"""
    return {
        "id": LOCAL_CLUSTER_ID,
        "name": LOCAL_CLUSTER_NAME,
        "server": None,
        "enabled": True,
        "isDefault": default_cluster() is None,
        "isLocal": True,
    }


def list_targets() -> list[dict[str, Any]]:
    """所有可传给 k8s 工具 cluster 参数的目标：已登记集群 + 进程内本地集群。"""
    items = [dict(c) for c in list_clusters(public=True)]
    for cluster in items:
        cluster["isLocal"] = False
    items.append(local_cluster())
    return items


def render_cluster_context() -> str:
    """注入 system prompt 的目标集群清单与作用域规则，避免把「本地」误解析成默认远端集群。"""
    lines = ["# K8s 目标集群(调用 k8s.* 工具前先核对作用域)"]
    for target in list_targets():
        tags = []
        if target.get("isDefault"):
            tags.append("默认")
        if target.get("isLocal"):
            tags.append("本地/进程内 kubeconfig")
        suffix = f" [{'/'.join(tags)}]" if tags else ""
        lines.append(f"- {target.get('id')} — {target.get('name')}{suffix}")
    lines.append(
        '规则: 省略 cluster 参数命中默认集群; 用户说"本地集群/本地 k8s/本机集群"时必须显式传 '
        'cluster="local"; 目标集群与用户描述的作用域不一致时应先停下确认, 不得默认沿用远端集群。'
    )
    default = default_cluster()
    if default is not None:
        lines.append(
            f'注意: 当前默认集群是远端 {default.get("name") or default.get("id")}, '
            '排查「本地集群」必须显式指定 cluster="local"。'
        )
    return "\n".join(lines)


def get_cluster(ref: Optional[str]) -> Optional[dict[str, Any]]:
    """按 id 或名称查找已登记的集群。"""
    if not ref:
        return None
    for cluster in config_store.get_k8s_clusters():
        if ref in (cluster.get("id"), cluster.get("name")):
            return cluster
    return None


def default_cluster() -> Optional[dict[str, Any]]:
    clusters = [c for c in config_store.get_k8s_clusters() if c.get("enabled", True)]
    return next((c for c in clusters if c.get("isDefault")), None) or (clusters[0] if clusters else None)


def describe_ref(ref: Optional[str]) -> str:
    """给审批文案用的可读集群标识（显式指定但未登记时原样回显，便于排查）。"""
    if is_local_ref(ref):
        return LOCAL_CLUSTER_NAME
    if ref and get_cluster(ref) is None:
        return f"{ref}（未登记）"
    cluster = get_cluster(ref) if ref else default_cluster()
    if cluster is None:
        return LOCAL_CLUSTER_NAME
    server = cluster.get("server") or ""
    return f"{cluster.get('name') or cluster.get('id')}" + (f" ({server})" if server else "")


def resolve_id(ref: Optional[str]) -> str:
    """实际命中的集群 id；显式 local 或未登记任何集群时均为 local。"""
    if is_local_ref(ref):
        return LOCAL_CLUSTER_ID
    cluster = get_cluster(ref) if ref else default_cluster()
    return str(cluster.get("id")) if cluster else LOCAL_CLUSTER_ID


# -------------------- 客户端构造 --------------------


def _material_dir(cluster_id: str) -> Path:
    path = Path(DATA_DIR) / "k8s" / cluster_id
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


def _write_secret(cluster_id: str, filename: str, content: str) -> str:
    path = _material_dir(cluster_id) / filename
    path.write_text(content, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return str(path)


def _fingerprint(cluster: dict[str, Any]) -> str:
    raw = json.dumps(cluster, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_configuration(cluster: Optional[dict[str, Any]]) -> Optional[k8s_client.Configuration]:
    """把集群配置转换为 kubernetes client 的 Configuration。

    `cluster` 为 None 表示「未登记任何集群」，返回 None 由调用方走进程内 kubeconfig。
    """
    if cluster is None:
        return None

    auth_type = str(cluster.get("authType") or "kubeconfig")
    if auth_type not in VALID_AUTH_TYPES:
        raise K8sClusterError(f"不支持的认证方式: {auth_type}")

    cluster_id = str(cluster.get("id") or "unnamed")

    if auth_type == "kubeconfig":
        text = cluster.get("kubeconfig")
        if not text:
            raise K8sClusterError(f"集群 {cluster_id} 未提供 kubeconfig 内容")
        path = _write_secret(cluster_id, "kubeconfig", str(text))
        configuration = k8s_client.Configuration()
        try:
            k8s_config.load_kube_config(config_file=path, client_configuration=configuration)
        except Exception as err:  # noqa: BLE001
            raise K8sClusterError(f"kubeconfig 解析失败: {err}") from err
        if cluster.get("insecureSkipTlsVerify"):
            configuration.verify_ssl = False
        return configuration

    server = cluster.get("server")
    if not server:
        raise K8sClusterError(f"集群 {cluster_id} 未提供 apiserver 地址")

    configuration = k8s_client.Configuration()
    configuration.host = str(server)

    if auth_type == "token":
        token = _resolve_token(cluster)
        if not token:
            raise K8sClusterError(f"集群 {cluster_id} 未提供访问令牌")
        configuration.api_key = {"authorization": token}
        configuration.api_key_prefix = {"authorization": "Bearer"}
    else:  # clientCert
        cert_text, key_text = cluster.get("clientCert"), cluster.get("clientKey")
        cert_path = cluster.get("clientCertPath")
        key_path = cluster.get("clientKeyPath")
        if cert_text and not cert_path:
            cert_path = _write_secret(cluster_id, "client.crt", str(cert_text))
        if key_text and not key_path:
            key_path = _write_secret(cluster_id, "client.key", str(key_text))
        if not cert_path or not key_path:
            raise K8sClusterError(f"集群 {cluster_id} 未提供客户端证书/私钥")
        configuration.cert_file = str(cert_path)
        configuration.key_file = str(key_path)

    ca_path = cluster.get("caCertPath")
    if not ca_path and cluster.get("caCert"):
        ca_path = _write_secret(cluster_id, "ca.crt", str(cluster["caCert"]))
    if ca_path:
        configuration.ssl_ca_cert = str(ca_path)
        configuration.verify_ssl = True
    elif cluster.get("insecureSkipTlsVerify"):
        configuration.verify_ssl = False

    return configuration


def _resolve_token(cluster: dict[str, Any]) -> Optional[str]:
    env_name = cluster.get("tokenEnv")
    if env_name and os.environ.get(str(env_name)):
        return os.environ[str(env_name)]
    token = cluster.get("token")
    return str(token) if token else None


# -------------------- 缓存 --------------------

_K3S_CONFIG = "/etc/rancher/k3s/k3s.yaml"
_local_loaded = False


def _ensure_local_config() -> None:
    """未登记任何远端集群时的兜底：沿用 Node 版的 kubeconfig 加载策略（惰性、只做一次）。"""
    global _local_loaded
    if _local_loaded:
        return
    if os.environ.get("KUBERNETES_SERVICE_HOST"):
        k8s_config.load_incluster_config()
    elif os.environ.get("KUBECONFIG"):
        k8s_config.load_kube_config(config_file=os.environ["KUBECONFIG"])
    elif Path(_K3S_CONFIG).exists():
        k8s_config.load_kube_config(config_file=_K3S_CONFIG)
    else:
        k8s_config.load_kube_config()
    _local_loaded = True


_client_cache: dict[str, tuple[str, k8s_client.ApiClient]] = {}


def invalidate_cache() -> None:
    _client_cache.clear()


def api_client(ref: Optional[str] = None) -> Optional[k8s_client.ApiClient]:
    """返回目标集群的 ApiClient；返回 None 表示走进程内默认 kubeconfig。

    显式指定 `cluster="local"` 时走进程内 kubeconfig（一等目标）；指定其它未登记集群时
    **直接报错**：绝不允许静默回退到本地集群，否则一次「改错集群」的变更会被当成合法操作送进审批。
    """
    if is_local_ref(ref):
        return None
    if ref:
        cluster = get_cluster(ref)
        if cluster is None:
            raise K8sClusterError(f"目标集群 {ref} 未登记，请先在「系统设置 → K8s 集群」中添加，或使用 local 指向本地集群")
    else:
        cluster = default_cluster()
    if cluster is None:
        return None

    cluster_id = str(cluster.get("id") or "unnamed")
    fingerprint = _fingerprint(cluster)
    cached = _client_cache.get(cluster_id)
    if cached and cached[0] == fingerprint:
        return cached[1]

    configuration = build_configuration(cluster)
    assert configuration is not None
    client = k8s_client.ApiClient(configuration=configuration)
    _client_cache[cluster_id] = (fingerprint, client)
    return client


def core_api(ref: Optional[str] = None) -> Any:
    client = api_client(ref)
    if client is None:
        _ensure_local_config()
        return k8s_client.CoreV1Api()
    return k8s_client.CoreV1Api(client)


def apps_api(ref: Optional[str] = None) -> Any:
    client = api_client(ref)
    if client is None:
        _ensure_local_config()
        return k8s_client.AppsV1Api()
    return k8s_client.AppsV1Api(client)


def custom_api(ref: Optional[str] = None) -> Any:
    client = api_client(ref)
    if client is None:
        _ensure_local_config()
        return k8s_client.CustomObjectsApi()
    return k8s_client.CustomObjectsApi(client)


def networking_api(ref: Optional[str] = None) -> Any:
    client = api_client(ref)
    if client is None:
        _ensure_local_config()
        return k8s_client.NetworkingV1Api()
    return k8s_client.NetworkingV1Api(client)


# -------------------- 连通性探测 --------------------


def test_connection(ref: str) -> dict[str, Any]:
    """探测 apiserver 版本与节点数：既验证凭证，也验证 RBAC 是否至少可读节点。"""
    cluster = get_cluster(ref)
    if cluster is None and not is_local_ref(ref):
        raise K8sClusterError(f"集群 {ref} 不存在")

    version = k8s_client.VersionApi(api_client(ref)).get_code(_request_timeout=10)
    nodes = core_api(ref).list_node(_request_timeout=10, limit=1)
    return {
        "ok": True,
        "reachable": True,
        "cluster": public_cluster(cluster) if cluster is not None else local_cluster(),
        "serverVersion": getattr(version, "git_version", None),
        "nodeCount": len(getattr(nodes, "items", []) or []),
    }


def error_message(err: Exception) -> str:
    if isinstance(err, ApiException):
        return f"K8s API {err.status}: {getattr(err, 'reason', '') or ''}".strip()
    return str(err)
