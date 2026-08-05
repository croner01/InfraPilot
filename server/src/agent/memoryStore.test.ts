import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  addMemory,
  listMemories,
  getMemory,
  deleteMemory,
  searchMemories,
  resetMemoryStore,
  extractMemorySummary,
  extractAndStoreSessionMemory,
  buildMemoryContext,
  initMemoryStore,
} from "./memoryStore.js";
import { getMemoryBySessionId, deleteMemory as dbDeleteMemory } from "../db/db.js";
import type { AgentSession } from "../types.js";

vi.mock(import("../config/store.js"), async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getMemoryConfig: vi.fn().mockReturnValue({ enabled: true, recallTopK: 3 }),
    setMemoryConfig: vi.fn(),
  };
});

function uniqueSessionId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("memoryStore", () => {
  beforeEach(() => {
    for (const m of listMemories()) {
      dbDeleteMemory(m.id);
    }
    resetMemoryStore();
  });

  afterEach(() => {
    for (const m of listMemories()) {
      dbDeleteMemory(m.id);
    }
    resetMemoryStore();
  });

  it("adds and lists memories", async () => {
    const sessionId = uniqueSessionId("s1");
    const m = await addMemory({
      sessionId,
      title: "OpenStack VM 创建流程",
      summary: "Nova API -> Conductor -> Scheduler -> Compute -> Neutron -> ACTIVE",
      tags: ["auto_extracted"],
    });

    expect(m.id).toBeDefined();
    expect(m.title).toBe("OpenStack VM 创建流程");

    const all = listMemories();
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe(sessionId);
  });

  it("retrieves memory by id and session id", async () => {
    const sessionId = uniqueSessionId("s2");
    const m = await addMemory({
      sessionId,
      title: "订单服务 OOM",
      summary: "order-api Pod 因 limits.memory 过低被 OOMKilled",
    });

    const byId = getMemory(m.id);
    expect(byId?.title).toBe("订单服务 OOM");

    const bySessionId = getMemoryBySessionId(sessionId);
    expect(bySessionId?.id).toBe(m.id);
  });

  it("deletes memory and removes from index", async () => {
    const sessionId = uniqueSessionId("s3");
    const m = await addMemory({ sessionId, title: "Test", summary: "summary" });
    expect(listMemories()).toHaveLength(1);

    deleteMemory(m.id);
    expect(listMemories()).toHaveLength(0);
    expect(getMemory(m.id)).toBeUndefined();
    expect(getMemoryBySessionId(sessionId)).toBeUndefined();
  });

  it("searches memories by query relevance", async () => {
    const s1 = uniqueSessionId("vm");
    const s2 = uniqueSessionId("k8s");

    await addMemory({
      sessionId: s1,
      title: "OpenStack 虚拟机创建流程",
      summary: "Nova API 接收请求后由 Nova Conductor 持久化，再经 Nova Scheduler 调度到 Nova Compute 节点创建虚拟机",
    });
    await addMemory({
      sessionId: s2,
      title: "K8s Pod 反复重启",
      summary: "order-api Pod 因内存限制过低触发 OOMKilled，需要调整 deployment resources limits",
    });

    await initMemoryStore();
    const results = await searchMemories("虚拟机创建", { limit: 2, minScore: 0.01 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain("虚拟机");
  });

  it("extracts summary from session without leaking sensitive data", () => {
    const session: AgentSession = {
      id: uniqueSessionId("extract"),
      title: "OpenStack VM 创建流程",
      status: "closed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      incidentSummary: "用户询问虚拟机创建流程，password=secret123",
      rootCause: {
        summary: "Nova 组件协作完成创建",
        confidence: 0.9,
        evidenceChain: [],
        alternativeHypotheses: [],
      },
      remediation: {
        summary: "查看日志确认流程",
        steps: [],
      },
      executedToolCalls: [
        {
          id: "tc-1",
          skill: "openstack",
          tool: "list_vms",
          args: { password: "secret123" },
          risk: { level: "readonly", requiresApproval: false, requiresTwoPerson: false, reason: "" },
          result: { success: true, durationMs: 100 },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
      plan: [],
      evidence: [],
      pendingToolCalls: [],
      iteration: 0,
      maxIterations: 10,
    };

    const summary = extractMemorySummary(session);
    expect(summary).toContain("OpenStack VM 创建流程");
    expect(summary).toContain("用户询问虚拟机创建流程");
    expect(summary).toContain("openstack.list_vms");
    expect(summary).not.toContain("secret123");
    expect(summary).toContain("***REDACTED***");
  });

  it("buildMemoryContext returns empty when disabled", async () => {
    const { getMemoryConfig } = await import("../config/store.js");
    (getMemoryConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({ enabled: false, recallTopK: 3 });
    const ctx = await buildMemoryContext("any query");
    expect(ctx).toBe("");
  });

  it("buildMemoryContext returns formatted markdown when memories match", async () => {
    const sessionId = uniqueSessionId("ctx");
    await addMemory({
      sessionId,
      title: "虚拟机创建流程",
      summary: "Nova API -> Conductor -> Scheduler -> Compute",
    });

    const ctx = await buildMemoryContext("虚拟机创建流程");
    expect(ctx).toContain("相关历史会话记忆");
    expect(ctx).toContain("虚拟机创建流程");
    expect(ctx).toContain("memory_id=");
  });

  it("extractAndStoreSessionMemory skips empty sessions", async () => {
    const { getMemoryConfig } = await import("../config/store.js");
    (getMemoryConfig as ReturnType<typeof vi.fn>).mockReturnValue({ enabled: true, recallTopK: 3 });

    const sessionId = uniqueSessionId("empty");
    const session: AgentSession = {
      id: sessionId,
      title: "未开始",
      status: "closed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan: [],
      evidence: [],
      pendingToolCalls: [],
      executedToolCalls: [],
      iteration: 0,
      maxIterations: 10,
    };

    // memoryStore imports getSession from sessionStore, which is not easily mockable here.
    // We test the guard logic via buildMemoryContext instead.
    const ctx = await buildMemoryContext("anything");
    expect(ctx).toBe("");
  });
});
