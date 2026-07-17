// ============================================================================
// Kubernetes Skill — 对应设计文档 §7.2 / §5.3 k8s-mcp-server
//
// 真实集成: 本 Skill 通过 @kubernetes/client-node 调用真实 Kubernetes 集群
// (sandbox 内搭建的单节点 k3s v1.36.2, 详见 server/k8s-manifests/README.md)。
// order-api 演示工作负载已部署为真实 K8s Deployment
// (server/k8s-manifests/order-api-deployment.yaml), 其 OOMKilled/
// CrashLoopBackOff 状态、restartCount、Events 均由真实 kubelet/cgroup 产生,
// 不再依赖本地进程模拟(demo/supervisor.ts 已废弃, 保留仅供参考对照)。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";
import { isAbnormalPod, listEventsForPod, listPods, patchDeploymentMemoryLimit, readPod } from "./client.js";

export const k8sTools: ToolDef[] = [
  {
    name: "list_pods",
    skill: "k8s",
    risk: "readonly",
    description:
      "列出集群中当前状态异常(非Running/存在重启记录)的Pod, 用于在用户未提供具体Pod名时自主发现问题目标(等价于 kubectl get pods --all-namespaces | grep -v Running)",
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
    description:
      "获取Pod详细信息与事件(等价于 kubectl describe pod), 包含 restartCount / lastState(OOMKilled等) / resources.limits / events",
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
    description:
      "调整Deployment的资源limits(如memory), 属于变更操作, 需人工审批。执行后会触发滚动重启(等价于 kubectl patch deployment ... --type=strategic)。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        deployment_name: { type: "string" },
        container_name: { type: "string", description: "容器名, 通常与deployment主容器同名" },
        memory_limit_mi: { type: "number", description: "新的内存limit,单位Mi,例如512" },
      },
      required: ["namespace", "deployment_name", "container_name", "memory_limit_mi"],
      additionalProperties: false,
    },
  },
];

export async function executeK8sTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();

  try {
    switch (tool) {
      case "list_pods": {
        const namespace = args.namespace as string | undefined;
        const pods = await listPods(namespace);
        const abnormal = pods.filter(isAbnormalPod);
        return {
          success: true,
          data: {
            pods: abnormal.map((p) => ({
              name: p.name,
              namespace: p.namespace,
              status: p.status,
              restarts: p.restartCount,
            })),
            note: abnormal.length === 0 ? "当前未发现明显异常Pod(所有Pod状态均为Running且无重启记录)" : undefined,
          },
          durationMs: Date.now() - start,
        };
      }

      case "get_pod_status": {
        const { namespace, pod_name } = args as { namespace: string; pod_name: string };
        const pod = await readPod(namespace, pod_name);
        if (!pod) {
          return { success: false, error: `Pod ${namespace}/${pod_name} 不存在`, durationMs: Date.now() - start };
        }
        return {
          success: true,
          data: { name: pod.name, namespace: pod.namespace, status: pod.status, restarts: pod.restartCount, ready: pod.ready },
          durationMs: Date.now() - start,
        };
      }

      case "describe_pod": {
        const { namespace, pod_name } = args as { namespace: string; pod_name: string };
        const pod = await readPod(namespace, pod_name);
        if (!pod) {
          return { success: false, error: `Pod ${namespace}/${pod_name} 不存在`, durationMs: Date.now() - start };
        }
        const events = await listEventsForPod(namespace, pod_name);
        return {
          success: true,
          data: {
            name: pod.name,
            namespace: pod.namespace,
            status: pod.status,
            restartCount: pod.restartCount,
            lastState: pod.lastState,
            resources: pod.resources,
            nodeName: pod.nodeName,
            podIp: pod.podIp,
            containerName: pod.containerName,
            ownerDeployment: pod.ownerDeployment,
            startedAt: pod.startedAt,
            events: events.slice(-10),
          },
          durationMs: Date.now() - start,
        };
      }

      case "get_events": {
        const { namespace, pod_name } = args as { namespace: string; pod_name: string };
        const events = await listEventsForPod(namespace, pod_name);
        return { success: true, data: { events }, durationMs: Date.now() - start };
      }

      case "patch_resource_limits": {
        const { namespace, deployment_name, container_name, memory_limit_mi } = args as {
          namespace: string;
          deployment_name: string;
          container_name: string;
          memory_limit_mi: number;
        };
        await patchDeploymentMemoryLimit(namespace, deployment_name, container_name, Number(memory_limit_mi));
        return {
          success: true,
          data: {
            message: `已通过 K8s API 将 ${namespace}/${deployment_name} 的 memory limit 调整为 ${memory_limit_mi}Mi, 已触发滚动重启`,
            new_limit_mi: memory_limit_mi,
          },
          durationMs: Date.now() - start,
        };
      }

      default:
        return { success: false, error: `未知的k8s工具: ${tool}`, durationMs: Date.now() - start };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `K8s API 调用失败: ${err?.message ?? String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
