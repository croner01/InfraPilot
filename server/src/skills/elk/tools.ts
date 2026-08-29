// ============================================================================
// ELK Skill — 对应设计文档 §9 / §5.3 elk-mcp-server
//
// 真实集成: 数据源为真实 OpenSearch 单节点(sandbox内搭建, 详见
// server/k8s-manifests/README.md), 索引数据来自 logShipper.ts 从真实
// K8s Pod(order-api Deployment)的 CRI 日志文件采集而来 —— search/aggregate/
// cluster 均对 OpenSearch 发起真实查询, 而非本地文件解析或编造数据。
// 聚类算法采用简化版模板提取(对齐设计文档§9.4的 Drain3 思路: 将数字/变量
// 泛化为占位符再分组), 生产环境可直接替换为 drain3 库或 OpenSearch 自带的
// pattern analysis。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";
import { osClient, resolveIndexPattern } from "./logShipper.js";
import { redact } from "../../gateway/redact.js";

interface SearchOptions {
  namespace?: string;
  index_prefix?: string;
}

function buildIndexPattern(options?: SearchOptions): string {
  return resolveIndexPattern({ namespace: options?.namespace, index_prefix: options?.index_prefix });
}

function addNamespaceFilter(must: unknown[], namespace?: string): void {
  if (namespace) {
    must.push({ term: { namespace } });
  }
}

interface LogRecord {
  "@timestamp": string;
  service?: string;
  level: string;
  message: string;
  pid?: number;
  uptime_ms?: number;
  rss_mb?: number;
  [k: string]: unknown;
}

/** 简化版模板提取: 把数字泛化为 <NUM>, 用于日志聚类分组 */
function templateOf(message: string): string {
  return (message ?? "").replace(/\d+(\.\d+)?/g, "<NUM>").trim();
}

export const elkTools: ToolDef[] = [
  {
    name: "search_logs",
    skill: "elk",
    risk: "readonly",
    description: "按namespace/service/level/关键字/时间窗口检索日志(对真实OpenSearch索引发起查询)。支持通过namespace自动匹配索引,也可显式指定index_prefix。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "可选,如 order-service / islap,留空表示跨所有命名空间" },
        index_prefix: { type: "string", description: "可选,显式指定索引前缀(优先级高于namespace),如 order-api-logs" },
        service: { type: "string" },
        level: { type: "string", description: "INFO|WARN|ERROR, 留空表示不过滤" },
        keyword: { type: "string", description: "可选,消息内容关键字过滤" },
        limit: { type: "number", description: "最多返回条数,默认20" },
        since: { type: "string", description: "可选,时间窗口,如 30m / 1h,留空表示不过滤" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "aggregate_by_field",
    skill: "elk",
    risk: "readonly",
    description: "按字段(如level)聚合计数,用于快速了解日志整体分布。支持通过namespace或index_prefix限定目标索引。",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", description: "如 'level' 或 'service'" },
        namespace: { type: "string", description: "可选,限定命名空间" },
        index_prefix: { type: "string", description: "可选,显式指定索引前缀" },
      },
      required: ["field"],
      additionalProperties: false,
    },
  },
  {
    name: "get_error_timeline",
    skill: "elk",
    risk: "readonly",
    description: "获取ERROR/WARN级别日志按时间排序的时间线。支持通过namespace或index_prefix限定目标索引。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "可选,限定命名空间" },
        index_prefix: { type: "string", description: "可选,显式指定索引前缀" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "cluster_similar_errors",
    skill: "elk",
    risk: "readonly",
    description: "对错误/警告日志做模板聚类。支持通过namespace或index_prefix限定目标索引。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "可选,限定命名空间" },
        index_prefix: { type: "string", description: "可选,显式指定索引前缀" },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

async function searchRecords(query: unknown, size: number, options?: SearchOptions): Promise<LogRecord[]> {
  const index = buildIndexPattern(options);
  // 显式 namespace/index 未映射到任何采集索引时直接返回空,避免对空索引发起无效查询
  if (!index) return [];
  try {
    const res: any = await osClient.search({
      index,
      body: {
        query: query as any,
        sort: [{ "@timestamp": { order: "asc" } }],
        size,
      },
    } as any);
    return res.body.hits.hits.map((h: any) => h._source as LogRecord);
  } catch (err: any) {
    if (err?.meta?.body?.error?.type === "index_not_found_exception") return [];
    throw err;
  }
}

export async function executeElkTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();

  try {
    switch (tool) {
      case "search_logs": {
        const { namespace, index_prefix, service, level, keyword, limit = 20, since } = args as {
          namespace?: string; index_prefix?: string; service?: string; level?: string; keyword?: string; limit?: number; since?: string;
        };
        const searchOpts: SearchOptions = { namespace, index_prefix };
        const must: unknown[] = [];
        addNamespaceFilter(must, namespace);
        if (service) must.push({ term: { service } });
        if (level) must.push({ term: { level } });
        if (keyword) must.push({ match: { message: String(keyword) } });
        if (since) must.push({ range: { "@timestamp": { gte: `now-${String(since)}` } } });
        const query = must.length > 0 ? { bool: { must } } : { match_all: {} };

        const records = await searchRecords(query, Number(limit), searchOpts);
        const result = records.slice(-Number(limit)).map((l) => ({ ...l, message: redact(l.message ?? "") }));
        return { success: true, data: { total_matched: result.length, logs: result, index_pattern: buildIndexPattern(searchOpts) }, durationMs: Date.now() - start };
      }

      case "aggregate_by_field": {
        const { field, namespace, index_prefix } = args as { field?: string; namespace?: string; index_prefix?: string };
        const searchOpts: SearchOptions = { namespace, index_prefix };
        const index = buildIndexPattern(searchOpts);
        if (!index) {
          return {
            success: true,
            data: { field, counts: {}, total: 0, index_pattern: "" },
            durationMs: Date.now() - start,
          };
        }
        const res: any = await osClient.search({
          index,
          body: {
            size: 0,
            query: namespace ? { bool: { must: [{ term: { namespace } }] } } : { match_all: {} },
            aggs: { by_field: { terms: { field: `${field}.keyword`, size: 20 } } },
          },
        } as any);
        const buckets = (res.body.aggregations?.by_field?.buckets ?? []) as Array<{ key: string; doc_count: number }>;
        const counts: Record<string, number> = {};
        let total = 0;
        for (const b of buckets) {
          counts[b.key] = b.doc_count;
          total += b.doc_count;
        }
        return { success: true, data: { field, counts, total, index_pattern: index }, durationMs: Date.now() - start };
      }

      case "get_error_timeline": {
        const { namespace, index_prefix } = args as { namespace?: string; index_prefix?: string };
        const searchOpts: SearchOptions = { namespace, index_prefix };
        if (!buildIndexPattern(searchOpts)) {
          return {
            success: true,
            data: { timeline: [], index_pattern: "" },
            durationMs: Date.now() - start,
          };
        }
        const must: unknown[] = [{ terms: { "level.keyword": ["WARN", "ERROR"] } }];
        addNamespaceFilter(must, namespace);
        const records = await searchRecords({ bool: { must } }, 200, searchOpts);
        const timeline = records.map((l) => ({
          time: l["@timestamp"],
          level: l.level,
          message: redact(l.message ?? ""),
          rss_mb: l.rss_mb,
        }));
        return { success: true, data: { timeline, index_pattern: buildIndexPattern(searchOpts) }, durationMs: Date.now() - start };
      }

      case "cluster_similar_errors": {
        const { namespace, index_prefix } = args as { namespace?: string; index_prefix?: string };
        const searchOpts: SearchOptions = { namespace, index_prefix };
        if (!buildIndexPattern(searchOpts)) {
          return {
            success: true,
            data: { clusters: [], total_problematic_logs: 0, index_pattern: "" },
            durationMs: Date.now() - start,
          };
        }
        const must: unknown[] = [{ terms: { "level.keyword": ["WARN", "ERROR"] } }];
        addNamespaceFilter(must, namespace);
        const problematic = await searchRecords({ bool: { must } }, 500, searchOpts);
        const clusters = new Map<string, { pattern: string; count: number; first: string; last: string; sample: LogRecord }>();
        for (const l of problematic) {
          const tmpl = templateOf(l.message ?? "");
          const key = `${l.level}::${tmpl}`;
          const existing = clusters.get(key);
          if (existing) {
            existing.count += 1;
            existing.last = l["@timestamp"];
          } else {
            clusters.set(key, { pattern: `[${l.level}] ${tmpl}`, count: 1, first: l["@timestamp"], last: l["@timestamp"], sample: l });
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
        return { success: true, data: { clusters: result, total_problematic_logs: problematic.length, index_pattern: buildIndexPattern(searchOpts) }, durationMs: Date.now() - start };
      }

      default:
        return { success: false, error: `未知的elk工具: ${tool}`, durationMs: Date.now() - start };
    }
  } catch (err: any) {
    return { success: false, error: `OpenSearch 查询失败: ${err?.message ?? String(err)}`, durationMs: Date.now() - start };
  }
}
