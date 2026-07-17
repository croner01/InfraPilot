// ============================================================================
// Kubernetes Skill — 对应设计文档 §7.2 / §5.3 k8s-mcp-server
//
// 诚实说明: sandbox 环境无可用的真实 K8s 集群, 因此本 Skill 的数据源是
// demo/supervisor.ts 中管理的真实本机子进程(其内存/退出行为完全真实)。
// 工具的 inputSchema 与返回结构严格对齐 kubectl 的真实语义
// (status/restartCount/lastState.reason/exitCode/resources.limits 等字段
// 与 `kubectl get pod -o json` 输出结构一致), 生产环境替换为
// @kubernetes/client-node 真实调用时, Agent 核心 / Prompt / 前端渲染逻辑
// 都不需要修改 —— 这正是 MCP Skill 架构"可插拔"的价值所在。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";
import { orderApiSupervisor } from "../../demo/supervisor.js";

export const k8sTools: ToolDef[] = [
  {
    name: "list_pods",
    skill: "k8s",
    risk: "readonly",
    description: "列出集群中当前状态异常(非Running/高重启次数)的Pod, 用于在用户未提供具体Pod名时自主发现问题目标(等价于 kubectl get pods --all-namespaces | grep -v Running)",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string", description: "可选,留空表示查询所有命名空间" } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_pod_status",
    skill: "k8s",
    risk: "readonly",
    description: "获取Pod当前状态摘要(等价于 kubectl get pod)",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string" }, pod_name: { type: "string" } },
      required: ["namespace", "pod_name"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_pod",
    skill: "k8s",
    risk: "readonly",
    description: "获取Pod详细信息与事件(等价于 kubectl describe pod), 包含 restartCount / lastState(OOMKilled等) / resources.limits / events",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string" }, pod_name: { type: "string" } },
      required: ["namespace", "pod_name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_events",
    skill: "k8s",
    risk: "readonly",
    description: "获取该Pod的近期事件列表(等价于 kubectl get events --field-selector involvedObject.name=xxx)",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string" }, pod_name: { type: "string" } },
      required: ["namespace", "pod_name"],
      additionalProperties: false,
    },
  },
  {
    name: "patch_resource_limits",
    skill: "k8s",
    risk: "high",
    description: "调整Deployment的资源limits(如memory), 属于变更操作, 需人工审批。执行后会触发滚动重启。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        deployment_name: { type: "string" },
        memory_limit_mi: { type: "number", description: "新的内存limit,单位Mi,例如512" },
      },
      required: ["namespace", "deployment_name", "memory_limit_mi"],
      additionalProperties: false,
    },
  },
];

export async function executeK8sTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  const state = orderApiSupervisor.getState();

  switch (tool) {
    case "list_pods": {
      // demo环境只有一个受管Pod, 生产环境会调用 core/v1 pods list API 并按状态过滤
      const abnormal = state.status !== "Running" || state.restartCount > 0;
      return {
        success: true,
        data: {
          pods: abnormal
            ? [{ name: state.podName, namespace: state.namespace, status: state.status, restarts: state.restartCount }]
            : [],
          note: abnormal ? undefined : "当前未发现明显异常Pod(所有Pod状态均为Running且无重启记录)",
        },
        durationMs: Date.now() - start,
      };
    }
    case "get_pod_status": {
      return {
        success: true,
        data: {
          name: state.podName,
          namespace: state.namespace,
          status: state.status,
          restarts: state.restartCount,
          ready: state.status === "Running",
        },
        durationMs: Date.now() - start,
      };
    }
    case "describe_pod": {
      return {
        success: true,
        data: {
          name: state.podName,
          namespace: state.namespace,
          status: state.status,
          restartCount: state.restartCount,
          lastState: state.lastState,
          resources: { limits: { memory: `${state.resources.limitsMemoryMb}Mi` } },
          currentRssMb: state.currentRssMb,
          pid: state.pid,
          startedAt: state.startedAt,
          events: state.events.slice(-10),
        },
        durationMs: Date.now() - start,
      };
    }
    case "get_events": {
      return { success: true, data: { events: state.events }, durationMs: Date.now() - start };
    }
    case "patch_resource_limits": {
      const newLimit = Number(args.memory_limit_mi);
      orderApiSupervisor.patchMemoryLimit(newLimit);
      return {
        success: true,
        data: { message: `已将 ${args.deployment_name} 的 memory limit 调整为 ${newLimit}Mi, 已触发重启`, new_limit_mi: newLimit },
        durationMs: Date.now() - start,
      };
    }
    default:
      return { success: false, error: `未知的k8s工具: ${tool}`, durationMs: Date.now() - start };
  }
}
