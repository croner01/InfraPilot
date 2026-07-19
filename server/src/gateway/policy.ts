// ============================================================================
// Policy Engine — 对应设计文档 §8.2 / §6.3 policies.yaml
// 风险分级与审批规则判定。这是"能不能自动执行"的唯一裁决点 —— 任何 Agent
// 代码都不能绕过此模块直接执行工具。
// ============================================================================

import { RiskDecision, SkillName, ToolDef } from "../types.js";
import { linuxTools } from "../skills/linux/tools.js";
import { k8sTools } from "../skills/k8s/tools.js";
import { elkTools } from "../skills/elk/tools.js";
import { clickhouseTools } from "../skills/clickhouse/tools.js";

export const ALL_TOOLS: ToolDef[] = [...linuxTools, ...k8sTools, ...elkTools, ...clickhouseTools];

export function findTool(skill: SkillName, tool: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.skill === skill && t.name === tool);
}

/**
 * 全局命令黑名单 —— 对应设计文档 §8.4, 任何 Skill 都不能绕过。
 * 本项目中所有工具均为具名结构化工具(无自由拼接shell字符串的raw_command通道),
 * 此处的黑名单主要作为"纵深防御"的最后一道保险,防止未来新增Skill时误引入危险实现。
 */
const GLOBAL_DENY_PATTERNS = [/rm\s+-rf\s+\//, /mkfs\./, /dd\s+if=.*of=\/dev\//, /:\(\)\{.*:\|:&.*\};:/];

export function violatesGlobalDeny(argsString: string): boolean {
  return GLOBAL_DENY_PATTERNS.some((p) => p.test(argsString));
}

export function classifyRisk(skill: SkillName, tool: string, args: Record<string, unknown>): RiskDecision {
  const def = findTool(skill, tool);
  if (!def) {
    return { level: "critical", reason: "未注册的工具,拒绝执行", requiresApproval: true, requiresTwoPerson: true };
  }

  const argsStr = JSON.stringify(args);
  if (violatesGlobalDeny(argsStr)) {
    return { level: "critical", reason: "命中全局危险命令黑名单", requiresApproval: true, requiresTwoPerson: true };
  }

  switch (def.risk) {
    case "readonly":
      return { level: "readonly", reason: "只读诊断操作,无副作用", requiresApproval: false, requiresTwoPerson: false };
    case "low":
      return { level: "low", reason: "低风险辅助操作", requiresApproval: false, requiresTwoPerson: false };
    case "medium":
      return { level: "medium", reason: "有状态变更但影响范围可控", requiresApproval: true, requiresTwoPerson: false };
    case "high":
      return {
        level: "high",
        reason: "变更操作,影响范围较大或不易回滚",
        requiresApproval: true,
        requiresTwoPerson: false,
        blastRadius: describeBlastRadius(skill, tool, args),
      };
    case "critical":
      return { level: "critical", reason: "高危/不可逆操作,需双人审批", requiresApproval: true, requiresTwoPerson: true };
  }
}

function describeBlastRadius(skill: SkillName, tool: string, args: Record<string, unknown>): string {
  if (skill === "k8s" && tool === "patch_resource_limits") {
    return `该Deployment(${args.deployment_name}) 位于命名空间 ${args.namespace}, 属于订单核心链路, 变更会触发滚动重启(真实K8s集群操作)`;
  }
  return "未知影响范围,建议人工评估";
}

/** 生成人类可读的 diff 预览 —— 对应设计文档 §11.3 审批卡片 */
export function renderDiffPreview(skill: SkillName, tool: string, args: Record<string, unknown>): string {
  if (skill === "k8s" && tool === "patch_resource_limits") {
    return [
      `kubectl patch deployment ${args.deployment_name} -n ${args.namespace} --type=strategic`,
      `  spec.template.spec.containers[${args.container_name}].resources.limits.memory:`,
      `-   (当前值, 请以 describe_pod 结果为准)`,
      `+   ${args.memory_limit_mi}Mi`,
    ].join("\n");
  }
  return `${skill}.${tool}(${JSON.stringify(args)})`;
}
