import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentCheckpoint, AgentSession } from "../types.js";

vi.mock("./runner.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue({ done: true }),
  createInitialCheckpoint: vi.fn(),
}));
vi.mock("./checkpoint.js", () => ({
  loadCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
  deleteCheckpoint: vi.fn(),
}));
vi.mock("../skills/packages/select.js", () => ({
  selectSkillsForTurn: vi.fn().mockResolvedValue([
    { name: "ceph-rbd-108", frontmatter: { description: "d" }, body: "正文" },
  ]),
  toSkillDoc: (p: { name: string; frontmatter: { description: string }; body: string }) => ({
    name: p.name,
    description: p.frontmatter.description,
    body: p.body,
  }),
}));
vi.mock("./prompts.js", () => ({
  buildSkillContext: vi.fn(() => "SKILL_CTX"),
}));

const sessions = new Map<string, AgentSession>();
vi.mock("./sessionStore.js", () => ({
  getSession: vi.fn((id: string) => sessions.get(id)),
  updateSession: vi.fn((id: string, mutator: (s: AgentSession) => void) => {
    const s = sessions.get(id);
    if (!s) throw new Error("not found");
    mutator(s);
    return s;
  }),
  emitEvent: vi.fn(),
}));

import { startAgentTurn } from "./orchestrator.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";

function makeSession(): AgentSession {
  return {
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
  };
}

describe("per-turn skill refresh preserves history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessions.clear();
    sessions.set("s1", makeSession());
  });

  it("appends skill system message and user message, keeps prior history intact", async () => {
    const history = [
      { role: "system" as const, content: "original system" },
      { role: "user" as const, content: "上一轮问题" },
      { role: "assistant" as const, content: "上一轮回答" },
    ];
    (loadCheckpoint as ReturnType<typeof vi.fn>).mockReturnValue({
      sessionId: "s1",
      history: history.map((m) => ({ ...m })),
      iteration: 5,
      status: "concluded",
      createdAt: new Date().toISOString(),
    } as AgentCheckpoint);

    await startAgentTurn("s1", "换个问题再问");

    const saved = (saveCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentCheckpoint;
    expect(saved.history.slice(0, 3)).toEqual(history); // 历史原样保留
    expect(saved.history[3].role).toBe("system");
    expect(String(saved.history[3].content)).toContain("SKILL_CTX");
    expect(saved.history[4]).toEqual({ role: "user", content: "换个问题再问" });
    expect(sessions.get("s1")?.activeSkills).toEqual(["ceph-rbd-108"]);
  });
});
