"""Policy Engine —— 对应 `server/src/gateway/policy.ts`。

风险分级与审批规则的唯一裁决点；任何 Agent 代码都不能绕过此模块直接执行工具。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from . import k8s_clusters, skills
from .models import RiskDecision, ToolDef

ALL_TOOLS: list[ToolDef] = skills.all_tools()

GLOBAL_DENY_PATTERNS = [
    re.compile(r"rm\s+-rf\s+/"),
    re.compile(r"mkfs\."),
    re.compile(r"dd\s+if=.*of=/dev/"),
    re.compile(r":\(\)\{.*:\|:&.*\};:"),
]


def find_tool(skill: str, tool: str) -> Optional[ToolDef]:
    return next((t for t in ALL_TOOLS if t.skill == skill and t.name == tool), None)


def violates_global_deny(args_string: str) -> bool:
    return any(p.search(args_string) for p in GLOBAL_DENY_PATTERNS)


def classify_risk(skill: str, tool: str, args: dict[str, Any]) -> RiskDecision:
    definition = find_tool(skill, tool)
    if definition is None:
        return RiskDecision(
            level="critical", reason="未注册的工具,拒绝执行", requiresApproval=True, requiresTwoPerson=True
        )

    if violates_global_deny(json.dumps(args, ensure_ascii=False)):
        return RiskDecision(
            level="critical", reason="命中全局危险命令黑名单", requiresApproval=True, requiresTwoPerson=True
        )

    # 非本地主机 = SSH 登录远端节点,即使是只读命令也必须先人工审批(默认禁止远端直连)。
    remote = _remote_targets(args)

    if definition.risk == "readonly":
        if remote:
            return RiskDecision(
                level="medium",
                reason=f"远程主机只读诊断({', '.join(remote)}): 需 SSH 登录远端,先人工审批",
                requiresApproval=True,
                requiresTwoPerson=False,
                blastRadius=_describe_blast_radius(skill, tool, args),
            )
        return RiskDecision(level="readonly", reason="只读诊断操作,无副作用", requiresApproval=False, requiresTwoPerson=False)
    if definition.risk == "low":
        if remote:
            return RiskDecision(
                level="medium",
                reason=f"远程主机操作({', '.join(remote)}): 需 SSH 登录远端,先人工审批",
                requiresApproval=True,
                requiresTwoPerson=False,
                blastRadius=_describe_blast_radius(skill, tool, args),
            )
        return RiskDecision(level="low", reason="低风险辅助操作", requiresApproval=False, requiresTwoPerson=False)
    if definition.risk == "medium":
        return RiskDecision(
            level="medium",
            reason="有状态变更但影响范围可控",
            requiresApproval=True,
            requiresTwoPerson=False,
            blastRadius=_describe_blast_radius(skill, tool, args) if remote else None,
        )
    if definition.risk == "high":
        return RiskDecision(
            level="high",
            reason="变更操作,影响范围较大或不易回滚",
            requiresApproval=True,
            requiresTwoPerson=False,
            blastRadius=_describe_blast_radius(skill, tool, args),
        )
    return RiskDecision(
        level="critical", reason="高危/不可逆操作,需双人审批", requiresApproval=True, requiresTwoPerson=True
    )


def _remote_targets(args: dict[str, Any]) -> list[str]:
    """调用是否指向非本地主机(SSH 远端)。支持 host 字符串与 hosts 数组两种形态。"""
    out: list[str] = []
    host = args.get("host")
    if isinstance(host, str) and host and host != "local":
        out.append(host)
    hosts = args.get("hosts")
    if isinstance(hosts, list):
        out.extend(str(h) for h in hosts if h and str(h) != "local")
    return out


def _target_cluster(args: dict[str, Any]) -> str:
    """变更类操作的目标集群：远端集群名 + apiserver 地址，未接入远端时为本地集群。"""
    return k8s_clusters.describe_ref(args.get("cluster"))


def _describe_blast_radius(skill: str, tool: str, args: dict[str, Any]) -> str:
    remote = _remote_targets(args)
    if remote:
        return (
            f"目标主机: {', '.join(remote)} (SSH 登录远端节点执行)。"
            "远程通道只放行只读诊断命令白名单, 不会变更远端状态; 输出会经脱敏处理"
        )
    if skill == "k8s" and tool == "patch_resource_limits":
        return (
            f"目标集群: {_target_cluster(args)}; "
            f"该Deployment({args.get('deployment_name')}) 位于命名空间 {args.get('namespace')}, "
            "变更会触发滚动重启(真实K8s集群操作)"
        )
    if skill == "k8s" and tool == "delete_pod":
        return (
            f"目标集群: {_target_cluster(args)}; "
            f"删除 Pod {args.get('namespace')}/{args.get('pod_name')} (真实K8s集群操作); "
            "由控制器管理的 Pod 会被立即重建,期间可用副本短暂减少;裸 Pod 删除后不会恢复"
        )
    return "未知影响范围,建议人工评估"


def render_diff_preview(skill: str, tool: str, args: dict[str, Any]) -> str:
    if skill == "k8s" and tool == "patch_resource_limits":
        return "\n".join(
            [
                f"# 目标集群: {_target_cluster(args)}",
                f"kubectl patch deployment {args.get('deployment_name')} -n {args.get('namespace')} --type=strategic",
                f"  spec.template.spec.containers[{args.get('container_name')}].resources.limits.memory:",
                "  -   (当前值, 请以 describe_pod 结果为准)",
                f"  +   {args.get('memory_limit_mi')}Mi",
            ]
        )
    remote = _remote_targets(args)
    if remote:
        from . import remote as remote_skill

        host = remote[0]
        if args.get("host") is None and isinstance(args.get("hosts"), list):
            host = ", ".join(remote)
        cmd = str(args.get("command") or "")
        cmd_args = [str(a) for a in (args.get("args") or [])] if isinstance(args.get("args"), list) else []
        if not cmd and isinstance(args.get("paths"), list):
            cmd, cmd_args = "stat", ["-c", "%n %s %Y", *[str(p) for p in args["paths"]]]
        return (
            f"# 目标主机: {host} (SSH 只读通道)\n"
            f"ssh {host} -- {remote_skill.build_command_line(cmd or '<command>', cmd_args)}"
        )
    if skill == "k8s" and tool == "delete_pod":
        return "\n".join(
            [
                f"# 目标集群: {_target_cluster(args)}",
                f"kubectl delete pod {args.get('pod_name')} -n {args.get('namespace')}",
                "# 影响: 该 Pod 立即终止(优雅期默认30s);若由 Deployment/ReplicaSet 管理会重建一个新副本",
            ]
        )
    return f"{skill}.{tool}({json.dumps(args, ensure_ascii=False)})"
