import { describe, it, expect } from "vitest";
import {
  insertApproval,
  getApproval,
  db,
  upsertSession,
  getSession,
  insertTimelineEvent,
  insertAudit,
  saveCheckpoint,
  deleteSession,
} from "./db.js";

describe("insertApproval", () => {
  it("inserts an approval row that getApproval can read back", () => {
    insertApproval({
      id: "test-approval-1",
      sessionId: "test-session",
      skill: "k8s",
      tool: "patch_resource_limits",
      args: "{}",
      argsHash: "hash-1",
      riskLevel: "high",
      diffPreview: "diff",
    });

    const row = getApproval("test-approval-1");
    expect(row?.decision).toBe("pending");
    expect(row?.args_hash).toBe("hash-1");
    expect(row?.risk_level).toBe("high");

    db.prepare("DELETE FROM approvals WHERE id = ?").run("test-approval-1");
  });
});

describe("deleteSession", () => {
  it("removes the session row and all related rows", () => {
    const id = `del-${Date.now()}`;
    upsertSession(id, "test", "closed", JSON.stringify({ id }));
    insertTimelineEvent({ id: `te-${id}`, session_id: id, type: "status", payload: "{}", timestamp: "2026-08-06T00:00:00.000Z" });
    insertApproval({
      id: `ap-${id}`,
      sessionId: id,
      skill: "k8s",
      tool: "patch_resource_limits",
      args: "{}",
      argsHash: "hash",
      riskLevel: "high",
      diffPreview: "diff",
    });
    insertAudit({
      id: `au-${id}`,
      sessionId: id,
      callerAgent: "test",
      skill: "k8s",
      tool: "patch_resource_limits",
      args: "{}",
      riskLevel: "high",
      approvalId: null,
      approvedBy: null,
      success: 1,
      resultSummary: "ok",
      startedAt: "2026-08-06T00:00:00.000Z",
      finishedAt: "2026-08-06T00:00:00.000Z",
    });
    saveCheckpoint(id, "{}");

    expect(deleteSession(id)).toBe(true);

    expect(getSession(id)).toBeUndefined();
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id) as { n: number }).n;
    expect(count("timeline_events")).toBe(0);
    expect(count("approvals")).toBe(0);
    expect(count("audit_log")).toBe(0);
    expect(count("session_checkpoints")).toBe(0);
  });

  it("returns false when the session does not exist", () => {
    expect(deleteSession("no-such-session")).toBe(false);
  });
});
