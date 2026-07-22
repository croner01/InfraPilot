// ============================================================================
// Trace Skill —— 占位实现
//
// 对应设计文档中分布式追踪/链路分析能力,当前版本尚未实现具体工具。
// 保留该文件是为了让 Policy Engine 与 Command Gateway 的导入链路保持完整。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";

export const traceTools: ToolDef[] = [];

export async function executeTraceTool(_tool: string, _args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return { success: false, error: "trace skill 尚未实现", durationMs: 0 };
}
