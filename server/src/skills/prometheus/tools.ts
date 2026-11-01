// ============================================================================
// Prometheus Skill — 只读指标查询工具
//
// 数据源为 runtime-config.json 中配置的 Prometheus 后端（metricSystems），
// 未配置时回退到环境变量 PROMETHEUS_URL（默认 http://127.0.0.1:9090）。
// 工具契约对齐 prometheus-mcp-server 语义，供 Agent 在诊断过程中
// 将"日志现象"与"指标曲线"交叉验证（如 OOMKilled 前后的内存斜率）。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";
import { getDefaultPrometheusBackend } from "../../config/store.js";
import type { PrometheusBackend } from "../../config/types.js";
import { promInstantQuery, promLabelValues, promRangeQuery, matrixToSeries } from "./client.js";
import { redact } from "../../gateway/redact.js";

function resolveBackend(): PrometheusBackend {
  const backend = getDefaultPrometheusBackend();
  if (backend) return backend;
  return {
    id: "env-prometheus",
    type: "prometheus",
    name: "Prometheus (env)",
    enabled: true,
    url: process.env.PROMETHEUS_URL ?? "http://127.0.0.1:9090",
  };
}

/** 解析相对时间窗口为秒级时间戳，如 30m / 1h / 2d */
function windowToRange(window: string, step: string): { start: string; end: string; step: string } {
  const match = /^(\d+)([smhd])$/.exec(window.trim());
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  let seconds = 3600;
  if (match) {
    seconds = Number(match[1]) * (unitSeconds[match[2]] ?? 3600);
  }
  const end = Math.floor(Date.now() / 1000);
  return { start: String(end - seconds), end: String(end), step };
}

function formatInstant(result: Awaited<ReturnType<typeof promInstantQuery>>): string {
  if (result.samples.length === 0) return "(空结果，无匹配时间序列)";
  return result.samples
    .slice(0, 20)
    .map((s) => {
      const labels = Object.entries(s.metric).map(([k, v]) => `${k}=${v}`).join(",");
      return `${s.metric.__name__ ?? "value"}{${labels}} = ${s.value?.[1] ?? "?"} @ ${s.value?.[0] ?? "?"}`;
    })
    .join("\n")
    + (result.samples.length > 20 ? `\n... 共 ${result.samples.length} 条序列` : "");
}

export const prometheusTools: ToolDef[] = [
  {
    name: "instant_query",
    skill: "prom",
    risk: "readonly",
    description: "执行 PromQL 瞬时查询，返回当前时刻各时间序列的值。用于查看当前资源水位，如 CPU 使用率、内存占用、错误率等。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "PromQL 表达式，如 node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "range_query",
    skill: "prom",
    risk: "readonly",
    description: "执行 PromQL 区间查询，返回最近时间窗口内的指标曲线，用于观察趋势与突变（如 OOM 前内存斜率、QPS 下跌）。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "PromQL 表达式，如 rate(http_requests_total[5m])" },
        window: { type: "string", description: "回看时间窗口，如 30m / 1h / 6h，默认 1h" },
        step: { type: "string", description: "采样步长，如 15s / 1m / 5m，默认 1m" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "label_values",
    skill: "prom",
    risk: "readonly",
    description: "获取指定 label 的所有取值，用于发现可查询的服务/实例维度，如 label=job 或 label=__name__。",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "label 名称，如 job / instance / __name__" },
      },
      required: ["label"],
      additionalProperties: false,
    },
  },
];

export async function executePrometheusTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const started = Date.now();
  const backend = resolveBackend();
  try {
    let data: unknown;
    if (tool === "instant_query") {
      const result = await promInstantQuery(backend, String(args.query));
      data = { resultType: result.resultType, text: formatInstant(result), series: result.samples.slice(0, 10) };
    } else if (tool === "range_query") {
      const { start, end, step } = windowToRange(String(args.window ?? "1h"), String(args.step ?? "1m"));
      const result = await promRangeQuery(backend, String(args.query), start, end, step);
      const series = matrixToSeries(result, 10);
      data = {
        resultType: result.resultType,
        seriesCount: result.samples.length,
        series,
        text: series.map((s) => `${s.name}: ${s.points.length} 点, 最新 ${s.points.at(-1)?.[1] ?? "?"}`).join("\n") || "(空结果)",
      };
    } else if (tool === "label_values") {
      const values = await promLabelValues(backend, String(args.label));
      data = { label: args.label, values: values.slice(0, 100), total: values.length };
    } else {
      return { success: false, error: `unknown prometheus tool: ${tool}`, durationMs: Date.now() - started };
    }
    return {
      success: true,
      data: JSON.parse(redact(JSON.stringify(data ?? null))),
      durationMs: Date.now() - started,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err), durationMs: Date.now() - started };
  }
}
