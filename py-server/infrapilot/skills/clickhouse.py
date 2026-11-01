"""ClickHouse Skill —— 对应 `server/src/skills/clickhouse/{tools,client}.ts`。

数据源为 islap 命名空间 K8s 托管的 ClickHouse（logs.logs），工具命名与 ELK Skill 对齐，
便于 Agent 与前端无感切换数据源。连接配置优先级：
1. 调用方临时参数  2. CLICKHOUSE_* 环境变量  3. K8s Service 自动发现  4. 内置默认值。
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Optional

import httpx

from ..models import ToolDef, ToolExecutionResult
from ..redact import redact

DEFAULT_CLICKHOUSE = {
    "host": "http://clickhouse.islap.svc.cluster.local:8123",
    "database": "logs",
    "table": "logs",
    "username": "default",
    "password": "",
}

_discovered_url: Optional[str] = None


def _discover_clickhouse_url() -> Optional[str]:
    """通过 K8s API 自动发现 islap/clickhouse 服务的 ClusterIP 与 http 端口。"""
    global _discovered_url
    if _discovered_url:
        return _discovered_url
    try:
        from .k8s import _core  # 延迟导入，避免无 kubeconfig 环境下启动即失败

        svc = _core().read_namespaced_service(name="clickhouse", namespace="islap")
        spec = getattr(svc, "spec", None)
        cluster_ip = getattr(spec, "cluster_ip", None)
        http_port = 8123
        for port in getattr(spec, "ports", None) or []:
            if getattr(port, "name", None) == "http" or getattr(port, "port", None) == 8123:
                http_port = getattr(port, "port", None) or 8123
                break
        if cluster_ip and cluster_ip != "None":
            _discovered_url = f"http://{cluster_ip}:{http_port}"
            print(f"[clickhouse client] 通过 K8s API 发现 ClickHouse 地址: {_discovered_url}")
            return _discovered_url
    except Exception as err:  # noqa: BLE001 - 集群外运行属正常场景，降级即可
        print(f"[clickhouse client] K8s Service 自动发现失败: {err}")
    return None


def build_connection(overrides: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    overrides = overrides or {}
    env = {
        "host": os.environ.get("CLICKHOUSE_HOST"),
        "database": os.environ.get("CLICKHOUSE_DATABASE"),
        "table": os.environ.get("CLICKHOUSE_TABLE"),
        "username": os.environ.get("CLICKHOUSE_USERNAME"),
        "password": os.environ.get("CLICKHOUSE_PASSWORD"),
    }
    host = overrides.get("host") or env["host"] or _discover_clickhouse_url() or DEFAULT_CLICKHOUSE["host"]
    return {
        "host": host,
        "database": overrides.get("database") or env["database"] or DEFAULT_CLICKHOUSE["database"],
        "table": overrides.get("table") or env["table"] or DEFAULT_CLICKHOUSE["table"],
        "username": overrides.get("username") or env["username"] or DEFAULT_CLICKHOUSE["username"],
        "password": overrides.get("password") or env["password"] or DEFAULT_CLICKHOUSE["password"],
    }


def _ch_query(conn: dict[str, Any], query: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    url = conn["host"].rstrip("/") + "/"
    query_params: dict[str, str] = {"database": conn["database"], "default_format": "JSONEachRow"}
    for key, value in params.items():
        query_params[f"param_{key}"] = str(value)
    timeout = float(os.environ.get("CLICKHOUSE_REQUEST_TIMEOUT_MS", "60000")) / 1000
    auth = (conn["username"], conn["password"]) if conn["username"] else None
    with httpx.Client(timeout=timeout) as client:
        response = client.post(url, params=query_params, content=query.encode("utf-8"), auth=auth)
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code}: {response.text[:300]}")
    text = response.text.strip()
    if not text:
        return []
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _escape_like(value: Optional[str]) -> str:
    if not value:
        return ""
    return re.sub(r"([\\%_])", r"\\\1", value)


def _build_where_clauses(args: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    clauses: list[str] = []
    params: dict[str, Any] = {}
    if args.get("namespace"):
        clauses.append("l.namespace = {namespace:String}")
        params["namespace"] = args["namespace"]
    if args.get("service"):
        clauses.append("l.service_name LIKE {serviceLike:String}")
        params["serviceLike"] = f"%{_escape_like(args['service'])}%"
    if args.get("pod_prefix"):
        clauses.append("l.pod_name LIKE {podPrefixLike:String}")
        params["podPrefixLike"] = f"{_escape_like(args['pod_prefix'])}%"
    if args.get("level"):
        clauses.append("l.level_norm = {levelNorm:String}")
        params["levelNorm"] = str(args["level"]).upper()
    if args.get("keyword"):
        clauses.append("l.message ILIKE {keywordLike:String}")
        params["keywordLike"] = f"%{_escape_like(args['keyword'])}%"
    minutes = args.get("minutes_ago")
    minutes = 30 if minutes is None else minutes
    clauses.append("l.timestamp >= now() - INTERVAL {minutesAgo:UInt32} MINUTE")
    params["minutesAgo"] = minutes
    return clauses, params


_TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([Z+-]\d{2}:?\d{2})?")
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_HASH_RE = re.compile(r"\b[0-9a-f]{32,64}\b", re.I)
_NUM_RE = re.compile(r"\d+(\.\d+)?")


def _template_of(message: str) -> str:
    text = message or ""
    text = _TIMESTAMP_RE.sub("<TIMESTAMP>", text)
    text = _UUID_RE.sub("<UUID>", text)
    text = _HASH_RE.sub("<HASH>", text)
    text = _NUM_RE.sub("<NUM>", text)
    return text.strip()


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> ToolDef:
    return ToolDef(
        name=name,
        skill="clickhouse",
        risk="readonly",
        description=description,
        parameters={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    )


TOOLS: list[ToolDef] = [
    _tool(
        "search_logs",
        "从 ClickHouse 日志库按 namespace/service/pod前缀/level/关键字/时间窗口检索日志。"
        "用于替代或补充 OpenSearch ELK Skill,在 islap 命名空间 K8s 托管的 ClickHouse 中查询真实日志。",
        {
            "namespace": {"type": "string", "description": "命名空间,如 order-service / islap / openstack"},
            "service": {"type": "string", "description": "service_name 精确值或前缀(使用 LIKE)"},
            "pod_prefix": {"type": "string", "description": "pod_name 前缀过滤"},
            "level": {"type": "string", "description": "日志级别: INFO|WARN|ERROR|DEBUG|FATAL,留空不过滤"},
            "keyword": {"type": "string", "description": "message 内容关键字(like %%匹配)"},
            "minutes_ago": {"type": "number", "description": "查询最近多少分钟,默认30"},
            "limit": {"type": "number", "description": "最多返回条数,默认50"},
        },
        [],
    ),
    _tool(
        "aggregate_by_field",
        "按字段(如 level/namespace/service_name/pod_name)对 ClickHouse 日志做 GROUP BY 计数,快速了解日志整体分布。",
        {
            "field": {"type": "string", "description": "分组字段,如 'level_norm' 'namespace' 'service_name'"},
            "namespace": {"type": "string", "description": "可选,限制命名空间"},
            "service": {"type": "string", "description": "可选,限制 service_name"},
            "minutes_ago": {"type": "number", "description": "最近多少分钟,默认30"},
            "topn": {"type": "number", "description": "返回前 N 个,默认20"},
        },
        ["field"],
    ),
    _tool(
        "get_error_timeline",
        "从 ClickHouse 获取 WARN/ERROR/FATAL 级别日志按时间排序的时间线,用于判断故障演化过程(何时开始恶化/何时崩溃)。",
        {
            "namespace": {"type": "string", "description": "命名空间"},
            "service": {"type": "string", "description": "service_name"},
            "pod_prefix": {"type": "string", "description": "pod_name 前缀"},
            "minutes_ago": {"type": "number", "description": "最近多少分钟,默认60"},
            "limit": {"type": "number", "description": "最多返回条数,默认100"},
        },
        [],
    ),
    _tool(
        "cluster_similar_errors",
        "对 ClickHouse 中 ERROR/WARN/FATAL 日志做模板聚类(将数字/变量泛化为占位符),"
        "合并相似错误,返回每类错误的出现次数/首次末次时间/样例,避免逐条阅读。",
        {
            "namespace": {"type": "string", "description": "命名空间"},
            "service": {"type": "string", "description": "service_name"},
            "pod_prefix": {"type": "string", "description": "pod_name 前缀"},
            "minutes_ago": {"type": "number", "description": "最近多少分钟,默认60"},
            "limit": {"type": "number", "description": "最多分析条数,默认500"},
        },
        [],
    ),
]

_ALLOWED_GROUP_FIELDS = {"level", "level_norm", "namespace", "service_name", "pod_name", "container_name", "node_name"}


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    conn = build_connection()
    safe_conn = {**conn, "password": "***" if conn["password"] else ""}

    def _clamp(value: Any, default: int, maximum: int) -> int:
        try:
            return min(int(value), maximum)
        except (TypeError, ValueError):
            return default

    try:
        if tool == "search_logs":
            clauses, params = _build_where_clauses(args)
            params["limit"] = _clamp(args.get("limit", 50), 50, 500)
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            query = (
                "SELECT toString(l.timestamp) AS timestamp, service_name, namespace, pod_name, container_name,"
                " level, level_norm, message, trace_id, node_name"
                f" FROM {conn['database']}.{conn['table']} AS l {where}"
                " ORDER BY l.timestamp DESC LIMIT {limit:UInt32} SETTINGS max_execution_time = 60"
            )
            rows = _ch_query(conn, query, params)
            logs = [{**r, "message": redact(r.get("message") or "")} for r in rows]
            return _ok({"total": len(logs), "logs": logs}, started)

        if tool == "aggregate_by_field":
            field = str(args.get("field") or "")
            if field not in _ALLOWED_GROUP_FIELDS:
                return _err(f"不允许的分组字段: {field}", started)
            clauses, params = _build_where_clauses(
                {"namespace": args.get("namespace"), "service": args.get("service"), "minutes_ago": args.get("minutes_ago")}
            )
            params["topn"] = _clamp(args.get("topn", 20), 20, 100)
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            query = (
                f"SELECT l.{field} AS key, count() AS doc_count FROM {conn['database']}.{conn['table']} AS l {where}"
                f" GROUP BY l.{field} ORDER BY doc_count DESC LIMIT {{topn:UInt32}} SETTINGS max_execution_time = 60"
            )
            rows = _ch_query(conn, query, params)
            counts: dict[str, int] = {}
            total = 0
            for row in rows:
                count = int(float(row.get("doc_count") or 0))
                counts[str(row.get("key"))] = count
                total += count
            return _ok({"field": field, "counts": counts, "total": total}, started)

        if tool == "get_error_timeline":
            clauses, params = _build_where_clauses(
                {
                    "namespace": args.get("namespace"),
                    "service": args.get("service"),
                    "pod_prefix": args.get("pod_prefix"),
                    "minutes_ago": args.get("minutes_ago", 60),
                }
            )
            params["limit"] = _clamp(args.get("limit", 100), 100, 500)
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            query = (
                "SELECT toString(l.timestamp) AS time, level_norm AS level, service_name, pod_name, message"
                f" FROM {conn['database']}.{conn['table']} AS l {where}"
                " AND l.level_norm IN ('WARN', 'ERROR', 'FATAL')"
                " ORDER BY l.timestamp ASC LIMIT {limit:UInt32} SETTINGS max_execution_time = 60"
            )
            rows = _ch_query(conn, query, params)
            timeline = [
                {
                    "time": r.get("time"),
                    "level": r.get("level"),
                    "service": r.get("service_name"),
                    "pod": r.get("pod_name"),
                    "message": redact(r.get("message") or ""),
                }
                for r in rows
            ]
            return _ok({"timeline": timeline}, started)

        if tool == "cluster_similar_errors":
            clauses, params = _build_where_clauses(
                {
                    "namespace": args.get("namespace"),
                    "service": args.get("service"),
                    "pod_prefix": args.get("pod_prefix"),
                    "minutes_ago": args.get("minutes_ago", 60),
                }
            )
            params["limit"] = _clamp(args.get("limit", 500), 500, 2000)
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            query = (
                "SELECT toString(l.timestamp) AS timestamp, level_norm AS level, message"
                f" FROM {conn['database']}.{conn['table']} AS l {where}"
                " AND l.level_norm IN ('WARN', 'ERROR', 'FATAL')"
                " ORDER BY l.timestamp ASC LIMIT {limit:UInt32} SETTINGS max_execution_time = 60"
            )
            rows = _ch_query(conn, query, params)
            clusters: dict[str, dict[str, Any]] = {}
            for row in rows:
                tmpl = _template_of(row.get("message") or "")
                level = str(row.get("level") or "UNKNOWN").upper()
                key = f"{level}::{tmpl}"
                existing = clusters.get(key)
                if existing:
                    existing["count"] += 1
                    existing["last"] = row.get("timestamp")
                else:
                    clusters[key] = {
                        "pattern": f"[{level}] {tmpl}",
                        "count": 1,
                        "first": row.get("timestamp"),
                        "last": row.get("timestamp"),
                        "sample": row,
                    }
            result = [
                {
                    "pattern": c["pattern"],
                    "count": c["count"],
                    "first_seen": c["first"],
                    "last_seen": c["last"],
                    "sample_log": redact(json.dumps(c["sample"], ensure_ascii=False, default=str)),
                }
                for c in sorted(clusters.values(), key=lambda x: x["count"], reverse=True)
            ]
            return _ok({"clusters": result, "total_problematic_logs": len(rows)}, started)

        return _err(f"未知的 clickhouse 工具: {tool}", started)
    except Exception as err:  # noqa: BLE001
        return _err(
            f"ClickHouse 查询失败: {err} (conn={json.dumps(safe_conn, ensure_ascii=False)})", started
        )


def _ok(data: Any, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=True, data=data, durationMs=_ms(started))


def _err(error: str, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=False, error=error, durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)
