import { describe, it, expect } from "vitest";
import { insertApproval, getApproval, db } from "./db.js";

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
