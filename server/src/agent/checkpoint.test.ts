import { describe, it, expect, beforeEach } from "vitest";
import { saveCheckpoint, loadCheckpoint, deleteCheckpoint } from "./checkpoint.js";
import { db, listAwaitingApprovalSessions, upsertSession } from "../db/db.js";
import type { AgentCheckpoint, AgentSession } from "../types.js";

function resetCheckpoints() {
  db.prepare("DELETE FROM session_checkpoints").run();
  db.prepare("DELETE FROM sessions").run();
}

function makeCheckpoint(sessionId: string): AgentCheckpoint {
  return {
    sessionId,
    history: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ],
    iteration: 1,
    status: "planning",
    createdAt: new Date().toISOString(),
  };
}

describe("checkpoint persistence", () => {
  beforeEach(() => {
    resetCheckpoints();
  });

  it("saves and loads a checkpoint", () => {
    const cp = makeCheckpoint("session-1");
    saveCheckpoint(cp);

    const loaded = loadCheckpoint("session-1");
    expect(loaded).toBeDefined();
    expect(loaded?.sessionId).toBe("session-1");
    expect(loaded?.history).toEqual(cp.history);
    expect(loaded?.iteration).toBe(1);
    expect(loaded?.status).toBe("planning");
  });

  it("returns undefined for missing checkpoint", () => {
    expect(loadCheckpoint("missing")).toBeUndefined();
  });

  it("updates an existing checkpoint", () => {
    const cp1 = makeCheckpoint("session-1");
    saveCheckpoint(cp1);

    const cp2: AgentCheckpoint = {
      ...cp1,
      iteration: 2,
      status: "executing",
      history: [...cp1.history, { role: "assistant", content: "ok" }],
    };
    saveCheckpoint(cp2);

    const loaded = loadCheckpoint("session-1");
    expect(loaded?.iteration).toBe(2);
    expect(loaded?.status).toBe("executing");
    expect(loaded?.history).toHaveLength(3);
  });

  it("deletes a checkpoint", () => {
    saveCheckpoint(makeCheckpoint("session-1"));
    expect(loadCheckpoint("session-1")).toBeDefined();

    deleteCheckpoint("session-1");
    expect(loadCheckpoint("session-1")).toBeUndefined();
  });
});

describe("awaiting approval session recovery", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM sessions").run();
  });

  it("lists sessions awaiting approval", () => {
    const session: AgentSession = {
      id: "s-await",
      title: "awaiting",
      status: "awaiting_approval",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    plan: [],
    evidence: [],
    hypotheses: [],
    hypotheses: [],
      pendingToolCalls: [],
      executedToolCalls: [],
      iteration: 1,
      maxIterations: 10,
    };
    const closed: AgentSession = {
      id: "s-closed",
      title: "closed",
      status: "closed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plan: [],
      evidence: [],
      pendingToolCalls: [],
      executedToolCalls: [],
      iteration: 1,
      maxIterations: 10,
    };
    upsertSession(session.id, session.title, session.status, JSON.stringify(session));
    upsertSession(closed.id, closed.title, closed.status, JSON.stringify(closed));

    const awaiting = listAwaitingApprovalSessions();
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].id).toBe("s-await");
  });
});
