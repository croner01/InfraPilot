import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../llm/client.js", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
  getReasoningModel: () => "test-model",
}));
vi.mock("../skills/registry/skillRegistry.js", () => ({
  buildRegistry: vi.fn(),
  recallTools: vi.fn().mockResolvedValue([]),
}));
vi.mock("../skills/knowledge/store.js", () => ({
  searchKnowledgeCases: vi.fn().mockResolvedValue([]),
  addKnowledgeCase: vi.fn(),
}));
vi.mock("../skills/packages/select.js", () => ({
  selectSkillsForTurn: vi.fn().mockResolvedValue([
    { name: "ceph-rbd-108", frontmatter: { description: "d" }, body: "技能正文" },
  ]),
  toSkillDoc: (p: { name: string; frontmatter: { description: string }; body: string }) => ({
    name: p.name,
    description: p.frontmatter.description,
    body: p.body,
  }),
}));
vi.mock("../gateway/commandGateway.js", () => ({ executeToolCall: vi.fn() }));
vi.mock("../gateway/policy.js", () => ({
  ALL_TOOLS: [],
  classifyRisk: vi.fn(),
  renderDiffPreview: vi.fn(),
}));
vi.mock("./checkpoint.js", () => ({
  saveCheckpoint: vi.fn(),
  loadCheckpoint: vi.fn(),
  deleteCheckpoint: vi.fn(),
}));
vi.mock("./prompts.js", () => ({
  buildSystemPrompt: vi.fn((tools: string) => `system prompt\n${tools}`),
  buildSkillContext: vi.fn((skills: Array<{ name: string }>) => `SKILL_CTX:${skills.map((s) => s.name).join(",")}`),
}));
vi.mock("./memoryStore.js", () => ({
  buildMemoryContext: vi.fn().mockResolvedValue(""),
  extractAndStoreSessionMemory: vi.fn().mockResolvedValue(undefined),
  resetMemoryStore: vi.fn(),
}));

import type { AgentSession } from "../types.js";

const sessionForSkills = {
  id: "s1",
  title: "t",
  status: "planning",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  plan: [],
  evidence: [],
  hypotheses: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 0,
  maxIterations: 10,
} as AgentSession;

vi.mock("./sessionStore.js", () => ({
  getSession: vi.fn(() => sessionForSkills),
  updateSession: vi.fn((id: string, mutator: (s: AgentSession) => void) => {
    mutator(sessionForSkills);
    return sessionForSkills;
  }),
  emitEvent: vi.fn(),
}));

import { createInitialCheckpoint } from "./runner.js";
import { buildSystemPrompt, buildSkillContext } from "./prompts.js";

describe("runner skill injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects recalled skill body into the initial system prompt", async () => {
    const cp = await createInitialCheckpoint("s1", "mariadb rbd 108 排查");
    const systemMsg = cp.history[0];
    expect(systemMsg.role).toBe("system");
    expect(buildSkillContext).toHaveBeenCalled();
    expect(String(systemMsg.content)).toContain("SKILL_CTX:ceph-rbd-108");
    expect(buildSystemPrompt).toHaveBeenCalled();
  });
});
