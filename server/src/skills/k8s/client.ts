// ============================================================================
// 真实 Kubernetes 客户端封装 —— 基于 @kubernetes/client-node
//
// 本模块是 K8s Skill 与真实集群之间的唯一桥接层。所有 Skill 工具函数
// (tools.ts)都通过这里获取真实的 Pod/Deployment/Event 数据 —— 不再依赖
// demo/supervisor.ts 的进程模拟。当前对接的是 sandbox 内真实搭建的单节点
// k3s 集群(v1.36.2), 详见 server/k8s-manifests/README.md。
//
// kubeconfig 加载策略: 默认从 ~/.kube/config 加载(通过环境变量 KUBECONFIG
// 可覆盖)。生产环境部署到集群内运行时, KubeConfig.loadFromCluster() 会自动
// 使用 ServiceAccount 挂载的凭据, 无需修改本文件代码。
// ============================================================================

import * as k8s from "@kubernetes/client-node";

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    // 集群内运行时(Pod 内有 ServiceAccount token 挂载)使用 in-cluster 配置
    kc.loadFromCluster();
    return kc;
  }
  kc.loadFromDefault();
  return kc;
}

export const kubeConfig = loadKubeConfig();
export const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
export const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);

export interface NormalizedPod {
  name: string;
  namespace: string;
  status: string; // Running / Pending / CrashLoopBackOff / OOMKilled / Completed / Error ...
  restartCount: number;
  ready: boolean;
  podIp?: string;
  nodeName?: string;
  startedAt?: string;
  lastState?: { reason: string; exitCode: number; finishedAt: string; startedAt?: string };
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  containerName?: string;
  uid?: string;
  ownerDeployment?: string; // 从 ReplicaSet 名反推出 Deployment 名, 供 patch 工具使用
}

/** 从 pod 的 ownerReferences 反推所属 Deployment 名(k8s命名约定: deploy-<hash>-<hash>) */
function inferOwnerDeployment(pod: k8s.V1Pod): string | undefined {
  const rsName = pod.metadata?.ownerReferences?.find((o) => o.kind === "ReplicaSet")?.name;
  if (!rsName) return undefined;
  const parts = rsName.split("-");
  if (parts.length <= 1) return rsName;
  return parts.slice(0, -1).join("-");
}

/**
 * 把 K8s API 返回的原始 V1Pod 规整为对 Agent/前端更友好的结构,
 * 并推导出贴近 `kubectl get pods` 直觉的 status 文本(包括 CrashLoopBackOff/OOMKilled)。
 */
export function normalizePod(pod: k8s.V1Pod): NormalizedPod {
  const meta = pod.metadata!;
  const status = pod.status!;
  const containerStatus = status.containerStatuses?.[0];
  const container = pod.spec?.containers?.[0];

  let derivedStatus = status.phase ?? "Unknown";
  if (containerStatus) {
    const waiting = containerStatus.state?.waiting;
    const terminated = containerStatus.state?.terminated;
    if (waiting?.reason) {
      derivedStatus = waiting.reason; // e.g. CrashLoopBackOff / ContainerCreating
    } else if (terminated?.reason) {
      derivedStatus = terminated.reason; // e.g. OOMKilled / Completed / Error
    } else if (containerStatus.ready) {
      derivedStatus = "Running";
    }
  }

  const lastTerm = containerStatus?.lastState?.terminated;

  return {
    name: meta.name!,
    namespace: meta.namespace!,
    status: derivedStatus,
    restartCount: containerStatus?.restartCount ?? 0,
    ready: containerStatus?.ready ?? false,
    podIp: status.podIP,
    nodeName: pod.spec?.nodeName,
    startedAt: (containerStatus?.state?.running?.startedAt as unknown as string) ?? undefined,
    lastState: lastTerm
      ? {
          reason: lastTerm.reason ?? "Unknown",
          exitCode: lastTerm.exitCode ?? -1,
          finishedAt: (lastTerm.finishedAt as unknown as string) ?? "",
          startedAt: (lastTerm.startedAt as unknown as string) ?? undefined,
        }
      : undefined,
    resources: container?.resources
      ? {
          limits: container.resources.limits as unknown as Record<string, string>,
          requests: container.resources.requests as unknown as Record<string, string>,
        }
      : undefined,
    containerName: container?.name,
    uid: meta.uid,
    ownerDeployment: inferOwnerDeployment(pod),
  };
}

/** 判断 Pod 是否"异常"(status != Running, 或存在重启记录) — 用于自主发现类工具 */
export function isAbnormalPod(p: NormalizedPod): boolean {
  return p.status !== "Running" || p.restartCount > 0;
}

/** 列出全部命名空间(或指定命名空间)下的 Pod, 已规整为 NormalizedPod[] */
export async function listPods(namespace?: string): Promise<NormalizedPod[]> {
  if (namespace) {
    const res = await coreApi.listNamespacedPod({ namespace });
    return res.items.map(normalizePod);
  }
  const res = await coreApi.listPodForAllNamespaces();
  return res.items.map(normalizePod);
}

export async function readPod(namespace: string, name: string): Promise<NormalizedPod | undefined> {
  try {
    const pod = await coreApi.readNamespacedPod({ name, namespace });
    return normalizePod(pod);
  } catch (err: any) {
    if (err?.code === 404) return undefined;
    throw err;
  }
}

export interface NormalizedEvent {
  time: string;
  type: string;
  reason: string;
  message: string;
  involvedObject: string;
}

export async function listEventsForPod(namespace: string, podName: string): Promise<NormalizedEvent[]> {
  const res = await coreApi.listNamespacedEvent({
    namespace,
    fieldSelector: `involvedObject.name=${podName}`,
  });
  return res.items
    .map((e) => ({
      time: (e.lastTimestamp as unknown as string) ?? (e.eventTime as unknown as string) ?? "",
      type: e.type ?? "Normal",
      reason: e.reason ?? "",
      message: e.message ?? "",
      involvedObject: e.involvedObject?.name ?? podName,
    }))
    .sort((a, b) => (a.time > b.time ? 1 : -1));
}

/** 调整 Deployment 的内存 limit(通过 strategic merge patch), 返回是否成功 */
export async function patchDeploymentMemoryLimit(
  namespace: string,
  deploymentName: string,
  containerName: string,
  memoryLimitMi: number,
): Promise<void> {
  const patchBody = {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: containerName,
              resources: { limits: { memory: `${memoryLimitMi}Mi` } },
            },
          ],
        },
      },
    },
  };
  await appsApi.patchNamespacedDeployment(
    {
      name: deploymentName,
      namespace,
      body: patchBody,
    },
    k8s.setHeaderOptions("Content-Type", "application/strategic-merge-patch+json"),
  );
}

/** 删除Pod以触发重建(用于"重置演示场景"等运维动作, 底层ReplicaSet会自动补齐新Pod) */
export async function deletePod(namespace: string, name: string): Promise<void> {
  try {
    await coreApi.deleteNamespacedPod({ name, namespace });
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
}
