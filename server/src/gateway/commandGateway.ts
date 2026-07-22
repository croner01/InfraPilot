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
import { executeTraceTool } from "../skills/trace/tools.js";
import { executeKnowledgeTool } from "../skills/knowledge/tools.js";
import { executeTopologyTool } from "../skills/topology/tools.js";
import { executeOpenStackTool } from "../skills/openstack/tools.js";
import { insertAudit, getApproval } from "../db/db.js";
import { computeArgsHash } from "./argsHash.js";

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
    case "trace":
      return executeTraceTool(tool, args);
    case "knowledge":
      return executeKnowledgeTool(tool, args);
    case "topology":
      return executeTopologyTool(tool, args);
    case "openstack":
      return executeOpenStackTool(tool, args);
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

  // 对需审批的调用进行 approval 记录与 argsHash 一致性校验，防止 TOCTOU 篡改
  if (pendingCall.risk.requiresApproval && pendingCall.approvalId) {
    const approval = getApproval(pendingCall.approvalId);
    if (!approval) {
      const result: ToolExecutionResult = {
        success: false,
        error: "审批记录不存在，已拒绝执行",
        durationMs: Date.now() - start,
      };
      writeAudit(pendingCall, opts, result, startedAt);
      return result;
    }
    if (approval.decision !== "approved") {
      const result: ToolExecutionResult = {
        success: false,
        error: `审批记录状态为 ${approval.decision}，已拒绝执行`,
        durationMs: Date.now() - start,
      };
      writeAudit(pendingCall, opts, result, startedAt);
      return result;
    }
    const currentHash = computeArgsHash(pendingCall.skill, pendingCall.tool, pendingCall.args);
    if (approval.args_hash !== currentHash) {
      const result: ToolExecutionResult = {
        success: false,
        error: "审批令牌与当前命令参数不匹配，可能存在篡改，已拒绝执行",
        durationMs: Date.now() - start,
      };
      writeAudit(pendingCall, opts, result, startedAt);
      return result;
    }
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
