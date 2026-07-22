// ============================================================================
// Topology Skill —— 占位实现
//
// 对应设计文档中拓扑/依赖分析能力,当前版本尚未实现具体工具。
// 保留该文件是为了让 Policy Engine 与 Command Gateway 的导入链路保持完整。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";

export const topologyTools: ToolDef[] = [];

export async function executeTopologyTool(_tool: string, _args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return { success: false, error: "topology skill 尚未实现", durationMs: 0 };
}
