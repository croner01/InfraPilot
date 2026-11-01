"""ELK / OpenSearch Skill —— 对应 `server/src/skills/elk/tools.ts`。

数据源为真实 OpenSearch；索引模式解析规则与 `logShipper.ts::resolveIndexPattern` 一致
（采集目标来自 runtime-config 的 logSystems，支持热更新）。
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Optional

from opensearchpy import OpenSearch
from opensearchpy.exceptions import NotFoundError

from .. import datasource_client as ds
from ..config_store import get_legacy_elk_config, get_default_elk_backend
from ..models import ToolDef, ToolExecutionResult
from ..redact import redact

_client: Optional[OpenSearch] = None
_client_node: Optional[str] = None


def active_backend() -> dict[str, Any]:
    """当前生效的日志后端（runtime-config；缺省回退 env / 内置默认）。

    与 Node 版不同：Python 版额外支持 `type=es8|elasticsearch` 的 Elasticsearch 8 后端，
    通过 REST + `compatible-with: 8` 兼容头访问（见 datasource_client）。
    """
    backend = get_default_elk_backend()
    if backend:
        return backend
    legacy = get_legacy_elk_config()
    return {
        "id": "legacy-elk",
        "type": "elk",
        "name": "OpenSearch (legacy)",
        "enabled": True,
        "node": legacy["node"],
        "targets": legacy["targets"],
    }


def _node() -> str:
    return active_backend().get("node") or get_legacy_elk_config()["node"]


def os_client() -> OpenSearch:
    global _client, _client_node
    node = _node()
    if _client is None or _client_node != node:
        # 显式收敛超时/重试：数据源不可达时应快速失败，避免诊断链路长时间阻塞
        _client = OpenSearch(
            hosts=[node],
            verify_certs=False,
            ssl_show_warn=False,
            timeout=10,
            max_retries=1,
            retry_on_timeout=False,
        )
        _client_node = node
    return _client


def ship_targets() -> list[dict[str, Any]]:
    backend = get_default_elk_backend()
    if backend and backend.get("targets") is not None:
        return backend["targets"] or []
    return get_legacy_elk_config()["targets"]


def resolve_index_pattern(namespace: Optional[str] = None, index_prefix: Optional[str] = None, all_: bool = False) -> str:
    if index_prefix:
        return f"{index_prefix}-*"
    targets = ship_targets() or []
    matched = targets
    if namespace:
        matched = [t for t in targets if t.get("namespace") == namespace]
        if not matched:
            print(f"[elk] 未找到 namespace={namespace} 对应的采集目标,显式 namespace 查询返回空(不再回退全部索引)")
            return ""
    elif not all_:
        matched = targets
    patterns = list(dict.fromkeys(f"{t.get('indexPrefix')}-*" for t in matched))
    if not patterns:
        return "order-api-logs-*"
    return ",".join(patterns)


def _template_of(message: str) -> str:
    return re.sub(r"\d+(\.\d+)?", "<NUM>", message or "").strip()


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> ToolDef:
    return ToolDef(
        name=name,
        skill="elk",
        risk="readonly",
        description=description,
        parameters={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    )


TOOLS: list[ToolDef] = [
    _tool(
        "search_logs",
        "按namespace/service/level/关键字/时间窗口检索日志(对真实OpenSearch索引发起查询)。支持通过namespace自动匹配索引,也可显式指定index_prefix。",
        {
            "namespace": {"type": "string", "description": "可选,如 order-service / islap,留空表示跨所有命名空间"},
            "index_prefix": {"type": "string", "description": "可选,显式指定索引前缀(优先级高于namespace),如 order-api-logs"},
            "service": {"type": "string"},
            "level": {"type": "string", "description": "INFO|WARN|ERROR, 留空表示不过滤"},
            "keyword": {"type": "string", "description": "可选,消息内容关键字过滤"},
            "limit": {"type": "number", "description": "最多返回条数,默认20"},
            "since": {"type": "string", "description": "可选,时间窗口,如 30m / 1h,留空表示不过滤"},
        },
        [],
    ),
    _tool(
        "aggregate_by_field",
        "按字段(如level)聚合计数,用于快速了解日志整体分布。支持通过namespace或index_prefix限定目标索引。",
        {
            "field": {"type": "string", "description": "如 'level' 或 'service'"},
            "namespace": {"type": "string", "description": "可选,限定命名空间"},
            "index_prefix": {"type": "string", "description": "可选,显式指定索引前缀"},
        },
        ["field"],
    ),
    _tool(
        "get_error_timeline",
        "获取ERROR/WARN级别日志按时间排序的时间线。支持通过namespace或index_prefix限定目标索引。",
        {
            "namespace": {"type": "string", "description": "可选,限定命名空间"},
            "index_prefix": {"type": "string", "description": "可选,显式指定索引前缀"},
        },
        [],
    ),
    _tool(
        "cluster_similar_errors",
        "对错误/警告日志做模板聚类。支持通过namespace或index_prefix限定目标索引。",
        {
            "namespace": {"type": "string", "description": "可选,限定命名空间"},
            "index_prefix": {"type": "string", "description": "可选,显式指定索引前缀"},
        },
        [],
    ),
]


def _index_missing(err: Exception) -> bool:
    info = getattr(err, "info", None)
    if isinstance(info, dict):
        return ((info.get("error") or {}).get("type")) == "index_not_found_exception"
    return False


async def search(index: str, body: dict[str, Any]) -> dict[str, Any]:
    """统一 `_search` 入口：OpenSearch（SDK）与 ES8（REST）共用同一份查询体。"""
    backend = active_backend()
    if ds.is_rest_flavor(backend):
        return await ds.search_async(backend, index, body)
    return await asyncio.to_thread(lambda: os_client().search(index=index, body=body))


def _is_index_missing(err: Exception) -> bool:
    return _index_missing(err) or isinstance(err, ds.IndexNotFound)


async def _search_records(query: dict[str, Any], size: int, index: str) -> tuple[list[dict[str, Any]], bool]:
    body = {"query": query, "sort": [{"@timestamp": {"order": "asc"}}], "size": size}
    try:
        res = await search(index, body)
        return [h["_source"] for h in res["hits"]["hits"]], False
    except (NotFoundError, ds.IndexNotFound) as err:
        if _is_index_missing(err):
            return [], True
        raise


def _ms(start: float) -> int:
    return int((time.time() - start) * 1000)


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    start = time.time()
    try:
        if tool == "search_logs":
            namespace = args.get("namespace")
            index_prefix = args.get("index_prefix")
            index = resolve_index_pattern(namespace, index_prefix)
            must: list[dict[str, Any]] = []
            if namespace:
                must.append({"term": {"namespace": namespace}})
            if args.get("service"):
                must.append({"term": {"service": args["service"]}})
            if args.get("level"):
                must.append({"term": {"level": args["level"]}})
            if args.get("keyword"):
                must.append({"match": {"message": str(args["keyword"])}})
            if args.get("since"):
                must.append({"range": {"@timestamp": {"gte": f"now-{args['since']}"}}})
            query = {"bool": {"must": must}} if must else {"match_all": {}}
            limit = int(args.get("limit") or 20)

            records, index_missing = await _search_records(query, limit, index) if index else ([], True)
            result = [{**l, "message": redact(l.get("message") or "")} for l in records[-limit:]]
            data: dict[str, Any] = {"total_matched": len(result), "logs": result, "index_pattern": index}
            if index_missing:
                data["note"] = f"索引不存在或为空({index}), 可能是日志采集未覆盖或时间窗内无数据"
            return ToolExecutionResult(success=True, data=data, durationMs=_ms(start))

        if tool == "aggregate_by_field":
            field = args.get("field")
            namespace = args.get("namespace")
            index = resolve_index_pattern(namespace, args.get("index_prefix"))
            if not index:
                return ToolExecutionResult(
                    success=True, data={"field": field, "counts": {}, "total": 0, "index_pattern": ""}, durationMs=_ms(start)
                )
            body = {
                "size": 0,
                "query": {"bool": {"must": [{"term": {"namespace": namespace}}]}} if namespace else {"match_all": {}},
                "aggs": {"by_field": {"terms": {"field": f"{field}.keyword", "size": 20}}},
            }
            try:
                res = await search(index, body)
            except (NotFoundError, ds.IndexNotFound) as err:
                if _is_index_missing(err):
                    return ToolExecutionResult(
                        success=True,
                        data={"field": field, "counts": {}, "total": 0, "index_pattern": index, "note": f"索引不存在或为空({index})"},
                        durationMs=_ms(start),
                    )
                raise
            buckets = ((res.get("aggregations") or {}).get("by_field") or {}).get("buckets") or []
            counts: dict[str, int] = {}
            total = 0
            for b in buckets:
                counts[b["key"]] = b["doc_count"]
                total += b["doc_count"]
            return ToolExecutionResult(
                success=True, data={"field": field, "counts": counts, "total": total, "index_pattern": index}, durationMs=_ms(start)
            )

        if tool == "get_error_timeline":
            namespace = args.get("namespace")
            index = resolve_index_pattern(namespace, args.get("index_prefix"))
            if not index:
                return ToolExecutionResult(success=True, data={"timeline": [], "index_pattern": ""}, durationMs=_ms(start))
            must: list[dict[str, Any]] = [{"terms": {"level.keyword": ["WARN", "ERROR"]}}]
            if namespace:
                must.append({"term": {"namespace": namespace}})
            records, index_missing = await _search_records({"bool": {"must": must}}, 200, index)
            timeline = [
                {"time": l.get("@timestamp"), "level": l.get("level"), "message": redact(l.get("message") or ""), "rss_mb": l.get("rss_mb")}
                for l in records
            ]
            data: dict[str, Any] = {"timeline": timeline, "index_pattern": index}
            if index_missing:
                data["note"] = f"索引不存在或为空({index})"
            return ToolExecutionResult(success=True, data=data, durationMs=_ms(start))

        if tool == "cluster_similar_errors":
            namespace = args.get("namespace")
            index = resolve_index_pattern(namespace, args.get("index_prefix"))
            if not index:
                return ToolExecutionResult(
                    success=True, data={"clusters": [], "total_problematic_logs": 0, "index_pattern": ""}, durationMs=_ms(start)
                )
            must: list[dict[str, Any]] = [{"terms": {"level.keyword": ["WARN", "ERROR"]}}]
            if namespace:
                must.append({"term": {"namespace": namespace}})
            problematic, index_missing = await _search_records({"bool": {"must": must}}, 500, index)

            clusters: dict[str, dict[str, Any]] = {}
            for l in problematic:
                tmpl = _template_of(l.get("message") or "")
                key = f"{l.get('level')}::{tmpl}"
                existing = clusters.get(key)
                if existing:
                    existing["count"] += 1
                    existing["last"] = l.get("@timestamp")
                else:
                    clusters[key] = {
                        "pattern": f"[{l.get('level')}] {tmpl}",
                        "count": 1,
                        "first": l.get("@timestamp"),
                        "last": l.get("@timestamp"),
                        "sample": l,
                    }
            result = [
                {
                    "pattern": c["pattern"],
                    "count": c["count"],
                    "first_seen": c["first"],
                    "last_seen": c["last"],
                    "sample_log": redact(str(c["sample"])),
                }
                for c in sorted(clusters.values(), key=lambda c: c["count"], reverse=True)
            ]
            data = {"clusters": result, "total_problematic_logs": len(problematic), "index_pattern": index}
            if index_missing:
                data["note"] = f"索引不存在或为空({index})"
            return ToolExecutionResult(success=True, data=data, durationMs=_ms(start))

        return ToolExecutionResult(success=False, error=f"未知的elk工具: {tool}", durationMs=_ms(start))
    except Exception as err:  # noqa: BLE001
        return ToolExecutionResult(success=False, error=f"OpenSearch 查询失败: {err}", durationMs=_ms(start))
