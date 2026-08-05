import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// mock OpenSearch 客户端包，避免测试发起真实连接
vi.mock("@opensearch-project/opensearch", () => ({
  Client: class {
    bulk = vi.fn().mockResolvedValue({});
    search = vi.fn();
    indices = { putIndexTemplate: vi.fn() };
    cluster = { health: vi.fn() };
  },
}));

import {
  SHIP_TARGETS,
  SHIP_STATUS,
  findPodLogFiles,
  resolveIndexPattern,
  shipOnce,
  getShipStatus,
  osClient,
  type ShipTarget,
} from "./logShipper.js";

describe("resolveIndexPattern", () => {
  beforeEach(() => {
    SHIP_TARGETS.length = 0;
  });

  it("returns legacy default pattern when no targets and no explicit scope", () => {
    expect(resolveIndexPattern()).toBe("order-api-logs-*");
  });

  it("returns all target patterns for cross-namespace query", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" }
    );
    expect(resolveIndexPattern()).toBe("order-api-logs-*,ingest-service-logs-*");
  });

  it("returns the matched namespace pattern", () => {
    SHIP_TARGETS.push({ namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "ingest-service-logs" });
    expect(resolveIndexPattern({ namespace: "islap" })).toBe("ingest-service-logs-*");
  });

  it("returns empty pattern when explicit namespace has no target instead of silent fallback", () => {
    SHIP_TARGETS.push({ namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" });
    expect(resolveIndexPattern({ namespace: "unknown-ns" })).toBe("");
  });

  it("prefers explicit index_prefix over namespace", () => {
    SHIP_TARGETS.push({ namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" });
    expect(resolveIndexPattern({ namespace: "order-service", index_prefix: "custom-logs" })).toBe("custom-logs-*");
  });

  it("deduplicates index patterns", () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "shared-logs" },
      { namespace: "islap", podNamePrefix: "ingest-service", indexPrefix: "shared-logs" }
    );
    expect(resolveIndexPattern()).toBe("shared-logs-*");
  });
});

describe("findPodLogFiles", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pods-test-"));
    process.env.PODS_LOG_ROOT = root;
  });

  afterEach(() => {
    delete process.env.PODS_LOG_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mkLog(namespace: string, pod: string, container: string): string {
    const dir = path.join(root, `${namespace}_${pod}_uid-123`, container);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "0.log");
    fs.writeFileSync(file, '2026-08-05T00:00:00.000Z stdout F {"level":"INFO","message":"boot"}\n');
    return file;
  }

  it("matches all pods in namespace when podNamePrefix is empty", () => {
    mkLog("order-service", "order-api-abc", "order-api");
    mkLog("order-service", "ingest-xyz", "ingest");
    mkLog("islap", "other", "other");

    const files = findPodLogFiles("order-service", "");
    expect(files.map((f) => f.podName).sort()).toEqual(["ingest-xyz", "order-api-abc"]);
  });

  it("filters by podNamePrefix when provided", () => {
    mkLog("order-service", "order-api-abc", "order-api");
    mkLog("order-service", "ingest-xyz", "ingest");

    const files = findPodLogFiles("order-service", "order-api");
    expect(files).toHaveLength(1);
    expect(files[0].podName).toBe("order-api-abc");
  });

  it("returns empty when the pod log root does not exist", () => {
    process.env.PODS_LOG_ROOT = path.join(root, "missing");
    expect(findPodLogFiles("order-service", "")).toEqual([]);
  });
});

describe("shipOnce status tracking", () => {
  let root: string;
  const target: ShipTarget = { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pods-test-"));
    process.env.PODS_LOG_ROOT = root;
    SHIP_TARGETS.length = 0;
    SHIP_STATUS.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PODS_LOG_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function mkOrderLog(): void {
    const dir = path.join(root, "order-service_order-api-abc_uid-123", "order-api");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "0.log"), '2026-08-05T00:00:00.000Z stdout F {"level":"INFO","message":"boot"}\n');
  }

  it("records fileCount, shipped count and timestamps after a successful ship", async () => {
    mkOrderLog();

    const res = await shipOnce(target);

    expect(res.shipped).toBe(1);
    const status = SHIP_STATUS.get("order-service|order-api|order-api-logs");
    expect(status?.fileCount).toBe(1);
    expect(status?.lastShippedCount).toBe(1);
    expect(status?.lastShippedAt).toBeTruthy();
    expect(status?.lastScannedAt).toBeTruthy();
    expect(status?.lastError).toBeUndefined();
  });

  it("warns only once when a target matches zero files", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await shipOnce(target);
    await shipOnce(target);

    const zeroFileWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("0 个日志文件"));
    expect(zeroFileWarns).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("records lastError when the bulk write fails", async () => {
    mkOrderLog();
    const bulkMock = osClient.bulk as unknown as ReturnType<typeof vi.fn>;
    bulkMock.mockRejectedValueOnce(new Error("boom"));

    await expect(shipOnce(target)).rejects.toThrow("boom");

    const status = SHIP_STATUS.get("order-service|order-api|order-api-logs");
    expect(status?.lastError).toContain("boom");
    expect(status?.lastErrorAt).toBeTruthy();
  });

  it("getShipStatus returns an entry for each configured target", () => {
    SHIP_TARGETS.push(target);

    const statuses = getShipStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].target.indexPrefix).toBe("order-api-logs");
  });
});
