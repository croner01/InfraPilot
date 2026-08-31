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
  execPodCommand,
  getDeployment,
  isAbnormalPod,
  listEventsForPod,
  listPods,
  patchDeploymentMemoryLimit,
  readPod,
  topPods,
} from "./client.js";

export const k8sTools: ToolDef[] = [
  {
    name: "list_pods",
    skill: "k8s",
    risk: "readonly",
    description:
      "列出集群中当前状态异常(非Running/存在重启记录)的Pod, 用于在用户未提供具体Pod名时自主发现问题目标(等价于 kubectl get pods --all-namespaces | grep -v Running)",
    parameters: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "可选,留空表示查询所有命名空间" },
        all: { type: "boolean", description: "可选,true 时返回全部Pod(含健康), 并附带 startedAt/运行时长, 用于确认服务是否真的不可用" },
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
        const all = args.all === true;
        const pods = await listPods(namespace);
        if (all) {
          const now = Date.now();
          return {
            success: true,
            data: {
              pods: pods.map((p) => ({
                name: p.name,
                namespace: p.namespace,
                status: p.status,
                restarts: p.restartCount,
                ready: p.ready,
                nodeName: p.nodeName,
                startedAt: p.startedAt,
                ageSeconds: p.startedAt ? Math.max(0, Math.round((now - new Date(p.startedAt).getTime()) / 1000)) : undefined,
                podIp: p.podIp,
                ownerDeployment: p.ownerDeployment,
              })),
            },
            durationMs: Date.now() - start,
          };
        }
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

      case "top_pods": {
        const namespace = args.namespace as string | undefined;
        const rows = await topPods(namespace);
        return {
          success: true,
          data: { pods: rows },
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
