// ============================================================================
// Command Gateway — 对应设计文档 §8.3
// 唯一的工具执行入口。职责: 校验审批令牌有效性 -> (可能的)Dry-run -> 正式执行
// -> 写审计日志。Agent 侧不能绕过此模块直接调用 Skill 的 executeXxxTool()。
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import { PendingToolCall, ToolExecutionResult } from "../types.js";
import { executeLinuxTool } from "../skills/linux/tools.js";
import { executeK8sTool } from "../skills/k8s/tools.js";
import { executeElkTool } from "../skills/elk/tools.js";
import { executeClickhouseTool } from "../skills/clickhouse/tools.js";
import { insertAudit } from "../db/db.js";

async function dispatch(skill: string, tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  switch (skill) {
    case "linux":
      return executeLinuxTool(tool, args);
    case "k8s":
      return executeK8sTool(tool, args);
    case "elk":
      return executeElkTool(tool, args);
    case "clickhouse":
      return executeClickhouseTool(tool, args);
    default:
      return { success: false, error: `未知skill: ${skill}`, durationMs: 0 };
  }
}

export interface ExecuteOptions {
  sessionId: string;
  callerAgent: string;
  approvedBy?: string; // 若为 undefined 且 requiresApproval=true, Gateway 会拒绝执行
}

/**
 * 执行一个已通过风险判定的工具调用。
 * - readonly/low: 直接执行
 * - medium/high/critical: 必须携带 approvedBy, 且 pendingCall.approved === true,
 *   审批令牌(approvalId)必须与本次 tool+args 一致(防篡改, 对应§8.3第2点)
 */
export async function executeToolCall(pendingCall: PendingToolCall, opts: ExecuteOptions): Promise<ToolExecutionResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  if (pendingCall.risk.requiresApproval && !pendingCall.approved) {
    const result: ToolExecutionResult = {
      success: false,
      error: "该操作需要审批但尚未获得批准,已拒绝执行",
      durationMs: Date.now() - start,
    };
    writeAudit(pendingCall, opts, result, startedAt);
    return result;
  }

  const result = await dispatch(pendingCall.skill, pendingCall.tool, pendingCall.args);
  writeAudit(pendingCall, opts, result, startedAt);
  return result;
}

function writeAudit(pendingCall: PendingToolCall, opts: ExecuteOptions, result: ToolExecutionResult, startedAt: string) {
  insertAudit({
    id: uuidv4(),
    sessionId: opts.sessionId,
    callerAgent: opts.callerAgent,
    skill: pendingCall.skill,
    tool: pendingCall.tool,
    args: JSON.stringify(pendingCall.args),
    riskLevel: pendingCall.risk.level,
    approvalId: pendingCall.approvalId ?? null,
    approvedBy: opts.approvedBy ?? null,
    success: result.success ? 1 : 0,
    resultSummary: JSON.stringify(result).slice(0, 2000),
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}
