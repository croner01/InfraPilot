"""Prometheus Skill —— 对应 `server/src/skills/prometheus/{tools,client}.ts`。

数据源为 runtime-config 的 metricSystems，未配置时回退 `PROMETHEUS_URL`
（默认 http://127.0.0.1:9090）。只读指标查询，用于把日志现象与指标曲线交叉验证。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Optional

import httpx

from ..config_store import get_default_prometheus_backend
from ..models import ToolDef, ToolExecutionResult
from ..redact import redact

_WINDOW_RE = re.compile(r"^(\d+)([smhd])$")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _resolve_backend() -> dict[str, Any]:
    backend = get_default_prometheus_backend()
    if backend:
        return backend
    return {
        "id": "env-prometheus",
        "type": "prometheus",
        "name": "Prometheus (env)",
        "enabled": True,
        "url": os.environ.get("PROMETHEUS_URL") or "http://127.0.0.1:9090",
    }


def _window_to_range(window: str, step: str) -> dict[str, str]:
    match = _WINDOW_RE.match(window.strip())
    seconds = 3600
    if match:
        seconds = int(match.group(1)) * _UNIT_SECONDS.get(match.group(2), 3600)
    end = int(time.time())
    return {"start": str(end - seconds), "end": str(end), "step": step}


def _resolve_headers(backend: dict[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = dict(backend.get("headers") or {})
    for key, env_name in (backend.get("headerEnv") or {}).items():
        if os.environ.get(env_name):
            headers[key] = os.environ[env_name]
    return headers


# 默认超时：连接 5s / 读 30s。Prometheus 偶发抖动时 15s 会误报 timed out。
_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)


def _prom_request(
    backend: dict[str, Any],
    api_path: str,
    params: dict[str, str],
    timeout: Any = None,
) -> Any:
    base = backend["url"]
    url = f"{base.rstrip('/')}/{api_path.lstrip('/')}"
    headers = {"Accept": "application/json", **_resolve_headers(backend)}
    with httpx.Client(timeout=timeout or _DEFAULT_TIMEOUT) as client:
        response = client.get(url, params=params, headers=headers)
    if response.status_code >= 400:
        raise RuntimeError(f"Prometheus API {response.status_code}: {response.text[:300]}")
    body = response.json()
    if body.get("status") != "success":
        raise RuntimeError(f"Prometheus 查询失败: {body.get('errorType') or ''} {body.get('error') or 'unknown error'}")
    return body.get("data")


def _to_query_result(data: Optional[dict[str, Any]]) -> dict[str, Any]:
    data = data or {}
    return {"resultType": data.get("resultType"), "samples": data.get("result") or []}


def prom_instant_query(
    backend: dict[str, Any], query: str, time_: Optional[str] = None, timeout: Any = None
) -> dict[str, Any]:
    params = {"query": query}
    if time_:
        params["time"] = time_
    return _to_query_result(_prom_request(backend, "api/v1/query", params, timeout))


def prom_range_query(
    backend: dict[str, Any], query: str, start: str, end: str, step: str, timeout: Any = None
) -> dict[str, Any]:
    return _to_query_result(
        _prom_request(backend, "api/v1/query_range", {"query": query, "start": start, "end": end, "step": step}, timeout)
    )


def prom_label_values(backend: dict[str, Any], label: str) -> list[str]:
    return _prom_request(backend, f"api/v1/label/{label}/values", {}) or []


def _format_instant(result: dict[str, Any]) -> str:
    samples = result.get("samples") or []
    if not samples:
        return "(空结果，无匹配时间序列)"
    lines = []
    for s in samples[:20]:
        metric = s.get("metric") or {}
        labels = ",".join(f"{k}={v}" for k, v in metric.items())
        value = s.get("value") or []
        lines.append(f"{metric.get('__name__', 'value')}{{{labels}}} = {value[1] if len(value) > 1 else '?'} @ {value[0] if value else '?'}")
    text = "\n".join(lines)
    if len(samples) > 20:
        text += f"\n... 共 {len(samples)} 条序列"
    return text


def _matrix_to_series(result: dict[str, Any], max_series: int = 8) -> list[dict[str, Any]]:
    if result.get("resultType") != "matrix":
        return []
    out = []
    for s in (result.get("samples") or [])[:max_series]:
        metric = s.get("metric") or {}
        label = ",".join(f"{k}={v}" for k, v in metric.items() if k != "__name__")
        base = metric.get("__name__") or "value"
        name = f"{base}{{{label}}}" if label else base
        points = [[t * 1000, float(v)] for t, v in (s.get("values") or [])]
        out.append({"name": name, "points": points})
    return out


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> ToolDef:
    return ToolDef(
        name=name,
        skill="prom",
        risk="readonly",
        description=description,
        parameters={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    )


TOOLS: list[ToolDef] = [
    _tool(
        "instant_query",
        "执行 PromQL 瞬时查询，返回当前时刻各时间序列的值。用于查看当前资源水位，如 CPU 使用率、内存占用、错误率等。"
        "注意：裸累计计数(如 kube_pod_container_status_restarts_total、*_total 总量)只代表历史累计，"
        "不能说明「现在仍在发生」；要判断当下是否仍有扰动，请用带时间窗的函数，如 increase(x[1h]) / rate(x[5m]) / changes(x[1h])。",
        {"query": {"type": "string", "description": "PromQL 表达式，如 node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes"}},
        ["query"],
    ),
    _tool(
        "range_query",
        "执行 PromQL 区间查询，返回最近时间窗口内的指标曲线，用于观察趋势与突变（如 OOM 前内存斜率、QPS 下跌）。",
        {
            "query": {"type": "string", "description": "PromQL 表达式，如 rate(http_requests_total[5m])"},
            "window": {"type": "string", "description": "回看时间窗口，如 30m / 1h / 6h，默认 1h"},
            "step": {"type": "string", "description": "采样步长，如 15s / 1m / 5m，默认 1m"},
        },
        ["query"],
    ),
    _tool(
        "label_values",
        "获取指定 label 的所有取值，用于发现可查询的服务/实例维度，如 label=job 或 label=__name__。",
        {"label": {"type": "string", "description": "label 名称，如 job / instance / __name__"}},
        ["label"],
    ),
]


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    backend = _resolve_backend()
    try:
        if tool == "instant_query":
            result = prom_instant_query(backend, str(args.get("query") or ""))
            data = {
                "resultType": result["resultType"],
                "text": _format_instant(result),
                "series": (result["samples"] or [])[:10],
            }
        elif tool == "range_query":
            rng = _window_to_range(str(args.get("window") or "1h"), str(args.get("step") or "1m"))
            result = prom_range_query(backend, str(args.get("query") or ""), rng["start"], rng["end"], rng["step"])
            series = _matrix_to_series(result, 10)
            text = (
                "\n".join(
                    f"{s['name']}: {len(s['points'])} 点, 最新 {s['points'][-1][1] if s['points'] else '?'}" for s in series
                )
                or "(空结果)"
            )
            data = {"resultType": result["resultType"], "seriesCount": len(result["samples"] or []), "series": series, "text": text}
        elif tool == "label_values":
            values = prom_label_values(backend, str(args.get("label") or ""))
            data = {"label": args.get("label"), "values": values[:100], "total": len(values)}
        else:
            return ToolExecutionResult(success=False, error=f"unknown prometheus tool: {tool}", durationMs=_ms(started))
        return ToolExecutionResult(success=True, data=json.loads(redact(json.dumps(data, ensure_ascii=False))), durationMs=_ms(started))
    except Exception as err:  # noqa: BLE001 - 契约要求把异常转成 error 文本
        return ToolExecutionResult(success=False, error=str(err), durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)
