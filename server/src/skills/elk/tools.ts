// ============================================================================
// ELK Skill — 对应设计文档 §9 / §5.3 elk-mcp-server
//
// 数据源: demo/supervisor.ts 管理的 order-api 子进程写入的真实结构化日志文件
// (data/order-api.log)。检索/聚合/聚类均对真实日志内容运算,而非编造数据。
// 聚类算法采用简化版模板提取(对齐设计文档§9.4的 Drain3 思路:
// 将数字/变量泛化为占位符再分组), 生产环境可直接替换为 drain3 库。
// ============================================================================

import fs from "node:fs";
import { ToolDef, ToolExecutionResult } from "../../types.js";
import { LOG_FILE } from "../../demo/supervisor.js";
import { redact } from "../../gateway/redact.js";

interface LogRecord {
  "@timestamp": string;
  service: string;
  level: string;
  message: string;
  pid?: number;
  uptime_ms?: number;
  [k: string]: unknown;
}

function readLogs(): LogRecord[] {
  try {
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogRecord;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogRecord => x !== null);
  } catch {
    return [];
  }
}

/** 简化版模板提取: 把数字泛化为 <NUM>, 用于日志聚类分组 */
function templateOf(message: string): string {
  return message.replace(/\d+(\.\d+)?/g, "<NUM>").trim();
}

export const elkTools: ToolDef[] = [
  {
    name: "search_logs",
    skill: "elk",
    risk: "readonly",
    description: "按service/level/关键字/时间窗口检索日志",
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

export async function executeElkTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  const logs = readLogs();

  switch (tool) {
    case "search_logs": {
      const { service, level, keyword, limit = 20 } = args as {
        service?: string; level?: string; keyword?: string; limit?: number;
      };
      let filtered = logs;
      if (service) filtered = filtered.filter((l) => l.service === service);
      if (level) filtered = filtered.filter((l) => l.level === level);
      if (keyword) filtered = filtered.filter((l) => l.message.toLowerCase().includes(String(keyword).toLowerCase()));
      const result = filtered.slice(-Number(limit)).map((l) => ({ ...l, message: redact(l.message) }));
      return { success: true, data: { total_matched: filtered.length, logs: result }, durationMs: Date.now() - start };
    }

    case "aggregate_by_field": {
      const field = String(args.field ?? "level");
      const counts: Record<string, number> = {};
      for (const l of logs) {
        const v = String((l as any)[field] ?? "unknown");
        counts[v] = (counts[v] ?? 0) + 1;
      }
      return { success: true, data: { field, counts, total: logs.length }, durationMs: Date.now() - start };
    }

    case "get_error_timeline": {
      const timeline = logs
        .filter((l) => l.level === "WARN" || l.level === "ERROR")
        .map((l) => ({ time: l["@timestamp"], level: l.level, message: redact(l.message), rss_mb: (l as any).rss_mb }));
      return { success: true, data: { timeline }, durationMs: Date.now() - start };
    }

    case "cluster_similar_errors": {
      const problematic = logs.filter((l) => l.level === "WARN" || l.level === "ERROR");
      const clusters = new Map<string, { pattern: string; count: number; first: string; last: string; sample: LogRecord }>();
      for (const l of problematic) {
        const tmpl = templateOf(l.message);
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
}
