"""服务健康总览 —— 从真实 Prometheus(kube-state-metrics) 聚合，替代前端写死的 demo 卡片。

数据口径：
- 可用副本 `kube_deployment_status_replicas_available`
- 期望副本 `kube_deployment_spec_replicas`
- 迷你趋势：最近 30 分钟可用副本区间查询（缺失时退化为单点）

健康判定：avail<=0 且 spec>0 => err；avail<spec => warn；否则 ok。降级优先排序，最多返回 limit 个。
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx

from .config_store import get_default_prometheus_backend
from .skills import prom

DEFAULT_LIMIT = 8
_SPARK_SECONDS = 1800
_SPARK_STEP = 300
_STATUS_ORDER = {"err": 0, "warn": 1, "ok": 2}
# 服务健康查询专用超时（读 30s，容忍 Prometheus 抖动）
_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)
# 短缓存：同一页面的多次加载/刷新合并，避免连续打 Prometheus
_CACHE_TTL = 20.0
_CACHE_LOCK = threading.Lock()
_CACHE: dict[str, Any] = {"at": 0.0, "services": [], "total": 0}


def _pod_key(metric: dict[str, Any]) -> tuple[str, str] | None:
    namespace = metric.get("namespace")
    deployment = metric.get("deployment")
    if not namespace or not deployment:
        return None
    return str(namespace), str(deployment)


def _value_map(result: dict[str, Any]) -> dict[tuple[str, str], float]:
    out: dict[tuple[str, str], float] = {}
    for sample in result.get("samples") or []:
        key = _pod_key(sample.get("metric") or {})
        value = sample.get("value") or []
        if key is None or len(value) < 2:
            continue
        try:
            out[key] = float(value[1])
        except (TypeError, ValueError):
            continue
    return out


def _series_map(result: dict[str, Any]) -> dict[tuple[str, str], list[float]]:
    out: dict[tuple[str, str], list[float]] = {}
    if result.get("resultType") != "matrix":
        return out
    for sample in result.get("samples") or []:
        key = _pod_key(sample.get("metric") or {})
        if key is None:
            continue
        points = [float(v) for _, v in (sample.get("values") or [])]
        if points:
            out[key] = points
    return out


def _status(available: float, spec: float) -> str:
    if spec <= 0:
        return "ok"
    if available <= 0:
        return "err"
    if available < spec:
        return "warn"
    return "ok"


def _fmt(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def compose_service_health(
    available: dict[tuple[str, str], float],
    spec: dict[tuple[str, str], float],
    series: dict[tuple[str, str], list[float]] | None = None,
    limit: int = DEFAULT_LIMIT,
) -> list[dict[str, Any]]:
    """把 Prometheus 向量/区间结果组合成前端 HealthGrid 需要的卡片数据（纯函数）。"""
    series = series or {}
    cards: list[dict[str, Any]] = []
    for (namespace, deployment), desired in spec.items():
        if desired is None:
            continue
        current = available.get((namespace, deployment), 0.0)
        status = _status(current, desired)
        chart = series.get((namespace, deployment)) or [current, current]
        cards.append(
            {
                "name": deployment,
                "namespace": namespace,
                "meta": f"{namespace} · {_fmt(current)}/{_fmt(desired)} 副本",
                "status": status,
                "metricLabel": "可用副本",
                "metricValue": f"{_fmt(current)}/{_fmt(desired)}",
                "chart": chart,
            }
        )
    cards.sort(key=lambda c: (_STATUS_ORDER.get(c["status"], 9), c["name"]))
    return cards[: max(1, limit)]


def collect_service_health(limit: int = DEFAULT_LIMIT, *, force: bool = False) -> dict[str, Any]:
    """查询真实 Prometheus 并返回 {services, source, error, total}。

    - 20s 短缓存，避免页面连续刷新重复查询
    - 三个查询并发执行，整体耗时约等于最慢的一个
    - 查询失败时回退到上一次成功结果（stale=True），而不是空列表 + 报错
    """
    now = time.time()
    with _CACHE_LOCK:
        if not force and _CACHE["services"] and now - _CACHE["at"] < _CACHE_TTL:
            return {
                "services": _CACHE["services"],
                "source": "prometheus",
                "error": None,
                "total": _CACHE["total"],
                "cached": True,
            }

    backend = get_default_prometheus_backend()
    if not backend:
        return {"services": [], "source": "none", "error": "未配置 Prometheus 数据源", "total": 0}

    end = int(time.time())
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_available = pool.submit(
            prom.prom_instant_query, backend, "kube_deployment_status_replicas_available", None, _TIMEOUT
        )
        f_spec = pool.submit(prom.prom_instant_query, backend, "kube_deployment_spec_replicas", None, _TIMEOUT)
        f_range = pool.submit(
            prom.prom_range_query,
            backend,
            "kube_deployment_status_replicas_available",
            str(end - _SPARK_SECONDS),
            str(end),
            str(_SPARK_STEP),
            _TIMEOUT,
        )
        try:
            available = _value_map(f_available.result())
            spec = _value_map(f_spec.result())
        except Exception as err:  # noqa: BLE001 - 数据源异常时展示错误态/陈旧数据
            with _CACHE_LOCK:
                if _CACHE["services"]:
                    return {
                        "services": _CACHE["services"],
                        "source": "prometheus",
                        "error": str(err),
                        "total": _CACHE["total"],
                        "stale": True,
                    }
            return {"services": [], "source": "prometheus", "error": str(err), "total": 0}
        try:
            series = _series_map(f_range.result())
        except Exception:  # noqa: BLE001 - 迷你趋势失败不影响健康判定
            series = {}

    services = compose_service_health(available, spec, series, limit=limit)
    with _CACHE_LOCK:
        _CACHE.update(at=time.time(), services=services, total=len(spec))
    return {"services": services, "source": "prometheus", "error": None, "total": len(spec)}
