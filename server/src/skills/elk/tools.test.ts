import { describe, it, expect, vi, beforeEach } from "vitest";

// 在静态导入前 mock logShipper，使测试可以控制 SHIP_TARGETS 与 osClient
vi.mock("./logShipper.js", () => {
  const SHIP_TARGETS: Array<{ namespace: string; podNamePrefix: string; indexPrefix: string }> = [];

  function resolveIndexPattern(options?: { namespace?: string; index_prefix?: string; all?: boolean }): string {
    const { namespace, index_prefix } = options ?? {};
    if (index_prefix) return `${index_prefix}-*`;
    const targets = SHIP_TARGETS ?? [];
    let matched = targets;
    if (namespace) {
      matched = targets.filter((t) => t.namespace === namespace);
      if (matched.length === 0) matched = targets;
    }
    const patterns = Array.from(new Set(matched.map((t) => `${t.indexPrefix}-*`)));
    if (patterns.length === 0) return "order-api-logs-*";
    return patterns.join(",");
  }

  return {
    osClient: { search: vi.fn() },
    SHIP_TARGETS,
    resolveIndexPattern,
  };
});

import { osClient, SHIP_TARGETS, resolveIndexPattern } from "./logShipper.js";
import { executeElkTool } from "./tools.js";

describe("resolveIndexPattern", () => {
  beforeEach(() => {
    SHIP_TARGETS.length = 0;
  });

  it("returns default pattern when no targets configured", () => {
    expect(resolveIndexPattern()).toBe("order-api-logs-*");
  });

  it("returns all target index patterns for cross-namespace query", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    expect(resolveIndexPattern()).toBe("order-api-logs-*,ingest-service-logs-*");
  });

  it("returns single namespace matched pattern", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    expect(resolveIndexPattern({ namespace: "islap" })).toBe("ingest-service-logs-*");
  });

  it("returns explicit index_prefix when provided", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" }
    );
    expect(resolveIndexPattern({ namespace: "order-service", index_prefix: "custom-logs" })).toBe("custom-logs-*");
  });

  it("falls back to all patterns when namespace not found", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" }
    );
    expect(resolveIndexPattern({ namespace: "unknown" })).toBe("order-api-logs-*");
  });

  it("deduplicates index patterns", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "shared-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "shared-logs" }
    );
    expect(resolveIndexPattern()).toBe("shared-logs-*");
  });
});

describe("executeElkTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SHIP_TARGETS.length = 0;
  });

  function mockSearchResult(hits: any[] = []) {
    const mocked = osClient.search as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValue({ body: { hits: { hits } } });
  }

  it("search_logs queries cross-namespace index pattern by default", async () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    mockSearchResult();

    const res = await executeElkTool("search_logs", { service: "order-api" });
    expect(res.success).toBe(true);
    expect(osClient.search).toHaveBeenCalledWith(
      expect.objectContaining({ index: "order-api-logs-*,ingest-service-logs-*" })
    );
  });

  it("search_logs filters by namespace and uses matched index pattern", async () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    mockSearchResult();

    const res = await executeElkTool("search_logs", { namespace: "islap", keyword: "error" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ index_pattern: "ingest-service-logs-*" });
    expect(osClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "ingest-service-logs-*",
        body: expect.objectContaining({
          query: {
            bool: {
              must: [
                { term: { namespace: "islap" } },
                { match: { message: "error" } },
              ],
            },
          },
        }),
      })
    );
  });

  it("search_logs uses explicit index_prefix over namespace", async () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" }
    );
    mockSearchResult();

    const res = await executeElkTool("search_logs", { namespace: "order-service", index_prefix: "legacy-logs" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ index_pattern: "legacy-logs-*" });
  });

  it("aggregate_by_field applies namespace filter and index pattern", async () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    const mocked = osClient.search as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValue({ body: { aggregations: { by_field: { buckets: [{ key: "ERROR", doc_count: 5 }] } } } });

    const res = await executeElkTool("aggregate_by_field", { field: "level", namespace: "islap" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ index_pattern: "ingest-service-logs-*", counts: { ERROR: 5 } });
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "ingest-service-logs-*",
        body: expect.objectContaining({
          query: { bool: { must: [{ term: { namespace: "islap" } }] } },
          aggs: { by_field: { terms: { field: "level.keyword", size: 20 } } },
        }),
      })
    );
  });

  it("get_error_timeline applies namespace filter", async () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" }
    );
    mockSearchResult();

    const res = await executeElkTool("get_error_timeline", { namespace: "order-service" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ index_pattern: "order-api-logs-*" });
    expect(osClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        index: "order-api-logs-*",
        body: expect.objectContaining({
          query: {
            bool: {
              must: [
                { terms: { "level.keyword": ["WARN", "ERROR"] } },
                { term: { namespace: "order-service" } },
              ],
            },
          },
        }),
      })
    );
  });

  it("cluster_similar_errors applies namespace filter", async () => {
    SHIP_TARGETS.push(
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    mockSearchResult();

    const res = await executeElkTool("cluster_similar_errors", { namespace: "islap" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ index_pattern: "ingest-service-logs-*" });
  });

  it("returns empty logs gracefully when index not found", async () => {
    const mocked = osClient.search as ReturnType<typeof vi.fn>;
    const err: any = new Error("index_not_found_exception");
    err.meta = { body: { error: { type: "index_not_found_exception" } } };
    mocked.mockRejectedValue(err);

    const res = await executeElkTool("search_logs", { namespace: "islap" });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ logs: [] });
  });
});
