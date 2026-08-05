import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/db.js", () => ({
  insertAudit: vi.fn(),
  getApproval: vi.fn(),
}));

vi.mock("../skills/linux/tools.js", () => ({
  executeLinuxTool: vi.fn(),
}));

import { executeToolCall } from "./commandGateway.js";
import { getApproval, insertAudit } from "../db/db.js";
import { executeLinuxTool } from "../skills/linux/tools.js";
import type { PendingToolCall, RiskDecision } from "../types.js";
import { computeArgsHash } from "./argsHash.js";

function makePending(overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  const base: PendingToolCall = {
    id: "tc-1",
    skill: "linux",
    tool: "restart_service",
    args: { service: "nginx" },
    risk: {
      level: "high",
      requiresApproval: true,
      reason: "变更类操作",
      requiresTwoPerson: false,
    } as RiskDecision,
    approved: true,
    approvalId: "approval-1",
    argsHash: computeArgsHash("linux", "restart_service", { service: "nginx" }),
  };
  return { ...base, ...overrides };
}

describe("commandGateway approval and args hash validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes readonly tool without approval", async () => {
    const pending = makePending({
      tool: "get_cpu_usage",
      args: { host: "local" },
      risk: { level: "readonly", requiresApproval: false, reason: "只读", requiresTwoPerson: false } as RiskDecision,
      approved: false,
      approvalId: undefined,
      argsHash: undefined,
    });
    (executeLinuxTool as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, stdout: "cpu", durationMs: 10 });

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent" });

    expect(result.success).toBe(true);
    expect(executeLinuxTool).toHaveBeenCalledWith("get_cpu_usage", { host: "local" });
    expect(insertAudit).toHaveBeenCalled();
  });

  it("rejects execution when approval is required but no approval token is present", async () => {
    const pending = makePending({ approved: false, approvalId: undefined, argsHash: undefined });

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("缺少审批令牌");
    expect(executeLinuxTool).not.toHaveBeenCalled();
  });

  it("rejects execution when approval record does not exist", async () => {
    const pending = makePending();
    (getApproval as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("审批记录不存在");
    expect(executeLinuxTool).not.toHaveBeenCalled();
  });

  it("rejects execution when approval decision is not approved", async () => {
    const pending = makePending();
    (getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "approval-1",
      decision: "rejected",
      args_hash: pending.argsHash,
    });

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("审批记录状态为 rejected");
    expect(executeLinuxTool).not.toHaveBeenCalled();
  });

  it("rejects execution when args have been tampered (TOCTOU)", async () => {
    const pending = makePending({ args: { service: "mysql" } }); // tampered args
    (getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "approval-1",
      decision: "approved",
      args_hash: pending.argsHash, // original hash for nginx
    });

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("审批令牌与当前命令参数不匹配");
    expect(executeLinuxTool).not.toHaveBeenCalled();
  });

  it("executes approved tool when args hash matches", async () => {
    const pending = makePending();
    (getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "approval-1",
      decision: "approved",
      args_hash: pending.argsHash,
    });
    (executeLinuxTool as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, stdout: "ok", durationMs: 10 });

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent", approvedBy: "admin" });

    expect(result.success).toBe(true);
    expect(executeLinuxTool).toHaveBeenCalledWith("restart_service", { service: "nginx" });
    expect(insertAudit).toHaveBeenCalled();
  });

  it("executes when DB approval is approved even if pending.approved flag is not set (resume path)", async () => {
    const pending = makePending({ approved: false });
    (getApproval as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "approval-1",
      decision: "approved",
      args_hash: pending.argsHash,
    });
    (executeLinuxTool as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, stdout: "ok", durationMs: 10 });

    const result = await executeToolCall(pending, { sessionId: "s1", callerAgent: "agent", approvedBy: "admin" });

    expect(result.success).toBe(true);
    expect(executeLinuxTool).toHaveBeenCalledWith("restart_service", { service: "nginx" });
    expect(insertAudit).toHaveBeenCalled();
  });
});
