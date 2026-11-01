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
import { traceTools } from "../skills/trace/tools.js";
import { knowledgeTools } from "../skills/knowledge/tools.js";
import { topologyTools } from "../skills/topology/tools.js";
import { openstackTools } from "../skills/openstack/tools.js";
import { drawioTools } from "../skills/drawio/tools.js";
import { skillsTools } from "../skills/packages/tools.js";
import { prometheusTools } from "../skills/prometheus/tools.js";

export const ALL_TOOLS: ToolDef[] = [
  ...linuxTools,
  ...k8sTools,
  ...elkTools,
  ...clickhouseTools,
  ...prometheusTools,
  ...traceTools,
  ...knowledgeTools,
  ...topologyTools,
  ...openstackTools,
  ...drawioTools,
  ...skillsTools,
];

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

  // 非本地主机 = SSH 登录远端节点,即使是只读命令也必须先人工审批
  const remote = remoteTargets(args);

  switch (def.risk) {
    case "readonly":
      if (remote.length > 0) {
        return {
          level: "medium",
          reason: `远程主机只读诊断(${remote.join(", ")}): 需 SSH 登录远端,先人工审批`,
          requiresApproval: true,
          requiresTwoPerson: false,
          blastRadius: describeBlastRadius(skill, tool, args),
        };
      }
      return { level: "readonly", reason: "只读诊断操作,无副作用", requiresApproval: false, requiresTwoPerson: false };
    case "low":
      if (remote.length > 0) {
        return {
          level: "medium",
          reason: `远程主机操作(${remote.join(", ")}): 需 SSH 登录远端,先人工审批`,
          requiresApproval: true,
          requiresTwoPerson: false,
          blastRadius: describeBlastRadius(skill, tool, args),
        };
      }
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

function remoteTargets(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const host = args.host;
  if (typeof host === "string" && host && host !== "local") out.push(host);
  if (Array.isArray(args.hosts)) {
    for (const h of args.hosts) {
      const name = String(h);
      if (name && name !== "local") out.push(name);
    }
  }
  return out;
}

function describeBlastRadius(skill: SkillName, tool: string, args: Record<string, unknown>): string {
  const remote = remoteTargets(args);
  if (remote.length > 0) {
    return `目标主机: ${remote.join(", ")} (SSH 登录远端节点执行); 远程通道只放行只读诊断命令白名单, 输出经脱敏处理`;
  }
  if (skill === "k8s" && tool === "patch_resource_limits") {
    return `该Deployment(${args.deployment_name}) 位于命名空间 ${args.namespace}, 属于订单核心链路, 变更会触发滚动重启(真实K8s集群操作)`;
  }
  if (skill === "k8s" && tool === "delete_pod") {
    return `删除 Pod ${args.namespace}/${args.pod_name} (真实K8s集群操作); 由控制器管理的 Pod 会被立即重建, 期间可用副本短暂减少; 裸 Pod 删除后不会恢复`;
  }
  return "未知影响范围,建议人工评估";
}

/** 生成人类可读的 diff 预览 —— 对应设计文档 §11.3 审批卡片 */
export function renderDiffPreview(skill: SkillName, tool: string, args: Record<string, unknown>): string {
  const remote = remoteTargets(args);
  if (remote.length > 0) {
    const command = String(args.command ?? "");
    const commandArgs = Array.isArray(args.args) ? args.args.map((a) => String(a)) : [];
    const paths = Array.isArray(args.paths) ? args.paths.map((p) => String(p)) : [];
    const line =
      command || commandArgs.length > 0
        ? [command || "<command>", ...commandArgs].map((c) => (/[^A-Za-z0-9_./:-]/.test(c) ? `'${c}'` : c)).join(" ")
        : `stat -c '%n %s %Y' ${paths.join(" ")}`;
    return `# 目标主机: ${remote.join(", ")} (SSH 只读通道)\nssh ${remote.join(", ")} -- ${line}`;
  }
  if (skill === "k8s" && tool === "patch_resource_limits") {
    return [
      `kubectl patch deployment ${args.deployment_name} -n ${args.namespace} --type=strategic`,
      `  spec.template.spec.containers[${args.container_name}].resources.limits.memory:`,
      `-   (当前值, 请以 describe_pod 结果为准)`,
      `+   ${args.memory_limit_mi}Mi`,
    ].join("\n");
  }
  if (skill === "k8s" && tool === "delete_pod") {
    return [
      `kubectl delete pod ${args.pod_name} -n ${args.namespace}`,
      `# 影响: 该 Pod 立即终止(优雅期默认30s); 若由 Deployment/ReplicaSet 管理会重建一个新副本`,
    ].join("\n");
  }
  return `${skill}.${tool}(${JSON.stringify(args)})`;
}
