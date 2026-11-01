// ============================================================================
// Prometheus Client — 对应设计文档 §7 Skill 数据源扩展
//
// 通过 Prometheus HTTP API (PromQL) 查询指标数据：
// - instant query  : GET /api/v1/query?query=...&time=...
// - range query    : GET /api/v1/query_range?query=...&start=...&end=...&step=...
// - label values   : GET /api/v1/label/<name>/values
// - targets        : GET /api/v1/targets
//
// 兼容任何暴露 PromQL API 的后端（Prometheus / VictoriaMetrics / Mimir / Thanos）。
// 无第三方依赖，纯 fetch 实现；支持通过 headers/headerEnv 注入认证头。
// ============================================================================

import type { PrometheusBackend } from "../../config/types.js";

export interface PromSample {
  metric: Record<string, string>;
  /** [timestamp_seconds, value] */
  value?: [number, string];
  values?: [number, string][];
}

export interface PromQueryResult {
  resultType: "vector" | "matrix" | "scalar" | "string";
  samples: PromSample[];
}

function resolveHeaders(backend: PrometheusBackend): Record<string, string> {
  const headers: Record<string, string> = { ...(backend.headers ?? {}) };
  if (backend.headerEnv) {
    for (const [key, envName] of Object.entries(backend.headerEnv)) {
      if (process.env[envName]) headers[key] = process.env[envName]!;
    }
  }
  return headers;
}

async function promRequest<T>(backend: PrometheusBackend, apiPath: string, params: Record<string, string>): Promise<T> {
  const url = new URL(apiPath, backend.url.endsWith("/") ? backend.url : `${backend.url}/`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...resolveHeaders(backend) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Prometheus API ${response.status}: ${text.slice(0, 300)}`);
  }
  const body = (await response.json()) as { status: string; data?: T; errorType?: string; error?: string };
  if (body.status !== "success") {
    throw new Error(`Prometheus 查询失败: ${body.errorType ?? ""} ${body.error ?? "unknown error"}`);
  }
  return body.data as T;
}

function toQueryResult(data: { resultType: string; result: PromSample[] }): PromQueryResult {
  return {
    resultType: data.resultType as PromQueryResult["resultType"],
    samples: data.result ?? [],
  };
}

/** 瞬时查询：返回当前时刻的样本 */
export async function promInstantQuery(
  backend: PrometheusBackend,
  query: string,
  time?: string,
): Promise<PromQueryResult> {
  const params: Record<string, string> = { query };
  if (time) params.time = time;
  const data = await promRequest<{ resultType: string; result: PromSample[] }>(backend, "api/v1/query", params);
  return toQueryResult(data);
}

/** 区间查询：start/end 为秒级时间戳或 RFC3339，step 如 15s/1m/1h */
export async function promRangeQuery(
  backend: PrometheusBackend,
  query: string,
  start: string,
  end: string,
  step: string,
): Promise<PromQueryResult> {
  const data = await promRequest<{ resultType: string; result: PromSample[] }>(backend, "api/v1/query_range", {
    query,
    start,
    end,
    step,
  });
  return toQueryResult(data);
}

/** 获取 label 的所有取值，如 label=job / __name__ */
export async function promLabelValues(backend: PrometheusBackend, label: string): Promise<string[]> {
  const data = await promRequest<string[]>(backend, `api/v1/label/${encodeURIComponent(label)}/values`, {});
  return data ?? [];
}

/** 探活：/api/v1/status/buildinfo 轻量请求 */
export async function promHealthCheck(backend: PrometheusBackend): Promise<{ version?: string }> {
  const data = await promRequest<{ version: string }>(backend, "api/v1/status/buildinfo", {});
  return { version: data?.version };
}

/** 将 matrix 结果压成 uPlot 友好的序列 */
export function matrixToSeries(result: PromQueryResult, maxSeries = 8): Array<{
  name: string;
  points: [number, number][];
}> {
  if (result.resultType !== "matrix") return [];
  return result.samples.slice(0, maxSeries).map((s) => {
    const label = Object.entries(s.metric)
      .filter(([k]) => k !== "__name__")
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const base = s.metric.__name__ ?? "value";
    return {
      name: label ? `${base}{${label}}` : base,
      points: (s.values ?? []).map(([t, v]) => [t * 1000, Number(v)] as [number, number]),
    };
  });
}
