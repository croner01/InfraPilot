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
import {
  deletePod,
  execPodCommand,
  getDeployment,
  isAbnormalPod,
  listEventsForPod,
  listPods,
  patchDeploymentMemoryLimit,
  readPod,
  topPods,
  topNodes,
  getNode,
} from "./client.js";
import type { NormalizedPod } from "./client.js";
import { capSamples, countBy } from "../summary.js";

export const k8sTools: ToolDef[] = [
  {
    name: "list_pods",
    skill: "k8s",
    risk: "readonly",
    description:
      "列出 Pod 并返回汇总式结果: summary 计数在最前(total/running/abnormal + 按状态聚合 byReason, 可区分 Evicted/Error/OOMKilled/CrashLoopBackOff + byNode 按节点聚合 running/abnormal/restarts), running 显式列出健康副本, pods 为最多15条按时间倒序的异常样本。用于确认服务是否可用、定位异常目标; 判断异常是否集中在个别节点时优先看 summary.byNode。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "可选,留空表示查询所有命名空间" },
        all: { type: "boolean", description: "兼容参数(历史调用保留); 无论取值, 本工具始终返回汇总 + running 列表 + 异常样本" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "top_pods",
    skill: "k8s",
    risk: "readonly",
    description:
      "读取 Pod 实时 CPU/内存用量(等价 kubectl top pod), 并对比容器 resources.limits 计算百分比; 用于判断 OOM/资源耗尽类问题",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string", description: "可选,留空表示所有命名空间" } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_deployment",
    skill: "k8s",
    risk: "readonly",
    description:
      "读取 Deployment 完整定义(等价 kubectl get deployment -o yaml, 已脱敏: env 只返回名称与来源不含密钥值), 包含 replicas/strategy/resources/volumes(emptyDir|PVC)/env 名称",
    parameters: {
      type: "object",
      properties: { namespace: { type: "string" }, deployment_name: { type: "string" } },
      required: ["namespace", "deployment_name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pod_memory",
    skill: "k8s",
    risk: "readonly",
    description:
      "进入目标 Pod 读取 cgroup 内存构成(memory.current/max 与 anon/file/slab), 用于区分 JVM 堆、页缓存与 slab 谁占用了内存限额",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        pod_name: { type: "string" },
        container: { type: "string", description: "可选,单容器Pod可省略" },
      },
      required: ["namespace", "pod_name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pod_processes",
    skill: "k8s",
    risk: "readonly",
    description:
      "进入目标 Pod 查看进程列表(等价 kubectl exec -- ps -ef), 用于读取 JVM 启动参数(-Xmx等)与运行时长",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        pod_name: { type: "string" },
        container: { type: "string", description: "可选,单容器Pod可省略" },
      },
      required: ["namespace", "pod_name"],
      additionalProperties: false,
    },
  },
  {
    name: "top_nodes",
    skill: "k8s",
    risk: "readonly",
    description:
      "读取所有节点 CPU/内存用量（等价 kubectl top node），用于判断节点级资源压力与 Pod 被驱逐(Evicted)的来源",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_node",
    skill: "k8s",
    risk: "readonly",
    description:
      "读取节点详情：capacity/allocatable(内存/CPU)、conditions(含 MemoryPressure/DiskPressure)、taints；用于判断驱逐阈值与调度约束",
    parameters: {
      type: "object",
      properties: { node_name: { type: "string" } },
      required: ["node_name"],
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
  {
    name: "delete_pod",
    skill: "k8s",
    risk: "high",
    description:
      "删除指定 Pod(等价于 kubectl delete pod)。用于让卡死/长期 CrashLoopBackOff/不可调度的副本被控制器立即重建(Deployment/ReplicaSet/StatefulSet 管理的 Pod 会重建, 裸 Pod 删除后不会回来)。会短暂减少可用副本, 属变更操作需人工审批; 调用前必须先说明为什么重建能解决问题(例如副本被钉在某个异常节点/宿主环境), 而不是把重建当成试错手段。",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        pod_name: { type: "string" },
      },
      required: ["namespace", "pod_name"],
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
        const now = Date.now();
        const decorate = (p: NormalizedPod) => ({
          name: p.name,
          namespace: p.namespace,
          status: p.status,
          reason: p.reason,
          restarts: p.restartCount,
          ready: p.ready,
          startedAt: p.startedAt,
          ageSeconds: p.startedAt ? Math.max(0, Math.round((now - new Date(p.startedAt).getTime()) / 1000)) : undefined,
          nodeName: p.nodeName,
          podIp: p.podIp,
          ownerDeployment: p.ownerDeployment,
        });
        const running = pods
          .filter((p) => p.status === "Running" && p.ready)
          .slice(0, 10)
          .map(decorate);
        const abnormal = pods.filter(isAbnormalPod);
        const byReason = countBy(abnormal.map((p) => p.status ?? p.reason ?? "Unknown"));
        const byNode: Record<string, { total: number; running: number; abnormal: number; restarts: number }> = {};
        for (const p of pods) {
          const node = p.nodeName ?? "未调度";
          const entry = (byNode[node] ??= { total: 0, running: 0, abnormal: 0, restarts: 0 });
          entry.total += 1;
          if (p.status === "Running" && p.ready) entry.running += 1;
          if (isAbnormalPod(p)) entry.abnormal += 1;
          entry.restarts += p.restartCount ?? 0;
        }
        const capped = capSamples(
          [...abnormal]
          .sort((a, b) => {
            const at = a.startedAt ? new Date(a.startedAt).getTime() : 0;
            const bt = b.startedAt ? new Date(b.startedAt).getTime() : 0;
            return bt - at;
          })
          .map(decorate),
          15,
        );
        return {
          success: true,
          data: {
            summary: {
              total: pods.length,
              running: running.length,
              abnormal: abnormal.length,
              byReason,
              byNode,
            },
            running,
            pods: capped.samples,
            truncated: capped.truncated,
          },
          durationMs: Date.now() - start,
        };
      }

      case "top_pods": {
        const namespace = args.namespace as string | undefined;
        const rows = await topPods(namespace);
        return {
          success: true,
          data: { pods: rows },
          durationMs: Date.now() - start,
        };
      }

      case "top_nodes": {
        const rows = await topNodes();
        return {
          success: true,
          data: { nodes: rows },
          durationMs: Date.now() - start,
        };
      }

      case "get_node": {
        const { node_name } = args as { node_name: string };
        const node = await getNode(node_name);
        return {
          success: true,
          data: { node },
          durationMs: Date.now() - start,
        };
      }

      case "get_deployment": {
        const { namespace, deployment_name } = args as { namespace: string; deployment_name: string };
        const deployment = await getDeployment(namespace, deployment_name);
        return {
          success: true,
          data: { deployment },
          durationMs: Date.now() - start,
        };
      }

      case "get_pod_memory": {
        const { namespace, pod_name, container } = args as { namespace: string; pod_name: string; container?: string };
        const raw = await execPodCommand(
          namespace,
          pod_name,
          "cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.max; grep -E '^(anon|file|slab|kernel)' /sys/fs/cgroup/memory.stat",
          container,
        );
        const numbers = (raw.match(/\d+/g) ?? []).map(Number);
        return {
          success: true,
          data: {
            currentBytes: numbers[0],
            maxBytes: numbers[1],
            anonBytes: numbers[2],
            fileBytes: numbers[3],
            slabBytes: numbers[4],
            currentMi: numbers[0] ? Math.round(numbers[0] / 1024 / 1024) : undefined,
            maxMi: numbers[1] ? Math.round(numbers[1] / 1024 / 1024) : undefined,
            raw,
          },
          durationMs: Date.now() - start,
        };
      }

      case "get_pod_processes": {
        const { namespace, pod_name, container } = args as { namespace: string; pod_name: string; container?: string };
        const raw = await execPodCommand(namespace, pod_name, "ps -ef --no-headers | head -30", container);
        return {
          success: true,
          data: { processes: raw.split("\n").filter((line) => line.trim().length > 0) },
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

      case "delete_pod": {
        const { namespace, pod_name } = args as { namespace: string; pod_name: string };
        await deletePod(namespace, pod_name);
        return {
          success: true,
          data: {
            deleted: `${namespace}/${pod_name}`,
            note: "Pod 已删除; 若由 Deployment/ReplicaSet 管理, 控制器会立即重建(可能落在其它节点)。",
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
