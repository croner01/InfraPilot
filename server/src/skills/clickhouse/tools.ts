// ============================================================================
// ClickHouse Skill — 对应设计文档 §9 日志智能分析能力
//
// 真实集成: 数据源为 islap 命名空间下 K8s 托管的 ClickHouse 服务,
// 日志表为 logs.logs,字段符合 OpenTelemetry 日志语义(service_name/pod_name/
// namespace/level/message/trace_id 等)。
//
// 工具命名与行为尽量与 ELK Skill 保持一致,便于 Agent 和前端无感切换数据源。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";
import { createClickHouseClient, buildConnection, ClickHouseConnection } from "./client.js";
import { redact } from "../../gateway/redact.js";

async function getClient(connOverride?: Partial<ClickHouseConnection>) {
  return createClickHouseClient(connOverride);
}

interface LogRecord {
  timestamp: string;
  service_name?: string;
  namespace?: string;
  pod_name?: string;
  container_name?: string;
  level?: string;
  level_norm?: string;
  message: string;
  trace_id?: string;
  node_name?: string;
  [k: string]: unknown;
}

export const clickhouseTools: ToolDef[] = [
  {
    name: "search_logs",
    skill: "clickhouse",
    risk: "readonly",
    description:
      "从 ClickHouse 日志库按 namespace/service/pod前缀/level/关键字/时间窗口检索日志。" +
      "用于替代或补充 OpenSearch ELK Skill,在 islap 命名空间 K8s 托管的 ClickHouse 中查询真实日志。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "命名空间,如 order-service / islap / openstack" },
        service: { type: "string", description: "service_name 精确值或前缀(使用 LIKE)" },
        pod_prefix: { type: "string", description: "pod_name 前缀过滤" },
        level: { type: "string", description: "日志级别: INFO|WARN|ERROR|DEBUG|FATAL,留空不过滤" },
        keyword: { type: "string", description: "message 内容关键字(like %%匹配)" },
        minutes_ago: { type: "number", description: "查询最近多少分钟,默认30" },
        limit: { type: "number", description: "最多返回条数,默认50" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "aggregate_by_field",
    skill: "clickhouse",
    risk: "readonly",
    description:
      "按字段(如 level/namespace/service_name/pod_name)对 ClickHouse 日志做 GROUP BY 计数," +
      "快速了解日志整体分布。",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", description: "分组字段,如 'level_norm' 'namespace' 'service_name'" },
        namespace: { type: "string", description: "可选,限制命名空间" },
        service: { type: "string", description: "可选,限制 service_name" },
        minutes_ago: { type: "number", description: "最近多少分钟,默认30" },
        topn: { type: "number", description: "返回前 N 个,默认20" },
      },
      required: ["field"],
      additionalProperties: false,
    },
  },
  {
    name: "get_error_timeline",
    skill: "clickhouse",
    risk: "readonly",
    description:
      "从 ClickHouse 获取 WARN/ERROR/FATAL 级别日志按时间排序的时间线," +
      "用于判断故障演化过程(何时开始恶化/何时崩溃)。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "命名空间" },
        service: { type: "string", description: "service_name" },
        pod_prefix: { type: "string", description: "pod_name 前缀" },
        minutes_ago: { type: "number", description: "最近多少分钟,默认60" },
        limit: { type: "number", description: "最多返回条数,默认100" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "cluster_similar_errors",
    skill: "clickhouse",
    risk: "readonly",
    description:
      "对 ClickHouse 中 ERROR/WARN/FATAL 日志做模板聚类(将数字/变量泛化为占位符)," +
      "合并相似错误,返回每类错误的出现次数/首次末次时间/样例,避免逐条阅读。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "命名空间" },
        service: { type: "string", description: "service_name" },
        pod_prefix: { type: "string", description: "pod_name 前缀" },
        minutes_ago: { type: "number", description: "最近多少分钟,默认60" },
        limit: { type: "number", description: "最多分析条数,默认500" },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

function templateOf(message: string): string {
  return (message ?? "")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([Z+-]\d{2}:?\d{2})?/g, "<TIMESTAMP>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "<HASH>")
    .replace(/\d+(\.\d+)?/g, "<NUM>")
    .trim();
}

function escapeLike(value?: string): string {
  if (!value) return "";
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildWhereClauses(args: {
  namespace?: string;
  service?: string;
  pod_prefix?: string;
  level?: string;
  keyword?: string;
  minutes_ago?: number;
}): { clauses: string[]; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (args.namespace) {
    clauses.push("l.namespace = {namespace:String}");
    params.namespace = args.namespace;
  }
  if (args.service) {
    clauses.push("l.service_name LIKE {serviceLike:String}");
    params.serviceLike = `%${escapeLike(args.service)}%`;
  }
  if (args.pod_prefix) {
    clauses.push("l.pod_name LIKE {podPrefixLike:String}");
    params.podPrefixLike = `${escapeLike(args.pod_prefix)}%`;
  }
  if (args.level) {
    clauses.push("l.level_norm = {levelNorm:String}");
    params.levelNorm = args.level.toUpperCase();
  }
  if (args.keyword) {
    clauses.push("l.message ILIKE {keywordLike:String}");
    params.keywordLike = `%${escapeLike(args.keyword)}%`;
  }
  const minutes = args.minutes_ago ?? 30;
  clauses.push("l.timestamp >= now() - INTERVAL {minutesAgo:UInt32} MINUTE");
  params.minutesAgo = minutes;

  return { clauses, params };
}

export async function executeClickhouseTool(
  tool: string,
  args: Record<string, unknown>,
  connOverride?: Partial<ClickHouseConnection>
): Promise<ToolExecutionResult> {
  const start = Date.now();
  const conn = await buildConnection(connOverride);

  // 安全: 不在错误里暴露密码
  const safeConn = { ...conn, password: conn.password ? "***" : "" };

  try {
    const client = await getClient(connOverride);

    switch (tool) {
      case "search_logs": {
        const {
          namespace,
          service,
          pod_prefix,
          level,
          keyword,
          minutes_ago,
          limit = 50,
        } = args as {
          namespace?: string;
          service?: string;
          pod_prefix?: string;
          level?: string;
          keyword?: string;
          minutes_ago?: number;
          limit?: number;
        };

        const { clauses, params } = buildWhereClauses({
          namespace,
          service,
          pod_prefix,
          level,
          keyword,
          minutes_ago,
        });
        params.limit = Math.min(Number(limit), 500);

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const query = `
          SELECT
            toString(l.timestamp) AS timestamp,
            service_name,
            namespace,
            pod_name,
            container_name,
            level,
            level_norm,
            message,
            trace_id,
            node_name
          FROM ${conn.database}.${conn.table} AS l
          ${where}
          ORDER BY l.timestamp DESC
          LIMIT {limit:UInt32}
          SETTINGS max_execution_time = 60
        `;

        const res = await client.query({ query, query_params: params, format: "JSONEachRow" });
        const rows = (await res.json()) as LogRecord[];
        const data = rows.map((r) => ({ ...r, message: redact(r.message ?? "") }));
        return { success: true, data: { total: data.length, logs: data }, durationMs: Date.now() - start };
      }

      case "aggregate_by_field": {
        const {
          field,
          namespace,
          service,
          minutes_ago,
          topn = 20,
        } = args as {
          field: string;
          namespace?: string;
          service?: string;
          minutes_ago?: number;
          topn?: number;
        };

        // 只允许白名单字段,防止 SQL 注入
        const allowedFields = new Set(["level", "level_norm", "namespace", "service_name", "pod_name", "container_name", "node_name"]);
        if (!allowedFields.has(field)) {
          return { success: false, error: `不允许的分组字段: ${field}`, durationMs: Date.now() - start };
        }

        const { clauses, params } = buildWhereClauses({ namespace, service, minutes_ago });
        params.topn = Math.min(Number(topn), 100);

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const query = `
          SELECT l.${field} AS key, count() AS doc_count
          FROM ${conn.database}.${conn.table} AS l
          ${where}
          GROUP BY l.${field}
          ORDER BY doc_count DESC
          LIMIT {topn:UInt32}
          SETTINGS max_execution_time = 60
        `;

        const res = await client.query({ query, query_params: params, format: "JSONEachRow" });
        const aggRows = (await res.json()) as Array<{ key: string; doc_count: string }>;
        const counts: Record<string, number> = {};
        let total = 0;
        for (const row of aggRows) {
          const c = Number(row.doc_count);
          counts[row.key] = c;
          total += c;
        }
        return { success: true, data: { field, counts, total }, durationMs: Date.now() - start };
      }

      case "get_error_timeline": {
        const { namespace, service, pod_prefix, minutes_ago = 60, limit = 100 } = args as {
          namespace?: string;
          service?: string;
          pod_prefix?: string;
          minutes_ago?: number;
          limit?: number;
        };

        const { clauses, params } = buildWhereClauses({ namespace, service, pod_prefix, minutes_ago });
        params.limit = Math.min(Number(limit), 500);

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const query = `
          SELECT
            toString(l.timestamp) AS time,
            level_norm AS level,
            service_name,
            pod_name,
            message
          FROM ${conn.database}.${conn.table} AS l
          ${where}
          AND l.level_norm IN ('WARN', 'ERROR', 'FATAL')
          ORDER BY l.timestamp ASC
          LIMIT {limit:UInt32}
          SETTINGS max_execution_time = 60
        `;

        const res = await client.query({ query, query_params: params, format: "JSONEachRow" });
        const rows = (await res.json()) as LogRecord[];
        const timeline = rows.map((r) => ({
          time: r.timestamp,
          level: r.level_norm ?? r.level,
          service: r.service_name,
          pod: r.pod_name,
          message: redact(r.message ?? ""),
        }));
        return { success: true, data: { timeline }, durationMs: Date.now() - start };
      }

      case "cluster_similar_errors": {
        const { namespace, service, pod_prefix, minutes_ago = 60, limit = 500 } = args as {
          namespace?: string;
          service?: string;
          pod_prefix?: string;
          minutes_ago?: number;
          limit?: number;
        };

        const { clauses, params } = buildWhereClauses({ namespace, service, pod_prefix, minutes_ago });
        params.limit = Math.min(Number(limit), 2000);

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const query = `
          SELECT
            toString(l.timestamp) AS timestamp,
            level_norm AS level,
            message
          FROM ${conn.database}.${conn.table} AS l
          ${where}
          AND l.level_norm IN ('WARN', 'ERROR', 'FATAL')
          ORDER BY l.timestamp ASC
          LIMIT {limit:UInt32}
          SETTINGS max_execution_time = 60
        `;

        const res = await client.query({ query, query_params: params, format: "JSONEachRow" });
        const rows = (await res.json()) as LogRecord[];
        const clusters = new Map<string, { pattern: string; count: number; first: string; last: string; sample: LogRecord }>();
        for (const l of rows) {
          const tmpl = templateOf(l.message ?? "");
          const level = (l.level_norm ?? l.level ?? "UNKNOWN").toUpperCase();
          const key = `${level}::${tmpl}`;
          const existing = clusters.get(key);
          if (existing) {
            existing.count += 1;
            existing.last = l.timestamp;
          } else {
            clusters.set(key, {
              pattern: `[${level}] ${tmpl}`,
              count: 1,
              first: l.timestamp,
              last: l.timestamp,
              sample: l,
            });
          }
        }
        const result = Array.from(clusters.values())
          .sort((a, b) => b.count - a.count)
          .map((c) => ({
            pattern: c.pattern,
            count: c.count,
            first_seen: c.first,
            last_seen: c.last,
            sample_log: redact(JSON.stringify(c.sample)),
          }));
        return {
          success: true,
          data: { clusters: result, total_problematic_logs: rows.length },
          durationMs: Date.now() - start,
        };
      }

      default:
        return { success: false, error: `未知的 clickhouse 工具: ${tool}`, durationMs: Date.now() - start };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `ClickHouse 查询失败: ${err?.message ?? String(err)} (conn=${JSON.stringify(safeConn)})`,
      durationMs: Date.now() - start,
    };
  }
}
