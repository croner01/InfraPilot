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
import { osClient } from "./logShipper.js";
import { redact } from "../../gateway/redact.js";

const INDEX_PATTERN = "order-api-logs-*";

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
    description: "按service/level/关键字/时间窗口检索日志(对真实OpenSearch索引发起查询)",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string" },
        level: { type: "string", description: "INFO|WARN|ERROR, 留空表示不过滤" },
        keyword: { type: "string", description: "可选,消息内容关键字过滤" },
        limit: { type: "number", description: "最多返回条数,默认20" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "aggregate_by_field",
    skill: "elk",
    risk: "readonly",
    description: "按字段(如level)聚合计数,用于快速了解日志整体分布,避免逐条阅读全量日志",
    parameters: {
      type: "object",
      properties: { field: { type: "string", description: "如 'level' 或 'service'" } },
      required: ["field"],
      additionalProperties: false,
    },
  },
  {
    name: "get_error_timeline",
    skill: "elk",
    risk: "readonly",
    description: "获取ERROR/WARN级别日志按时间排序的时间线,用于判断故障演化过程(何时开始恶化/何时崩溃)",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "cluster_similar_errors",
    skill: "elk",
    risk: "readonly",
    description: "对错误/警告日志做模板聚类,合并相似错误,返回每类错误的出现次数/首次末次时间/样例,避免逐条阅读",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

async function searchRecords(query: unknown, size: number): Promise<LogRecord[]> {
  try {
    const res: any = await osClient.search({
      index: INDEX_PATTERN,
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
        const { service, level, keyword, limit = 20 } = args as {
          service?: string; level?: string; keyword?: string; limit?: number;
        };
        const must: unknown[] = [];
        if (service) must.push({ term: { service } });
        if (level) must.push({ term: { level } });
        if (keyword) must.push({ match: { message: String(keyword) } });
        const query = must.length > 0 ? { bool: { must } } : { match_all: {} };

        const records = await searchRecords(query, Number(limit));
        const result = records.slice(-Number(limit)).map((l) => ({ ...l, message: redact(l.message ?? "") }));
        return { success: true, data: { total_matched: result.length, logs: result }, durationMs: Date.now() - start };
      }

      case "aggregate_by_field": {
        const field = String(args.field ?? "level");
        const res: any = await osClient.search({
          index: INDEX_PATTERN,
          body: {
            size: 0,
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
        return { success: true, data: { field, counts, total }, durationMs: Date.now() - start };
      }

      case "get_error_timeline": {
        const records = await searchRecords({ terms: { "level.keyword": ["WARN", "ERROR"] } }, 200);
        const timeline = records.map((l) => ({
          time: l["@timestamp"],
          level: l.level,
          message: redact(l.message ?? ""),
          rss_mb: l.rss_mb,
        }));
        return { success: true, data: { timeline }, durationMs: Date.now() - start };
      }

      case "cluster_similar_errors": {
        const problematic = await searchRecords({ terms: { "level.keyword": ["WARN", "ERROR"] } }, 500);
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
        return { success: true, data: { clusters: result, total_problematic_logs: problematic.length }, durationMs: Date.now() - start };
      }

      default:
        return { success: false, error: `未知的elk工具: ${tool}`, durationMs: Date.now() - start };
    }
  } catch (err: any) {
    return { success: false, error: `OpenSearch 查询失败: ${err?.message ?? String(err)}`, durationMs: Date.now() - start };
  }
}
