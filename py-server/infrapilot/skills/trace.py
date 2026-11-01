"""Trace Skill —— 分布式追踪数据源（Jaeger / Tempo），对应差距分析 P2。

提供只读工具：服务/操作枚举、按条件检索 trace、按 trace_id 拉取 span 树、服务依赖图。
后端地址来自 runtime-config 的 `traceSystems`，未配置时回退 JAEGER_URL / TEMPO_URL。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

import httpx

from ..config_store import get_default_trace_backend
from ..models import ToolDef, ToolExecutionResult
from ..redact import redact


def _resolve_backend() -> dict[str, Any]:
    backend = get_default_trace_backend()
    if backend:
        return backend
    legacy = {
        "id": "env-trace",
        "name": "Trace (env)",
        "enabled": True,
        "url": os.environ.get("JAEGER_URL") or os.environ.get("TEMPO_URL") or "http://127.0.0.1:16686",
        "type": "jaeger" if os.environ.get("JAEGER_URL") or not os.environ.get("TEMPO_URL") else "tempo",
    }
    return legacy


def _headers(backend: dict[str, Any]) -> dict[str, str]:
    headers = {"Accept": "application/json", **dict(backend.get("headers") or {})}
    for key, env_name in (backend.get("headerEnv") or {}).items():
        if os.environ.get(env_name):
            headers[key] = os.environ[env_name]
    return headers


def _request(backend: dict[str, Any], path: str, params: Optional[dict[str, Any]] = None) -> Any:
    url = f"{str(backend['url']).rstrip('/')}/{path.lstrip('/')}"
    with httpx.Client(timeout=15, verify=False) as client:
        response = client.get(url, params=params or {}, headers=_headers(backend))
    if response.status_code >= 400:
        raise RuntimeError(f"Trace API {response.status_code}: {response.text[:300]}")
    return response.json()


def _is_tempo(backend: dict[str, Any]) -> bool:
    return str(backend.get("type") or "").lower() in ("tempo", "grafana-tempo", "otlp", "skywalking")


# -------------------- 归一化 --------------------


def _status_of(tags: dict[str, Any]) -> str:
    if str(tags.get("otel.status_code") or "").upper() == "ERROR":
        return "error"
    if str(tags.get("error") or "").lower() == "true":
        return "error"
    if str(tags.get("http.status_code") or "").startswith("5"):
        return "error"
    return "ok"


def _norm_span(span: dict[str, Any], service: Optional[str] = None) -> dict[str, Any]:
    tags = {t.get("key"): t.get("value") for t in (span.get("tags") or []) if isinstance(t, dict)}
    process = span.get("process") or {}
    duration_us = int(span.get("duration") or 0)
    return {
        "spanId": span.get("spanID") or span.get("spanId"),
        "parentSpanId": span.get("parentSpanID") or span.get("parentSpanId") or None,
        "service": process.get("serviceName") or service or tags.get("service.name") or "unknown",
        "operation": span.get("operationName") or span.get("name") or "",
        "startTime": span.get("startTime"),
        "durationMs": round(duration_us / 1000, 3),
        "status": _status_of(tags),
        "tags": tags,
    }


def _flatten_tempo_batches(payload: dict[str, Any]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    for batch in payload.get("batches") or []:
        svc = ((batch.get("resource") or {}).get("attributes") or [])
        service_name = next((a.get("value", {}).get("stringValue") for a in svc if a.get("key") == "service.name"), None)
        for scope in batch.get("scopeSpans") or batch.get("instrumentationLibrarySpans") or []:
            for span in scope.get("spans") or []:
                spans.append(_norm_span(span, service_name))
    return spans


# -------------------- 工具实现 --------------------


def list_services(backend: dict[str, Any]) -> list[str]:
    if _is_tempo(backend):
        data = _request(backend, "api/v2/search/tags" if False else "api/search/tag/service.name/values")
        return sorted(data.get("tagValues") or data.get("data") or [])
    return sorted((_request(backend, "api/services").get("data") or []))


def list_operations(backend: dict[str, Any], service: str) -> list[str]:
    if _is_tempo(backend):
        data = _request(backend, f"api/search/tag/service.name/values")
        return sorted(data.get("tagValues") or [])
    return sorted((_request(backend, f"api/services/{service}/operations").get("data") or []))


def find_traces(
    backend: dict[str, Any],
    *,
    service: Optional[str] = None,
    operation: Optional[str] = None,
    start_us: Optional[int] = None,
    end_us: Optional[int] = None,
    min_duration_ms: Optional[int] = None,
    limit: int = 20,
    tags: Optional[dict[str, str]] = None,
) -> list[dict[str, Any]]:
    if _is_tempo(backend):
        query_parts = []
        if service:
            query_parts.append(f'resource.service.name="{service}"')
        if operation:
            query_parts.append(f'name="{operation}"')
        if min_duration_ms:
            query_parts.append(f"duration>{int(min_duration_ms)}ms")
        data = _request(
            backend,
            "api/search",
            {"q": " ".join(query_parts), "limit": limit, "start": start_us, "end": end_us},
        )
        out = []
        for t in data.get("traces") or []:
            out.append(
                {
                    "traceId": t.get("traceID"),
                    "rootService": t.get("rootServiceName"),
                    "rootOperation": t.get("rootTraceName"),
                    "startTime": t.get("startTimeUnixNano"),
                    "durationMs": round(int(t.get("durationMs") or 0), 3),
                }
            )
        return out

    params: dict[str, Any] = {"limit": limit}
    if service:
        params["service"] = service
    if operation:
        params["operation"] = operation
    if start_us:
        params["start"] = start_us
    if end_us:
        params["end"] = end_us
    if min_duration_ms:
        params["minDuration"] = f"{min_duration_ms}ms"
    if tags:
        params["tags"] = json.dumps(tags, ensure_ascii=False)
    data = _request(backend, "api/traces", params)
    out = []
    for trace in data.get("data") or []:
        spans = trace.get("spans") or []
        processes = trace.get("processes") or {}
        root = next((s for s in spans if not s.get("references")), spans[0] if spans else None)
        if not root:
            continue
        svc = (processes.get(root.get("processID")) or {}).get("serviceName")
        out.append(
            {
                "traceId": trace.get("traceID"),
                "rootService": svc,
                "rootOperation": root.get("operationName"),
                "startTime": root.get("startTime"),
                "durationMs": round(int(root.get("duration") or 0) / 1000, 3),
                "spanCount": len(spans),
            }
        )
    return out


def get_trace(backend: dict[str, Any], trace_id: str) -> dict[str, Any]:
    if _is_tempo(backend):
        payload = _request(backend, f"api/traces/{trace_id}")
        spans = _flatten_tempo_batches(payload)
        return {"traceId": trace_id, "spans": spans, "services": sorted({s["service"] for s in spans})}
    data = _request(backend, f"api/traces/{trace_id}")
    trace = (data.get("data") or [{}])[0] or {}
    processes = trace.get("processes") or {}
    spans = []
    for span in trace.get("spans") or []:
        svc = (processes.get(span.get("processID")) or {}).get("serviceName")
        refs = span.get("references") or []
        parent = next((r.get("spanID") for r in refs if r.get("refType") == "CHILD_OF"), None)
        normalized = _norm_span(span, svc)
        normalized["parentSpanId"] = parent
        spans.append(normalized)
    return {"traceId": trace_id, "spans": spans, "services": sorted({s["service"] for s in spans})}


def get_dependencies(backend: dict[str, Any], lookback_hours: int = 1) -> list[dict[str, Any]]:
    if _is_tempo(backend):
        data = _request(backend, "api/dependencies", {"start": None, "end": None})
    else:
        end_ts = int(time.time() * 1000)
        data = _request(backend, "api/dependencies", {"endTs": end_ts, "lookback": lookback_hours * 3600 * 1000})
    return [
        {"parent": d.get("parent"), "child": d.get("child"), "callCount": d.get("callCount")}
        for d in (data.get("data") or [])
    ]


# -------------------- ToolDefs --------------------


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> ToolDef:
    return ToolDef(
        name=name,
        skill="trace",
        risk="readonly",
        description=description,
        parameters={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    )


TOOLS: list[ToolDef] = [
    _tool("list_services", "列出追踪后端中的服务名列表，用于发现可检索的服务维度。", {}, []),
    _tool(
        "list_operations",
        "列出指定服务下的操作(span operationName)候选值。",
        {"service": {"type": "string", "description": "服务名，来自 list_services"}},
        ["service"],
    ),
    _tool(
        "find_traces",
        "按服务/操作/时间窗口/最小耗时/tag 检索调用链，返回 traceId、根服务、根操作与耗时。",
        {
            "service": {"type": "string", "description": "服务名"},
            "operation": {"type": "string", "description": "操作名"},
            "start_us": {"type": "number", "description": "起始时间(微秒时间戳)"},
            "end_us": {"type": "number", "description": "结束时间(微秒时间戳)"},
            "min_duration_ms": {"type": "number", "description": "最小耗时(毫秒)"},
            "limit": {"type": "number", "description": "返回条数上限，默认 20"},
            "tags": {"type": "object", "description": "tag 等值过滤，如 {\"http.status_code\":\"500\"}"},
        },
        [],
    ),
    _tool(
        "get_trace",
        "按 trace_id 拉取完整调用链 span 树（含服务、操作、耗时、状态与父子关系），用于定位链路中哪一跳最慢/报错。",
        {"trace_id": {"type": "string", "description": "trace id"}},
        ["trace_id"],
    ),
    _tool(
        "get_dependencies",
        "获取服务依赖调用图（parent→child 及调用次数），用于构建真实拓扑。",
        {"lookback_hours": {"type": "number", "description": "回看小时数，默认 1"}},
        [],
    ),
]


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    backend = _resolve_backend()
    import asyncio

    try:
        if tool == "list_services":
            data: Any = await asyncio.to_thread(list_services, backend)
        elif tool == "list_operations":
            data = await asyncio.to_thread(list_operations, backend, str(args.get("service") or ""))
        elif tool == "find_traces":
            data = await asyncio.to_thread(
                find_traces,
                backend,
                service=args.get("service"),
                operation=args.get("operation"),
                start_us=int(args["start_us"]) if args.get("start_us") else None,
                end_us=int(args["end_us"]) if args.get("end_us") else None,
                min_duration_ms=int(args["min_duration_ms"]) if args.get("min_duration_ms") else None,
                limit=int(args.get("limit") or 20),
                tags=args.get("tags") if isinstance(args.get("tags"), dict) else None,
            )
        elif tool == "get_trace":
            data = await asyncio.to_thread(get_trace, backend, str(args.get("trace_id") or ""))
        elif tool == "get_dependencies":
            data = await asyncio.to_thread(get_dependencies, backend, int(args.get("lookback_hours") or 1))
        else:
            return ToolExecutionResult(success=False, error=f"未知 trace 工具: {tool}", durationMs=_ms(started))
        if tool == "get_trace" and isinstance(data, dict):
            # span tags 中可能含敏感值，与其它 Skill 一致做脱敏
            data["spans"] = json.loads(redact(json.dumps(data["spans"], ensure_ascii=False)))
        return ToolExecutionResult(success=True, data=data, durationMs=_ms(started))
    except Exception as err:  # noqa: BLE001
        return ToolExecutionResult(success=False, error=str(err), durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)
