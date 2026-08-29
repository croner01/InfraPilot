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
vi.mock("../skills/packages/select.js", () => ({
  selectSkillsForTurn: vi.fn().mockResolvedValue([]),
  toSkillDoc: vi.fn((p: { name: string; frontmatter: { description: string }; body: string }) => ({
    name: p.name,
    description: p.frontmatter.description,
    body: p.body,
  })),
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
  buildSkillContext: vi.fn(() => ""),
}));

vi.mock("./memoryStore.js", () => ({
  buildMemoryContext: vi.fn().mockResolvedValue(""),
  extractAndStoreSessionMemory: vi.fn().mockResolvedValue(undefined),
  resetMemoryStore: vi.fn(),
}));

import { openai } from "../llm/client.js";
import { classifyRisk } from "../gateway/policy.js";
import { executeToolCall } from "../gateway/commandGateway.js";
import { getSession } from "./sessionStore.js";
import { buildRegistry, recallTools } from "../skills/registry/skillRegistry.js";
import { startAgentTurn } from "./orchestrator.js";
import { createInitialCheckpoint } from "./runner.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import type { AgentSession, AgentCheckpoint, RiskDecision, ToolDef } from "../types.js";

function resetState() {
  savedCheckpoints.clear();
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
    hypotheses: [],
    pendingToolCalls: [],
    executedToolCalls: [],
    iteration: 0,
    maxIterations: 10,
  };
}

function readonlyRisk(): RiskDecision {
  return { level: "readonly", requiresApproval: false, reason: "只读", requiresTwoPerson: false };
}

const dummyTool: ToolDef = {
  name: "get_cpu_usage",
  skill: "linux",
  description: "get cpu",
  risk: "readonly",
  parameters: { type: "object", properties: {} },
};

describe("agent orchestrator", () => {
  beforeEach(() => {
    resetState();
    sessions.clear();
    vi.clearAllMocks();
    (buildRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (recallTools as ReturnType<typeof vi.fn>).mockResolvedValue([{ tool: dummyTool, score: 1 }]);
  });

  it("creates initial checkpoint on first turn", async () => {
    const sessionId = "s1";
    sessions.set(sessionId, makeSession(sessionId));

    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "收到。" } }],
    });

    await startAgentTurn(sessionId, "pod 内存不足");

    const session = getSession(sessionId);
    expect(session?.status).toBe("closed");
    const cp = loadCheckpoint(sessionId);
    expect(cp).toBeDefined();
    expect(cp?.history).toHaveLength(3); // system + user + assistant
    expect(cp?.history[1]).toEqual({ role: "user", content: "pod 内存不足" });
  });

  it("appends user message to existing checkpoint and preserves context", async () => {
    const sessionId = "s-vm-flowchart";
    sessions.set(sessionId, makeSession(sessionId));

    // 第一轮：虚拟机创建流程
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "OpenStack 虚拟机创建流程包括：Nova API 接收请求 -> Nova Conductor 持久化 -> Nova Scheduler 调度 -> Nova Compute 创建 -> Neutron 分配网络 -> Glance/Cinder 提供镜像存储 -> ACTIVE。",
          },
        },
      ],
    });

    await startAgentTurn(sessionId, "虚拟机创建流程");

    // 第二轮：追问画流程图，复用同一个 checkpoint
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: "好的，基于上文虚拟机创建流程生成流程图。",
          },
        },
      ],
    });

    await startAgentTurn(sessionId, "创建流程图");

    const cp = loadCheckpoint(sessionId);
    expect(cp).toBeDefined();
    // system + user1 + assistant1 + user2 + assistant2
    expect(cp?.history).toHaveLength(5);
    expect(cp?.history[1]).toEqual({ role: "user", content: "虚拟机创建流程" });
    expect(cp?.history[3]).toEqual({ role: "user", content: "创建流程图" });
    expect(String(cp?.history[2].content)).toContain("Nova API");
  });

  it("uses previous VM creation context to generate flowchart", async () => {
    const sessionId = "s-vm-flowchart-tool";
    sessions.set(sessionId, makeSession(sessionId));

    const drawioTool: ToolDef = {
      name: "generate_flowchart",
      skill: "drawio",
      description: "根据日志调用/依赖关系生成 draw.io 流程图",
      risk: "readonly",
      parameters: {
        type: "object",
        properties: {
          log_relations: { type: "array" },
          output_path: { type: "string" },
          title: { type: "string" },
        },
        required: ["log_relations", "output_path"],
      },
    };

    // 第一轮：回答流程
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: "虚拟机创建流程：Nova API -> Nova Conductor -> Nova Scheduler -> Nova Compute -> Neutron -> Glance/Cinder -> ACTIVE",
          },
        },
      ],
    });

    await startAgentTurn(sessionId, "虚拟机创建流程");

    // 第二轮：追问画流程图，召回 drawio 工具并调用 generate_flowchart
    (recallTools as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ tool: drawioTool, score: 1 }]);
    (classifyRisk as ReturnType<typeof vi.fn>).mockReturnValue(readonlyRisk());
    (executeToolCall as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { output_path: "/tmp/vm-flowchart.drawio", node_count: 7, edge_count: 6 },
      durationMs: 10,
    });

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
                function: {
                  name: "drawio__generate_flowchart",
                  arguments: JSON.stringify({
                    log_relations: [
                      { source: "Nova API", target: "Nova Conductor", relation: "转发请求" },
                      { source: "Nova Conductor", target: "Nova Scheduler", relation: "发送 build 任务" },
                      { source: "Nova Scheduler", target: "Nova Compute", relation: "选定节点" },
                      { source: "Nova Compute", target: "Neutron", relation: "分配网络" },
                      { source: "Nova Compute", target: "Glance/Cinder", relation: "获取镜像/存储" },
                    ],
                    output_path: "vm-flowchart.drawio",
                    title: "OpenStack 虚拟机创建流程",
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    // 第三轮 LLM 调用返回总结
    (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "流程图已生成。" } }],
    });

    await startAgentTurn(sessionId, "创建流程图");

    const cp = loadCheckpoint(sessionId);
    expect(cp?.history).toHaveLength(7); // system + user1 + assistant1 + user2 + assistant2(tool_call) + tool + assistant3
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });
});
