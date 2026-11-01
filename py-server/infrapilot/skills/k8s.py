"""Kubernetes Skill —— 对应 `server/src/skills/k8s/{client,tools}.ts`。

数据源为真实 K8s 集群，支持两类目标：
- **远端集群**：由 `k8s_clusters` 登记（`/api/config/k8s-clusters`），工具通过可选的
  `cluster` 参数指定集群 id / 名称，不指定则用默认集群；
- **本地集群**：未登记任何集群时回退到进程内 kubeconfig（in-cluster → KUBECONFIG →
  /etc/rancher/k3s/k3s.yaml → ~/.kube/config），与 Node 版一致。

只读检查自动执行；`patch_resource_limits` 等变更类操作由 Policy Engine 定级、
Command Gateway 校验审批令牌后才执行（审批文案会带上目标集群）。
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from kubernetes.client.exceptions import ApiException
from kubernetes.stream import stream as k8s_stream

from .. import k8s_clusters
from ..models import ToolDef, ToolExecutionResult


def _core(cluster: Optional[str] = None) -> Any:
    """目标集群的 CoreV1Api；cluster 为空时用默认集群或进程内 kubeconfig。"""
    return k8s_clusters.core_api(cluster)


def _apps(cluster: Optional[str] = None) -> Any:
    return k8s_clusters.apps_api(cluster)


def _custom(cluster: Optional[str] = None) -> Any:
    return k8s_clusters.custom_api(cluster)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    return str(value)


# -------------------- 指标解析 --------------------


def parse_cpu(text: Optional[str]) -> Optional[float]:
    """'38m' -> 0.038, '2' -> 2, '500m' -> 0.5"""
    if not text:
        return None
    m = re.match(r"^([\d.]+)(m)?$", text)
    if not m:
        return None
    value = float(m.group(1))
    return value / 1000 if m.group(2) == "m" else value


def parse_memory(text: Optional[str]) -> Optional[int]:
    """'4095Mi' -> 4293918720, '4Gi' -> 4294967296"""
    if not text:
        return None
    m = re.match(r"^([\d.]+)(Ki|Mi|Gi|Ti)?$", text, re.IGNORECASE)
    if not m:
        return None
    value = float(m.group(1))
    unit = (m.group(2) or "").lower()
    if unit == "ki":
        return round(value * 1024)
    if unit == "mi":
        return round(value * 1024 * 1024)
    if unit == "gi":
        return round(value * 1024 ** 3)
    if unit == "ti":
        return round(value * 1024 ** 4)
    return round(value)


# -------------------- Pod 规整 --------------------


def infer_owner_deployment(pod: Any) -> Optional[str]:
    refs = getattr(getattr(pod, "metadata", None), "owner_references", None) or []
    rs_name = next((r.name for r in refs if getattr(r, "kind", None) == "ReplicaSet"), None)
    if not rs_name:
        return None
    parts = rs_name.split("-")
    if len(parts) <= 1:
        return rs_name
    return "-".join(parts[:-1])


def normalize_pod(pod: Any) -> dict[str, Any]:
    meta = pod.metadata
    status = pod.status
    container_statuses = getattr(status, "container_statuses", None) or []
    container_status = container_statuses[0] if container_statuses else None
    containers = getattr(getattr(pod.spec, "containers", None), "__iter__", None)
    container = next(iter(pod.spec.containers), None) if containers and pod.spec.containers else None

    phase = status.phase or "Unknown"
    derived = phase
    if container_status is not None:
        state = container_status.state
        waiting = getattr(state, "waiting", None) if state else None
        terminated = getattr(state, "terminated", None) if state else None
        if waiting is not None and waiting.reason:
            derived = waiting.reason
        elif terminated is not None and terminated.reason:
            derived = terminated.reason
        elif container_status.ready:
            derived = "Running"
    elif status.reason:
        derived = status.reason

    last_term = None
    if container_status is not None and container_status.last_state is not None:
        last_term = container_status.last_state.terminated

    running = None
    if container_status is not None and container_status.state is not None:
        running = container_status.state.running

    disruption = next((c for c in (status.conditions or []) if c.type == "DisruptionTarget"), None)

    resources = None
    if container is not None and container.resources is not None:
        resources = {
            "limits": container.resources.limits or {},
            "requests": container.resources.requests or {},
        }

    return {
        "name": meta.name,
        "namespace": meta.namespace,
        "status": derived,
        "restartCount": (container_status.restart_count if container_status else 0) or 0,
        "ready": bool(container_status.ready) if container_status else False,
        "podIp": status.pod_ip,
        "nodeName": pod.spec.node_name,
        "startedAt": _iso(running.started_at) if running is not None else None,
        "lastState": {
            "reason": (last_term.reason or "Unknown") if last_term else None,
            "exitCode": (last_term.exit_code if last_term and last_term.exit_code is not None else -1) if last_term else None,
            "finishedAt": _iso(last_term.finished_at) or "" if last_term else None,
            "startedAt": _iso(last_term.started_at) if last_term else None,
        }
        if last_term
        else None,
        "resources": resources,
        "containerName": container.name if container is not None else None,
        # 「启动后很快退出」的三类必要条件：钩子(postStart 失败会被 kubelet 杀掉并重启)、
        # 优雅终止窗口、初始化容器结果。缺了它们只能靠猜外部原因。
        "lifecycle": _container_lifecycle(container) if container is not None else {},
        "initContainers": _init_containers_summary(pod.spec) if pod.spec is not None else [],
        "terminationGracePeriodSeconds": getattr(pod.spec, "termination_grace_period_seconds", None),
        "uid": meta.uid,
        "reason": status.reason,
        "evictionMessage": disruption.message if disruption is not None else None,
        "ownerDeployment": infer_owner_deployment(pod),
    }


def is_abnormal_pod(pod: dict[str, Any]) -> bool:
    return pod["status"] != "Running" or pod["restartCount"] > 0


def _list_pods_sync(namespace: Optional[str], cluster: Optional[str] = None) -> list[dict[str, Any]]:
    api = _core(cluster)
    if namespace:
        res = api.list_namespaced_pod(namespace)
    else:
        res = api.list_pod_for_all_namespaces()
    return [normalize_pod(p) for p in res.items]


async def list_pods(namespace: Optional[str] = None, cluster: Optional[str] = None) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_list_pods_sync, namespace, cluster)


def _read_pod_sync(namespace: str, name: str, cluster: Optional[str] = None) -> Optional[dict[str, Any]]:
    try:
        return normalize_pod(_core(cluster).read_namespaced_pod(name, namespace))
    except ApiException as err:
        if err.status == 404:
            return None
        raise


async def read_pod(namespace: str, name: str, cluster: Optional[str] = None) -> Optional[dict[str, Any]]:
    return await asyncio.to_thread(_read_pod_sync, namespace, name, cluster)


def _list_events_sync(namespace: str, pod_name: str, cluster: Optional[str] = None) -> list[dict[str, Any]]:
    res = _core(cluster).list_namespaced_event(namespace, field_selector=f"involvedObject.name={pod_name}")
    events = [
        {
            "time": _iso(e.last_timestamp) or _iso(e.event_time) or "",
            "type": e.type or "Normal",
            "reason": e.reason or "",
            "message": e.message or "",
            "involvedObject": e.involved_object.name if e.involved_object else pod_name,
        }
        for e in res.items
    ]
    events.sort(key=lambda e: e["time"])
    return events


async def list_events_for_pod(namespace: str, pod_name: str, cluster: Optional[str] = None) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_list_events_sync, namespace, pod_name, cluster)


def _top_nodes_sync(cluster: Optional[str] = None) -> list[dict[str, Any]]:
    res = _custom(cluster).list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
    rows = []
    for item in res.get("items", []):
        usage = item.get("usage") or {}
        name = (item.get("metadata") or {}).get("name") or ""
        if name:
            rows.append({"name": name, "cpuCores": parse_cpu(usage.get("cpu")) or 0, "memoryBytes": parse_memory(usage.get("memory")) or 0})
    return rows


async def top_nodes(cluster: Optional[str] = None) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_top_nodes_sync, cluster)


def _get_node_sync(name: str, cluster: Optional[str] = None) -> dict[str, Any]:
    node = _core(cluster).read_node(name)
    return {
        "name": node.metadata.name,
        "capacity": node.status.capacity,
        "allocatable": node.status.allocatable,
        "conditions": [
            {"type": c.type, "status": c.status, "reason": c.reason, "message": c.message}
            for c in (node.status.conditions or [])
        ],
        "taints": [{"key": t.key, "effect": t.effect} for t in (node.spec.taints or [])],
    }


async def get_node(name: str, cluster: Optional[str] = None) -> dict[str, Any]:
    return await asyncio.to_thread(_get_node_sync, name, cluster)


def _top_pods_sync(namespace: Optional[str], cluster: Optional[str] = None) -> list[dict[str, Any]]:
    api = _core(cluster)
    if namespace:
        pods_res = api.list_namespaced_pod(namespace)
    else:
        pods_res = api.list_pod_for_all_namespaces()
    limit_by_key: dict[str, dict[str, Any]] = {}
    for p in pods_res.items:
        npod = normalize_pod(p)
        limit_by_key[f"{npod['namespace']}/{npod['name']}"] = npod.get("resources") or {}

    custom = _custom()
    if namespace:
        res = custom.list_namespaced_custom_object("metrics.k8s.io", "v1beta1", namespace, "pods")
    else:
        res = custom.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods")

    rows = []
    for item in res.get("items", []):
        meta = item.get("metadata") or {}
        ns = meta.get("namespace") or ""
        name = meta.get("name") or ""
        containers = item.get("containers") or [{}]
        usage = (containers[0] or {}).get("usage") or {}
        limits = (limit_by_key.get(f"{ns}/{name}") or {}).get("limits") or {}
        cpu_cores = parse_cpu(usage.get("cpu")) or 0
        memory_bytes = parse_memory(usage.get("memory")) or 0
        cpu_limit = parse_cpu(limits.get("cpu"))
        memory_limit = parse_memory(limits.get("memory"))
        if name:
            rows.append(
                {
                    "name": name,
                    "namespace": ns,
                    "cpuCores": cpu_cores,
                    "memoryBytes": memory_bytes,
                    "cpuLimit": cpu_limit,
                    "memoryLimit": memory_limit,
                    "memoryPercent": round(memory_bytes / memory_limit * 100) if memory_limit else None,
                }
            )
    return rows


async def top_pods(namespace: Optional[str] = None, cluster: Optional[str] = None) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_top_pods_sync, namespace, cluster)


# 探针里对诊断判断最关键的字段：探测方式/目标 + 时序与阈值
_PROBE_TIMING_KEYS = {
    "initial_delay_seconds": "initialDelaySeconds",
    "period_seconds": "periodSeconds",
    "timeout_seconds": "timeoutSeconds",
    "failure_threshold": "failureThreshold",
    "success_threshold": "successThreshold",
}


def _probe_summary(probe: Any) -> Optional[dict[str, Any]]:
    """把 V1Probe 压成诊断必需字段；未定义返回 None（"没探针"本身就是要看的信息）。"""
    if probe is None:
        return None
    summary: dict[str, Any] = {}
    handler: Optional[str] = None
    http = getattr(probe, "http_get", None)
    tcp = getattr(probe, "tcp_socket", None)
    # kubernetes python client 把 `exec` 字段映射成 `_exec`（exec 是保留字）
    ex = getattr(probe, "_exec", None) or getattr(probe, "exec", None)
    grpc = getattr(probe, "grpc", None)
    if http is not None:
        handler = "httpGet"
        # 对齐 kubectl describe 的写法：http://:8080/health（Pod IP 省略，端口在前）
        scheme = (http.scheme or "HTTP").lower()
        summary["target"] = f"{scheme}://:{http.port}{http.path or '/'}"
    elif tcp is not None:
        handler = "tcpSocket"
        summary["target"] = f"{tcp.host or 'pod'}:{tcp.port}"
    elif ex is not None:
        handler = "exec"
        summary["target"] = " ".join(ex.command or [])[:200]
    elif grpc is not None:
        handler = "grpc"
        summary["target"] = f"port {grpc.port}"
    summary["type"] = handler or "unknown"
    for attr, camel in _PROBE_TIMING_KEYS.items():
        value = getattr(probe, attr, None)
        if value is not None:
            summary[camel] = value
    return summary


def _hook_summary(hook: Any) -> str:
    """把 postStart/preStop 钩子压成一行命令（exec 优先，兼容客户端把 exec 映射成 _exec）。"""
    ex = getattr(hook, "_exec", None) or getattr(hook, "exec", None)
    if ex is not None:
        return " ".join(ex.command or [])[:300]
    http = getattr(hook, "http_get", None)
    if http is not None:
        return f"httpGet {(http.scheme or 'HTTP').lower()}://:{http.port}{http.path or '/'}"
    tcp = getattr(hook, "tcp_socket", None)
    if tcp is not None:
        return f"tcpSocket {tcp.host or 'pod'}:{tcp.port}"
    if getattr(hook, "sleep", None) is not None:
        return f"sleep {getattr(hook.sleep, 'seconds', '')}".strip()
    return "other"


def _container_lifecycle(container: Any) -> dict[str, Any]:
    """容器生命周期钩子。postStart 失败时 kubelet 会杀掉容器并重启 —— 是「启动后立即退出」的头号原因之一，
    而它既不在探针里、也不产生 Killing/Unhealthy 事件，必须随定义一起返回。"""
    lifecycle = getattr(container, "lifecycle", None)
    if lifecycle is None:
        return {}
    out: dict[str, Any] = {}
    post = getattr(lifecycle, "post_start", None)
    pre = getattr(lifecycle, "pre_stop", None)
    if post is not None:
        out["postStart"] = _hook_summary(post)
    if pre is not None:
        out["preStop"] = _hook_summary(pre)
    if getattr(lifecycle, "stop_signal", None):
        out["stopSignal"] = lifecycle.stop_signal
    return out


def _init_containers_summary(pod_spec: Any) -> list[dict[str, Any]]:
    rows = []
    for c in getattr(pod_spec, "init_containers", None) or []:
        rows.append({"name": c.name, "image": c.image, "lifecycle": _container_lifecycle(c)})
    return rows


def _container_probes(container: Any) -> dict[str, Any]:
    """只保留已定义的探针；空 dict 表示该容器未声明任何探针。"""
    probes = {
        "liveness": _probe_summary(getattr(container, "liveness_probe", None)),
        "readiness": _probe_summary(getattr(container, "readiness_probe", None)),
        "startup": _probe_summary(getattr(container, "startup_probe", None)),
    }
    return {kind: value for kind, value in probes.items() if value}


def _get_deployment_sync(namespace: str, name: str, cluster: Optional[str] = None) -> dict[str, Any]:
    deployment = _apps(cluster).read_namespaced_deployment(name, namespace)
    spec = deployment.spec
    template_spec = spec.template.spec
    containers = template_spec.containers or []
    volumes = template_spec.volumes or []
    return {
        "name": deployment.metadata.name,
        "namespace": deployment.metadata.namespace,
        "replicas": spec.replicas,
        "strategy": spec.strategy.type if spec.strategy else None,
        "selector": (spec.selector.match_labels or {}) if spec.selector else {},
        "containers": [
            {
                "name": c.name,
                "image": c.image,
                "imagePullPolicy": c.image_pull_policy,
                "resources": _model_dump(c.resources),
                "ports": [{"name": p.name, "containerPort": p.container_port, "protocol": p.protocol} for p in (c.ports or [])],
                "env": [
                    {
                        "name": e.name,
                        "from": (
                            (e.value_from.secret_key_ref.name if e.value_from.secret_key_ref else None)
                            or (e.value_from.config_map_key_ref.name if e.value_from.config_map_key_ref else None)
                            or "other"
                        )
                        if e.value_from
                        else "literal",
                    }
                    for e in (c.env or [])
                ],
                "volumeMounts": [{"name": v.name, "mountPath": v.mount_path} for v in (c.volume_mounts or [])],
                # 探针缺失/配置不当是 Pod 反复重启却看不到崩溃日志的常见根因，必须随定义返回
                "probes": _container_probes(c),
                # postStart 失败会被 kubelet 直接杀掉容器(表现为 exit 0 的优雅退出 + 原地重启)，
                # 空对象表示未声明钩子
                "lifecycle": _container_lifecycle(c),
            }
            for c in containers
        ],
        "volumes": [
            {
                "name": v.name,
                "type": (
                    "emptyDir"
                    if v.empty_dir
                    else "persistentVolumeClaim"
                    if v.persistent_volume_claim
                    else "configMap"
                    if v.config_map
                    else "secret"
                    if v.secret
                    else "hostPath"
                    if v.host_path
                    else "other"
                ),
                "pvcName": v.persistent_volume_claim.claim_name if v.persistent_volume_claim else None,
                # 宿主路径是「同一镜像在不同节点表现不同」的高频解释(宿主二进制/配置版本漂移)
                "hostPath": v.host_path.path if v.host_path else None,
            }
            for v in volumes
        ],
        "initContainers": _init_containers_summary(template_spec),
        "terminationGracePeriodSeconds": template_spec.termination_grace_period_seconds,
        "activeDeadlineSeconds": template_spec.active_deadline_seconds,
    }


def _model_dump(obj: Any) -> Any:
    if obj is None:
        return None
    sanitized = getattr(obj, "to_dict", None)
    return sanitized() if callable(sanitized) else obj


async def get_deployment(namespace: str, name: str, cluster: Optional[str] = None) -> dict[str, Any]:
    return await asyncio.to_thread(_get_deployment_sync, namespace, name, cluster)


def _exec_pod_command_sync(
    namespace: str, pod_name: str, command: str, container: Optional[str], cluster: Optional[str] = None
) -> str:
    kwargs: dict[str, Any] = {
        "stderr": True,
        "stdin": False,
        "stdout": True,
        "tty": False,
        "_request_timeout": 20,
    }
    if container:
        kwargs["container"] = container
    try:
        return k8s_stream(
            _core(cluster).connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            command=["sh", "-c", command],
            **kwargs,
        )
    except AttributeError as err:
        # 容器不可 exec 时 kubernetes 客户端会抛底层 AttributeError，对模型毫无信息量
        raise RuntimeError(
            f"exec 进入 {namespace}/{pod_name} 失败（容器可能未运行/未就绪）: {err}"
        ) from err


async def exec_blocked_reason(
    namespace: str, pod_name: str, container: Optional[str] = None, cluster: Optional[str] = None
) -> Optional[str]:
    """exec 前的前置校验：容器没在运行就不必进 stream。返回 None 表示可以 exec。"""
    try:
        pod = await read_pod(namespace, pod_name, cluster)
    except Exception:  # noqa: BLE001 - 校验失败不阻断，交给真正的调用去报错
        return None
    if pod is None:
        return f"Pod {namespace}/{pod_name} 不存在，无法 exec"
    if pod.get("status") != "Running" or not pod.get("ready"):
        return (
            f"Pod {namespace}/{pod_name} 当前 status={pod.get('status')}, ready={pod.get('ready')}, "
            f"restarts={pod.get('restartCount')}，容器未在运行，无法 exec。"
            "建议：用 k8s.describe_pod 查看 lastState/事件；容器日志改用 "
            "k8s.get_pod_logs(previous=true) 或 clickhouse.search_logs。"
        )
    return None


def parse_since_seconds(since: Any) -> Optional[int]:
    """把 '5m' / '1h' / '300s' 解析成秒；不识别时返回 None。"""
    match = re.match(r"^(\d+)([smhd])$", str(since or "").strip())
    if not match:
        return None
    return int(match.group(1)) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]


def _read_pod_logs_sync(
    namespace: str,
    name: str,
    container: Optional[str],
    tail_lines: int,
    previous: bool,
    since_seconds: Optional[int],
    cluster: Optional[str] = None,
) -> str:
    kwargs: dict[str, Any] = {"tail_lines": tail_lines}
    if container:
        kwargs["container"] = container
    if previous:
        kwargs["previous"] = True
    if since_seconds:
        kwargs["since_seconds"] = since_seconds
    return _core(cluster).read_namespaced_pod_log(name, namespace, **kwargs)


async def read_pod_logs(
    namespace: str,
    name: str,
    container: Optional[str] = None,
    tail_lines: int = 100,
    previous: bool = False,
    since_seconds: Optional[int] = None,
    cluster: Optional[str] = None,
) -> str:
    """读取 Pod 日志（K8s API，不依赖容器内的 kubectl）。"""
    return await asyncio.to_thread(
        _read_pod_logs_sync, namespace, name, container, tail_lines, previous, since_seconds, cluster
    )


async def exec_pod_command(
    namespace: str, pod_name: str, command: str, container: Optional[str] = None, cluster: Optional[str] = None
) -> str:
    return await asyncio.to_thread(_exec_pod_command_sync, namespace, pod_name, command, container, cluster)


def _patch_deployment_memory_limit_sync(
    namespace: str, name: str, container: str, memory_limit_mi: int, cluster: Optional[str] = None
) -> None:
    body = {
        "spec": {
            "template": {
                "spec": {"containers": [{"name": container, "resources": {"limits": {"memory": f"{memory_limit_mi}Mi"}}}]}
            }
        }
    }
    _apps(cluster).patch_namespaced_deployment(name, namespace, body)


async def patch_deployment_memory_limit(
    namespace: str, name: str, container: str, memory_limit_mi: int, cluster: Optional[str] = None
) -> None:
    await asyncio.to_thread(_patch_deployment_memory_limit_sync, namespace, name, container, memory_limit_mi, cluster)


def _delete_pod_sync(namespace: str, name: str, cluster: Optional[str] = None) -> None:
    try:
        _core(cluster).delete_namespaced_pod(name, namespace)
    except ApiException as err:
        if err.status != 404:
            raise


async def delete_pod(namespace: str, name: str, cluster: Optional[str] = None) -> None:
    await asyncio.to_thread(_delete_pod_sync, namespace, name, cluster)


# -------------------- ToolDefs --------------------


# 所有 k8s 工具统一携带的可选参数：目标集群（远端接入后用于选择目标环境）
CLUSTER_PROP: dict[str, Any] = {
    "type": "string",
    "description": "目标 K8s 集群的 id 或名称；省略则使用默认集群。排查「本地集群」时必须显式传 \"local\"（进程内 kubeconfig），未登记任何集群时 local 即默认。可先用 list_clusters 查看可用集群。",
}


def _tool(
    name: str,
    risk: str,
    description: str,
    properties: dict[str, Any],
    required: list[str],
    *,
    cluster_aware: bool = True,
) -> ToolDef:
    props = dict(properties)
    if cluster_aware:
        props["cluster"] = CLUSTER_PROP
    return ToolDef(
        name=name,
        skill="k8s",
        risk=risk,  # type: ignore[arg-type]
        description=description,
        parameters={"type": "object", "properties": props, "required": required, "additionalProperties": False},
    )


TOOLS: list[ToolDef] = [
    _tool(
        "list_clusters",
        "readonly",
        "列出已接入的 K8s 集群(id/名称/apiserver 地址/是否默认/是否启用)。多集群环境下应先调用本工具确认目标集群, 再在其它 k8s 工具里通过 cluster 参数指定; 返回空列表表示当前使用进程内本地集群。",
        {},
        [],
        cluster_aware=False,
    ),
    _tool(
        "list_pods",
        "readonly",
        "列出 Pod 并返回汇总式结果: summary 计数在最前(total/running/abnormal + 按状态聚合 byReason, 可区分 Evicted/Error/OOMKilled/CrashLoopBackOff + byNode 按节点聚合各节点的 running/abnormal/restarts), running 显式列出健康副本, pods 为最多15条按时间倒序的异常样本。用于确认服务是否可用、定位异常目标; 判断异常是否集中在个别节点(节点间差异)时优先看 summary.byNode。",
        {
            "namespace": {"type": "string", "description": "可选,留空表示查询所有命名空间"},
            "all": {"type": "boolean", "description": "兼容参数(历史调用保留); 无论取值, 本工具始终返回汇总 + running 列表 + 异常样本"},
        },
        [],
    ),
    _tool(
        "top_pods",
        "readonly",
        "读取 Pod 实时 CPU/内存用量(等价 kubectl top pod), 并对比容器 resources.limits 计算百分比; 用于判断 OOM/资源耗尽类问题",
        {"namespace": {"type": "string", "description": "可选,留空表示所有命名空间"}},
        [],
    ),
    _tool(
        "get_deployment",
        "readonly",
        "读取 Deployment 完整定义(等价 kubectl get deployment -o yaml, 已脱敏: env 只返回名称与来源不含密钥值), "
        "包含 replicas/strategy/resources/volumes(type/PVC/hostPath 宿主路径)/env 名称/initContainers/"
        "terminationGracePeriodSeconds, 以及每个容器的 liveness/readiness/startup "
        "探针(类型/路径或端口/initialDelaySeconds/periodSeconds/failureThreshold)与 lifecycle 钩子(postStart/preStop/stopSignal)。"
        "未声明探针或钩子时对应字段为空对象。hostPath 用于判断「同一镜像在不同节点表现不同」的宿主环境差异(如宿主二进制版本漂移)。",
        {"namespace": {"type": "string"}, "deployment_name": {"type": "string"}},
        ["namespace", "deployment_name"],
    ),
    _tool(
        "get_pod_memory",
        "readonly",
        "进入目标 Pod 读取 cgroup 内存构成(memory.current/max 与 anon/file/slab), 用于区分 JVM 堆、页缓存与 slab 谁占用了内存限额",
        {
            "namespace": {"type": "string"},
            "pod_name": {"type": "string"},
            "container": {"type": "string", "description": "可选,单容器Pod可省略"},
        },
        ["namespace", "pod_name"],
    ),
    _tool(
        "get_pod_processes",
        "readonly",
        "进入目标 Pod 查看进程列表(等价 kubectl exec -- ps -ef), 用于读取 JVM 启动参数(-Xmx等)与运行时长",
        {
            "namespace": {"type": "string"},
            "pod_name": {"type": "string"},
            "container": {"type": "string", "description": "可选,单容器Pod可省略"},
        },
        ["namespace", "pod_name"],
    ),
    _tool(
        "top_nodes",
        "readonly",
        "读取所有节点 CPU/内存用量（等价 kubectl top node），用于判断节点级资源压力与 Pod 被驱逐(Evicted)的来源",
        {},
        [],
    ),
    _tool(
        "get_node",
        "readonly",
        "读取节点详情：capacity/allocatable(内存/CPU)、conditions(含 MemoryPressure/DiskPressure)、taints；用于判断驱逐阈值与调度约束",
        {"node_name": {"type": "string"}},
        ["node_name"],
    ),
    _tool(
        "get_pod_status",
        "readonly",
        "获取Pod当前状态摘要(等价于 kubectl get pod)",
        {"namespace": {"type": "string"}, "pod_name": {"type": "string"}},
        ["namespace", "pod_name"],
    ),
    _tool(
        "describe_pod",
        "readonly",
        "获取Pod详细信息与事件(等价于 kubectl describe pod), 包含 restartCount / lastState(OOMKilled等) / resources.limits / events, "
        "以及 lifecycle(postStart/preStop 钩子)、initContainers、terminationGracePeriodSeconds。"
        "排查「容器启动后很快退出/原地反复重启」时必须先看 lifecycle：postStart 执行失败时 kubelet 会杀掉容器并重启，"
        "表现为 exit code 0 的优雅退出、事件只有 BackOff、且看不到探针失败。",
        {"namespace": {"type": "string"}, "pod_name": {"type": "string"}},
        ["namespace", "pod_name"],
    ),
    _tool(
        "get_pod_logs",
        "readonly",
        "读取 Pod 容器日志（K8s API，无需容器内 kubectl）。排查看日志时优先用本工具，"
        "而非 linux.get_pod_logs（后者依赖服务端 kubectl）。previous=true 可读上一个已终止实例的日志，"
        "对 CrashLoopBackOff 尤其有用。",
        {
            "namespace": {"type": "string"},
            "pod_name": {"type": "string"},
            "container": {"type": "string", "description": "可选,多容器 Pod 需指定"},
            "tail_lines": {"type": "number", "description": "返回最近 N 行，默认 100"},
            "previous": {"type": "boolean", "description": "读上一个容器实例的日志（CrashLoopBackOff 场景）"},
            "since": {"type": "string", "description": "例如 '5m' / '1h'"},
        },
        ["namespace", "pod_name"],
    ),
    _tool(
        "get_events",
        "readonly",
        "获取该Pod的近期事件列表(等价于 kubectl get events --field-selector involvedObject.name=xxx)",
        {"namespace": {"type": "string"}, "pod_name": {"type": "string"}},
        ["namespace", "pod_name"],
    ),
    _tool(
        "patch_resource_limits",
        "high",
        "调整Deployment的资源limits(如memory), 属于变更操作, 需人工审批。执行后会触发滚动重启(等价于 kubectl patch deployment ... --type=strategic)。",
        {
            "namespace": {"type": "string"},
            "deployment_name": {"type": "string"},
            "container_name": {"type": "string", "description": "容器名, 通常与deployment主容器同名"},
            "memory_limit_mi": {"type": "number", "description": "新的内存limit,单位Mi,例如512"},
        },
        ["namespace", "deployment_name", "container_name", "memory_limit_mi"],
    ),
    _tool(
        "delete_pod",
        "high",
        "删除指定 Pod(等价于 kubectl delete pod)。用于让卡死/长期 CrashLoopBackOff/不可调度的副本被控制器立即重建"
        "(Deployment/ReplicaSet/StatefulSet 管理的 Pod 会重建, 裸 Pod 删除后不会回来)。"
        "会短暂减少可用副本，属变更操作需人工审批；请先说明为什么重建能解决问题(例如副本被钉在某个异常节点/宿主环境)。",
        {"namespace": {"type": "string"}, "pod_name": {"type": "string"}},
        ["namespace", "pod_name"],
    ),
]


def _count_by(values: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return out


def _ms(start: float) -> int:
    return int((time.time() - start) * 1000)


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    """工具入口：执行后统一标注实际命中的集群，便于证据链与审计定位来源。"""
    result = await _execute_tool(tool, args)
    if result.success and isinstance(result.data, dict) and "cluster" not in result.data:
        result.data["cluster"] = k8s_clusters.resolve_id(args.get("cluster"))
    return result


async def _execute_tool(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    start = time.time()
    cluster = args.get("cluster") or None
    try:
        if tool == "list_clusters":
            return ToolExecutionResult(
                success=True,
                data={
                    "clusters": [
                        {
                            "id": c.get("id"),
                            "name": c.get("name"),
                            "server": c.get("server"),
                            "enabled": c.get("enabled", True),
                            "isDefault": bool(c.get("isDefault")),
                            "isLocal": bool(c.get("isLocal")),
                        }
                        for c in k8s_clusters.list_targets()
                    ],
                    "defaultCluster": (
                        (k8s_clusters.default_cluster() or {}).get("id") or k8s_clusters.LOCAL_CLUSTER_ID
                    ),
                    "localFallback": not k8s_clusters.list_clusters(public=True),
                },
                durationMs=_ms(start),
            )

        if tool == "list_pods":
            pods = await list_pods(args.get("namespace"), cluster)
            now_ms = time.time() * 1000

            def decorate(p: dict[str, Any]) -> dict[str, Any]:
                started = p.get("startedAt")
                return {
                    "name": p["name"],
                    "namespace": p["namespace"],
                    "status": p["status"],
                    "reason": p.get("reason"),
                    "restarts": p["restartCount"],
                    "ready": p["ready"],
                    "startedAt": started,
                    "ageSeconds": max(0, round((now_ms - _parse_ms(started)) / 1000)) if started else None,
                    "nodeName": p.get("nodeName"),
                    "podIp": p.get("podIp"),
                    "ownerDeployment": p.get("ownerDeployment"),
                }

            running = [decorate(p) for p in pods if p["status"] == "Running" and p["ready"]][:10]
            abnormal = [p for p in pods if is_abnormal_pod(p)]
            by_reason = _count_by([p.get("status") or p.get("reason") or "Unknown" for p in abnormal])
            by_node: dict[str, dict[str, int]] = {}
            for p in pods:
                node = p.get("nodeName") or "未调度"
                entry = by_node.setdefault(node, {"total": 0, "running": 0, "abnormal": 0, "restarts": 0})
                entry["total"] += 1
                if p["status"] == "Running" and p["ready"]:
                    entry["running"] += 1
                if is_abnormal_pod(p):
                    entry["abnormal"] += 1
                entry["restarts"] += int(p.get("restartCount") or 0)
            abnormal_sorted = sorted(abnormal, key=lambda p: _parse_ms(p.get("startedAt")), reverse=True)
            samples = [decorate(p) for p in abnormal_sorted[:15]]
            return ToolExecutionResult(
                success=True,
                data={
                    "summary": {
                        "total": len(pods),
                        "running": len(running),
                        "abnormal": len(abnormal),
                        "byReason": by_reason,
                        "byNode": by_node,
                    },
                    "running": running,
                    "pods": samples,
                    "truncated": len(abnormal) > 15,
                },
                durationMs=_ms(start),
            )

        if tool == "top_pods":
            rows = await top_pods(args.get("namespace"), cluster)
            return ToolExecutionResult(success=True, data={"pods": rows}, durationMs=_ms(start))

        if tool == "top_nodes":
            rows = await top_nodes(cluster)
            return ToolExecutionResult(success=True, data={"nodes": rows}, durationMs=_ms(start))

        if tool == "get_node":
            node = await get_node(str(args.get("node_name")), cluster)
            return ToolExecutionResult(success=True, data={"node": node}, durationMs=_ms(start))

        if tool == "get_deployment":
            deployment = await get_deployment(str(args.get("namespace")), str(args.get("deployment_name")), cluster)
            return ToolExecutionResult(success=True, data={"deployment": deployment}, durationMs=_ms(start))

        if tool == "get_pod_memory":
            raw = await exec_pod_command(
                str(args.get("namespace")),
                str(args.get("pod_name")),
                "cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.max; "
                "grep -E '^(anon|file|slab|kernel)' /sys/fs/cgroup/memory.stat",
                args.get("container"),
                cluster,
            )
            numbers = [int(n) for n in re.findall(r"\d+", raw)]
            numbers += [0] * (5 - len(numbers))
            return ToolExecutionResult(
                success=True,
                data={
                    "currentBytes": numbers[0],
                    "maxBytes": numbers[1],
                    "anonBytes": numbers[2],
                    "fileBytes": numbers[3],
                    "slabBytes": numbers[4],
                    "currentMi": round(numbers[0] / 1024 / 1024) if numbers[0] else None,
                    "maxMi": round(numbers[1] / 1024 / 1024) if numbers[1] else None,
                    "raw": raw,
                },
                durationMs=_ms(start),
            )

        if tool == "get_pod_processes":
            namespace, pod_name = str(args.get("namespace")), str(args.get("pod_name"))
            blocked = await exec_blocked_reason(namespace, pod_name, args.get("container"), cluster)
            if blocked:
                return ToolExecutionResult(success=False, error=blocked, durationMs=_ms(start))
            raw = await exec_pod_command(
                namespace,
                pod_name,
                "ps -ef --no-headers | head -30",
                args.get("container"),
                cluster,
            )
            return ToolExecutionResult(
                success=True,
                data={"processes": [line for line in raw.split("\n") if line.strip()]},
                durationMs=_ms(start),
            )

        if tool == "get_pod_status":
            namespace, pod_name = str(args.get("namespace")), str(args.get("pod_name"))
            pod = await read_pod(namespace, pod_name, cluster)
            if pod is None:
                return ToolExecutionResult(success=False, error=f"Pod {namespace}/{pod_name} 不存在", durationMs=_ms(start))
            return ToolExecutionResult(
                success=True,
                data={
                    "name": pod["name"],
                    "namespace": pod["namespace"],
                    "status": pod["status"],
                    "restarts": pod["restartCount"],
                    "ready": pod["ready"],
                },
                durationMs=_ms(start),
            )

        if tool == "describe_pod":
            namespace, pod_name = str(args.get("namespace")), str(args.get("pod_name"))
            pod = await read_pod(namespace, pod_name, cluster)
            if pod is None:
                return ToolExecutionResult(success=False, error=f"Pod {namespace}/{pod_name} 不存在", durationMs=_ms(start))
            events = await list_events_for_pod(namespace, pod_name, cluster)
            return ToolExecutionResult(
                success=True,
                data={
                    "name": pod["name"],
                    "namespace": pod["namespace"],
                    "status": pod["status"],
                    "restartCount": pod["restartCount"],
                    "lastState": pod["lastState"],
                    "resources": pod["resources"],
                    "nodeName": pod["nodeName"],
                    "podIp": pod["podIp"],
                    "containerName": pod["containerName"],
                    "ownerDeployment": pod["ownerDeployment"],
                    "startedAt": pod["startedAt"],
                    "lifecycle": pod.get("lifecycle") or {},
                    "initContainers": pod.get("initContainers") or [],
                    "terminationGracePeriodSeconds": pod.get("terminationGracePeriodSeconds"),
                    "events": events[-10:],
                },
                durationMs=_ms(start),
            )

        if tool == "delete_pod":
            namespace, name = str(args.get("namespace")), str(args.get("pod_name"))
            await delete_pod(namespace, name, cluster)
            return ToolExecutionResult(
                success=True,
                data={
                    "deleted": f"{namespace}/{name}",
                    "note": "Pod 已删除；若由 Deployment/ReplicaSet 管理，控制器会立即重建(可能落在其它节点)。",
                },
                durationMs=_ms(start),
            )

        if tool == "get_pod_logs":
            namespace, name = str(args.get("namespace")), str(args.get("pod_name"))
            logs = await read_pod_logs(
                namespace,
                name,
                container=args.get("container"),
                tail_lines=int(args.get("tail_lines") or 100),
                previous=bool(args.get("previous")),
                since_seconds=parse_since_seconds(args.get("since")),
                cluster=cluster,
            )
            return ToolExecutionResult(
                success=True,
                data={
                    "pod": name,
                    "namespace": namespace,
                    "previous": bool(args.get("previous")),
                    "lines": len(logs.splitlines()),
                    "log": logs[-8000:],
                },
                durationMs=_ms(start),
            )

        if tool == "get_events":
            events = await list_events_for_pod(str(args.get("namespace")), str(args.get("pod_name")), cluster)
            return ToolExecutionResult(success=True, data={"events": events}, durationMs=_ms(start))

        if tool == "patch_resource_limits":
            namespace = str(args.get("namespace"))
            deployment = str(args.get("deployment_name"))
            container = str(args.get("container_name"))
            limit_mi = int(args.get("memory_limit_mi"))
            await patch_deployment_memory_limit(namespace, deployment, container, limit_mi, cluster)
            return ToolExecutionResult(
                success=True,
                data={
                    "message": f"已通过 K8s API 将 {namespace}/{deployment} 的 memory limit 调整为 {limit_mi}Mi, 已触发滚动重启",
                    "new_limit_mi": limit_mi,
                },
                durationMs=_ms(start),
            )

        return ToolExecutionResult(success=False, error=f"未知的k8s工具: {tool}", durationMs=_ms(start))
    except Exception as err:  # noqa: BLE001
        return ToolExecutionResult(success=False, error=f"K8s API 调用失败: {err}", durationMs=_ms(start))


def _parse_ms(iso: Optional[str]) -> float:
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return 0.0
