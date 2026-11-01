"""演示场景适配 + 告警播种 —— 对应 `demo/realPodState.ts` + `demo/seedAlerts.ts`。"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from . import db
from .skills import k8s as k8s_skill

NAMESPACE = "order-service"
DEPLOYMENT = "order-api"
CONTAINER = "order-api"


async def _read_current_rss_mb(pod_name: str) -> int:
    try:
        proc = await asyncio.create_subprocess_exec(
            "sudo",
            "crictl",
            "stats",
            "-o",
            "json",
            "--pod",
            pod_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3)
        parsed = json.loads(stdout.decode("utf-8", "replace"))
        stat = (parsed.get("stats") or [{}])[0]
        bytes_value = int(((stat.get("memory") or {}).get("workingSetBytes") or {}).get("value") or 0)
        return round(bytes_value / 1024 / 1024) if bytes_value > 0 else 0
    except Exception:  # noqa: BLE001 - 容器已退出/重启窗口期读不到，返回 0 不影响主状态
        return 0


async def get_real_pod_state() -> Optional[dict[str, Any]]:
    pods = await k8s_skill.list_pods(NAMESPACE)
    pod = next((p for p in pods if p["name"].startswith(DEPLOYMENT)), None)
    if pod is None:
        return None

    raw_events = await k8s_skill.list_events_for_pod(NAMESPACE, pod["name"])
    events = [
        {"time": e["time"], "type": "Warning" if e["type"] == "Warning" else "Normal", "reason": e["reason"], "message": e["message"]}
        for e in raw_events[-10:]
    ]

    limit_str = ((pod.get("resources") or {}).get("limits") or {}).get("memory") or ""
    if limit_str.endswith("Mi"):
        limit_mb = float(limit_str.replace("Mi", ""))
    elif limit_str.endswith("Gi"):
        limit_mb = float(limit_str.replace("Gi", "")) * 1024
    else:
        limit_mb = 0

    current_rss_mb = await _read_current_rss_mb(pod["name"])
    last_state = pod.get("lastState")
    return {
        "podName": pod["name"],
        "namespace": pod["namespace"],
        "status": pod["status"],
        "restartCount": pod["restartCount"],
        "startedAt": pod.get("startedAt"),
        "lastState": (
            {"reason": last_state["reason"], "exitCode": last_state["exitCode"], "finishedAt": last_state["finishedAt"]}
            if last_state
            else None
        ),
        "resources": {"limitsMemoryMb": limit_mb},
        "events": events,
        "currentRssMb": current_rss_mb,
    }


async def reset_real_demo_scenario(limit_mb: int = 200) -> None:
    await k8s_skill.patch_deployment_memory_limit(NAMESPACE, DEPLOYMENT, CONTAINER, limit_mb)
    pods = await k8s_skill.list_pods(NAMESPACE)
    pod = next((p for p in pods if p["name"].startswith(DEPLOYMENT)), None)
    if pod is not None:
        await k8s_skill.delete_pod(NAMESPACE, pod["name"])


DEMO_ALERTS = [
    {
        "id": "alert-order-api-oom",
        "severity": "p0",
        "title": "order-api Pod CrashLoopBackOff",
        "source": "order-service/order-api · Prometheus",
        "service": "order-api",
        "status": "firing",
        "started_at": "2026-08-25T10:24:00Z",
    },
    {
        "id": "alert-payment-5xx",
        "severity": "p1",
        "title": "payment-service 5xx 上升",
        "source": "pay/payment-service · Prometheus",
        "service": "payment-service",
        "status": "firing",
        "started_at": "2026-08-25T10:02:00Z",
    },
    {
        "id": "alert-node08-disk",
        "severity": "p2",
        "title": "node-08 磁盘使用率 > 80%",
        "source": "k8s-node · node_exporter",
        "service": "node-08",
        "status": "acknowledged",
        "started_at": "2026-08-25T09:41:00Z",
    },
]


def seed_alerts() -> int:
    """幂等播种：表内已有数据时直接返回现有数量。"""
    existing = db.list_alerts()
    if existing:
        return len(existing)
    for alert in DEMO_ALERTS:
        db.insert_alert({**alert, "session_id": None})
    return len(DEMO_ALERTS)
