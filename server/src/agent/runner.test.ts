import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../llm/client.js", () => ({
  openai: {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  },
  getReasoningModel: () => "test-model",
}));

vi.mock("../skills/registry/skillRegistry.js", () => ({
  buildRegistry: vi.fn(),
  recallTools: vi.fn(),
}));

vi.mock("../skills/knowledge/store.js", () => ({
  searchKnowledgeCases: vi.fn().mockResolvedValue([]),
  addKnowledgeCase: vi.fn(),
}));

vi.mock("../gateway/commandGateway.js", () => ({
  executeToolCall: vi.fn(),
}));

vi.mock("../gateway/policy.js", () => ({
  ALL_TOOLS: [],
  classifyRisk: vi.fn(),
  renderDiffPreview: vi.fn(),
}));

const savedCheckpoints = new Map<string, AgentCheckpoint>();

vi.mock("./checkpoint.js", () => ({
  saveCheckpoint: vi.fn((cp: AgentCheckpoint) => savedCheckpoints.set(cp.sessionId, JSON.parse(JSON.stringify(cp)))),
  loadCheckpoint: vi.fn((sessionId: string) => savedCheckpoints.get(sessionId)),
  deleteCheckpoint: vi.fn((sessionId: string) => savedCheckpoints.delete(sessionId)),
}));

vi.mock(import("../db/db.js"), async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    insertApproval: vi.fn(),
    decideApproval: vi.fn(),
    getApproval: vi.fn(),
  };
});

const sessions = new Map<string, AgentSession>();

vi.mock("./sessionStore.js", () => ({
  getSession: vi.fn((id: string) => sessions.get(id)),
  updateSession: vi.fn((id: string, mutator: (s: AgentSession) => void) => {
    const session = sessions.get(id);
    if (!session) throw new Error(`session ${id} not found`);
    mutator(session);
    session.updatedAt = new Date().toISOString();
    return session;
  }),
  emitEvent: vi.fn(),
}));

vi.mock("./prompts.js", () => ({
  buildSystemPrompt: vi.fn((tools: string) => `system prompt\n${tools}`),
}));

vi.mock("./memoryStore.js", () => ({
  buildMemoryContext: vi.fn().mockResolvedValue(""),
  extractAndStoreSessionMemory: vi.fn().mockResolvedValue(undefined),
  resetMemoryStore: vi.fn(),
}));

import { openai } from "../llm/client.js";
import { classifyRisk, renderDiffPreview } from "../gateway/policy.js";
import { executeToolCall } from "../gateway/commandGateway.js";
import { getSession, updateSession, emitEvent } from "./sessionStore.js";
import { insertApproval, getApproval, db } from "../db/db.js";
import { buildRegistry, recallTools } from "../skills/registry/skillRegistry.js";
import { runAgentStep, createInitialCheckpoint } from "./runner.js";
import { loadCheckpoint, deleteCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { buildMemoryContext } from "./memoryStore.js";
import type { AgentSession, AgentCheckpoint, RiskDecision, ToolDef } from "../types.js";

function resetState() {
  savedCheckpoints.clear();
}

function resetDb() {
  db.prepare("DELETE FROM session_checkpoints").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM approvals").run();
  db.prepare("DELETE FROM audit_log").run();
}

function makeSession(id: string): AgentSession {
  return {
    id,
    title: "test session",
    status: "intake",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: [],
    evidence: [],
    pendingToolCalls: [],
    executedToolCalls: [],
    iteration: 0,
    maxIterations: 10,
  };
}

function readonlyRisk(): RiskDecision {
  return { level: "readonly", requiresApproval: false, reason: "只读", requiresTwoPerson: false };
}

function highRisk(): RiskDecision {
  return { level: "high", requiresApproval: true, reason: "变更", requiresTwoPerson: false };
}

const dummyTool: ToolDef = {
  name: "get_cpu_usage",
  skill: "linux",
  description: "get cpu",
  risk: "readonly",
  parameters: { type: "object", properties: {} },
};

describe("agent runner", () => {
  beforeEach(() => {
    resetDb();
    sessions.clear();
    vi.clearAllMocks();
    (buildRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (recallTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ tool: dummyTool, score: 1 }]);
    (renderDiffPreview as ReturnType<typeof vi.fn>).mockReturnValue("diff preview");
  });

  it("creates initial checkpoint with user message", async () => {
    const sessionId = "s1";
    sessions.set(sessionId, makeSession(sessionId));

    const cp = await createInitialCheckpoint(sessionId, "pod 内存不足");

    expect(cp.sessionId).toBe(sessionId);
    expect(cp.history).toHaveLength(2);
    expect(cp.history[1]).toEqual({ role: "user", content: "pod 内存不足" });
    expect(loadCheckpoint(sessionId)).toBeDefined();
  });

  it("executes readonly tool and continues until done", async () => {
    const sessionId = "s1";
    const session = makeSession(sessionId);
    sessions.set(sessionId, session);
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue(readonlyRisk());
    (executeToolCall as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: "cpu 10%", durationMs: 10 });

    // 第一次 LLM 调用返回一个 tool_call
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "linux__get_cpu_usage", arguments: JSON.stringify({ host: "local" }) },
              },
            ],
          },
        },
      ],
    });

    // 第二次 LLM 调用返回结论，无 tool_calls
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "【根因分析结论】内存不足" } }],
    });

    const cp = await createInitialCheckpoint(sessionId, "pod 内存不足");
    const { done } = await runAgentStep(sessionId, cp);

    expect(done).toBe(true);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(session.executedToolCalls).toHaveLength(1);
    expect(session.status).toBe("concluded");
    // checkpoint 保留以便后续追问能延续上下文
    expect(loadCheckpoint(sessionId)).toBeDefined();
  });

  it("populates plan and remediation from assistant content", async () => {
    const sessionId = "s1";
    const session = makeSession(sessionId);
    sessions.set(sessionId, session);

    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "【诊断计划】\n1. 查看 Pod 状态\n2. 检索错误日志\n【修复方案】\n1. 调整内存 limit: k8s.patch_resource_limits",
          },
        },
      ],
    });

    const cp = await createInitialCheckpoint(sessionId, "pod 重启");
    const { done } = await runAgentStep(sessionId, cp);

    expect(done).toBe(true);
    expect(session.plan).toEqual(["查看 Pod 状态", "检索错误日志"]);
    expect(session.remediation?.steps).toHaveLength(1);
    expect(session.remediation?.steps[0].skill).toBe("k8s");
    expect(session.remediation?.steps[0].tool).toBe("patch_resource_limits");
    expect(emitEvent).toHaveBeenCalledWith(
      sessionId,
      "plan_update",
      expect.objectContaining({ plan: ["查看 Pod 状态", "检索错误日志"] })
    );
    expect(emitEvent).toHaveBeenCalledWith(sessionId, "remediation_plan", expect.objectContaining({ steps: expect.any(Array) }));
  });

  it("saves checkpoint and exits when encountering high-risk tool", async () => {
    const sessionId = "s1";
    const session = makeSession(sessionId);
    sessions.set(sessionId, session);
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue(highRisk());

    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "linux__restart_service", arguments: JSON.stringify({ service: "nginx" }) },
              },
            ],
          },
        },
      ],
    });

    const cp = await createInitialCheckpoint(sessionId, "需要重启服务");
    const { done, awaitingApproval } = await runAgentStep(sessionId, cp);

    expect(done).toBe(false);
    expect(awaitingApproval).toBe(true);
    expect(session.status).toBe("awaiting_approval");
    expect(insertApproval).toHaveBeenCalled();

    const saved = loadCheckpoint(sessionId);
    expect(saved).toBeDefined();
    expect(saved?.pendingToolCall).toBeDefined();
    expect(saved?.pendingToolCall?.tool).toBe("restart_service");
  });

  it("resumes from checkpoint after approval and continues", async () => {
    const sessionId = "s1";
    const session = makeSession(sessionId);
    session.status = "awaiting_approval";
    sessions.set(sessionId, session);

    // 创建带 pendingToolCall 的 checkpoint
    const cp = await createInitialCheckpoint(sessionId, "需要重启服务");
    cp.status = "awaiting_approval";
    cp.pendingToolCall = {
      id: "tc-1",
      skill: "linux",
      tool: "restart_service",
      args: { service: "nginx" },
      risk: highRisk(),
      approvalId: "approval-1",
      approved: true,
      argsHash: "hash",
    };

    (getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "approval-1",
      decision: "approved",
      decided_by: "admin",
      args_hash: "hash",
    });
    (executeToolCall as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: "restarted", durationMs: 10 });

    // 恢复后 LLM 返回结论
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "已完成重启" } }],
    });

    const { done } = await runAgentStep(sessionId, cp);

    expect(done).toBe(true);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(session.executedToolCalls).toHaveLength(1);
    // checkpoint 保留以便后续追问能延续上下文
    expect(loadCheckpoint(sessionId)).toBeDefined();
  });

  it("emits checkpoint_saved event after each state change", async () => {
    const sessionId = "s1";
    const session = makeSession(sessionId);
    sessions.set(sessionId, session);
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue(readonlyRisk());
    (executeToolCall as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: "cpu 10%", durationMs: 10 });

    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "linux__get_cpu_usage", arguments: JSON.stringify({ host: "local" }) },
              },
            ],
          },
        },
      ],
    });

    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "【根因分析结论】内存不足" } }],
    });

    const cp = await createInitialCheckpoint(sessionId, "pod 内存不足");
    await runAgentStep(sessionId, cp);

    const calls = (emitEvent as ReturnType<typeof vi.fn>).mock.calls;
    const savedCalls = calls.filter((c) => c[1] === "checkpoint_saved");
    expect(savedCalls.length).toBeGreaterThan(0);
  });

  it("injects cross-session memory context into system prompt", async () => {
    const sessionId = "s-memory-ctx";
    sessions.set(sessionId, makeSession(sessionId));

    (buildMemoryContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "\n# 相关历史会话记忆\n- memory_id=m1 虚拟机创建流程\n"
    );

    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "收到。" } }],
    });

    const cp = await createInitialCheckpoint(sessionId, "画个虚拟机创建的流程图");
    await runAgentStep(sessionId, cp);

    const calls = (openai.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls;
    const firstCall = calls[0];
    const messages = firstCall[0].messages as Array<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("相关历史会话记忆");
    expect(systemMsg?.content).toContain("虚拟机创建流程");
  });
});
