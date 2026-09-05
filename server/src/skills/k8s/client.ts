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
import fs from "node:fs";
import { PassThrough } from "node:stream";

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    // 集群内运行时(Pod 内有 ServiceAccount token 挂载)使用 in-cluster 配置
    kc.loadFromCluster();
    return kc;
  }

  // 1. 优先使用 KUBECONFIG 环境变量指定的文件（生产/显式配置）
  if (process.env.KUBECONFIG) {
    kc.loadFromFile(process.env.KUBECONFIG);
    console.log(`[k8s client] loaded kubeconfig from KUBECONFIG: ${process.env.KUBECONFIG}`);
    return kc;
  }

  // 2. sandbox 常见 k3s 系统级 kubeconfig（避免 ~/.kube/config 里放着旧证书导致 401）
  const k3sConfig = "/etc/rancher/k3s/k3s.yaml";
  if (fs.existsSync(k3sConfig)) {
    kc.loadFromFile(k3sConfig);
    console.log(`[k8s client] loaded kubeconfig from k3s default: ${k3sConfig}`);
    return kc;
  }

  // 3. 标准默认路径 ~/.kube/config
  const home = process.env.HOME || process.env.USERPROFILE;
  const defaultConfig = home ? `${home}/.kube/config` : undefined;
  if (defaultConfig && fs.existsSync(defaultConfig)) {
    kc.loadFromFile(defaultConfig);
    console.log(`[k8s client] loaded kubeconfig from default: ${defaultConfig}`);
    return kc;
  }

  throw new Error("找不到可用的 kubeconfig; 请设置 KUBECONFIG 环境变量");
}

export const kubeConfig = loadKubeConfig();
export const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
export const appsApi = kubeConfig.makeApiClient(k8s.AppsV1Api);
export const customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

// -------------------- 指标与部署信息 --------------------

/** "38m" -> 0.038, "2" -> 2, "500m" -> 0.5 */
export function parseCpu(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const m = input.match(/^([\d.]+)(m)?$/);
  if (!m) return undefined;
  const value = Number(m[1]);
  return m[2] === "m" ? value / 1000 : value;
}

/** "4095Mi" -> 4293918720, "4Gi" -> 4294967296, "512Mi", "1048576" */
export function parseMemory(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const m = input.match(/^([\d.]+)(Ki|Mi|Gi|Ti)?$/i);
  if (!m) return undefined;
  const value = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "ki") return Math.round(value * 1024);
  if (unit === "mi") return Math.round(value * 1024 * 1024);
  if (unit === "gi") return Math.round(value * 1024 * 1024 * 1024);
  if (unit === "ti") return Math.round(value * 1024 ** 4);
  return value;
}

export interface PodMetricRow {
  name: string;
  namespace: string;
  cpuCores: number;
  memoryBytes: number;
  cpuLimit?: number;
  memoryLimit?: number;
  memoryPercent?: number;
}

export interface NodeMetricRow {
  name: string;
  cpuCores: number;
  memoryBytes: number;
}

/** 节点实时用量（metrics.k8s.io/v1beta1 nodes），等价 kubectl top node */
export async function topNodes(): Promise<NodeMetricRow[]> {
  const res = await customObjectsApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" });
  const items = ((res.body as { items?: unknown[] })?.items ?? []) as Array<{
    metadata?: { name?: string };
    usage?: Record<string, string>;
  }>;
  return items
    .map((item) => ({
      name: item.metadata?.name ?? "",
      cpuCores: parseCpu(item.usage?.cpu) ?? 0,
      memoryBytes: parseMemory(item.usage?.memory) ?? 0,
    }))
    .filter((row) => row.name !== "");
}

/** 节点 allocatable/capacity/conditions/taints（脱敏，无 secrets） */
export async function getNode(name: string) {
  const node = await coreApi.readNode({ name });
  return {
    name: node.metadata?.name,
    capacity: node.status?.capacity,
    allocatable: node.status?.allocatable,
    conditions: (node.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    })),
    taints: (node.spec?.taints ?? []).map((t) => ({ key: t.key, effect: t.effect })),
  };
}

/** 读取 metrics.k8s.io Pod 用量（等价 kubectl top pod），并结合 Pod spec 的 limits 计算百分比 */
export async function topPods(namespace?: string): Promise<PodMetricRow[]> {
  const pods = await listPods(namespace);
  const limitByKey = new Map<string, { limits?: Record<string, string> }>();
  for (const p of pods) {
    limitByKey.set(`${p.namespace}/${p.name}`, p.resources ?? {});
  }

  const res = namespace
    ? await customObjectsApi.listNamespacedCustomObject({ group: "metrics.k8s.io", version: "v1beta1", namespace, plural: "pods" })
    : await customObjectsApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "pods" });
  const items = ((res.body as { items?: unknown[] })?.items ?? []) as Array<{
    metadata?: { namespace?: string; name?: string };
    containers?: Array<{ usage?: Record<string, string> }>;
  }>;

  return items
    .map((item) => {
      const ns = item.metadata?.namespace ?? "";
      const name = item.metadata?.name ?? "";
      const usage = item.containers?.[0]?.usage ?? {};
      const limits = limitByKey.get(`${ns}/${name}`)?.limits ?? {};
      const cpuCores = parseCpu(usage.cpu) ?? 0;
      const memoryBytes = parseMemory(usage.memory) ?? 0;
      const cpuLimit = parseCpu(limits.cpu);
      const memoryLimit = parseMemory(limits.memory);
      return {
        name,
        namespace: ns,
        cpuCores,
        memoryBytes,
        cpuLimit,
        memoryLimit,
        memoryPercent:
          memoryLimit && memoryLimit > 0 ? Math.round((memoryBytes / memoryLimit) * 100) : undefined,
      };
    })
    .filter((row) => row.name !== "");
}

/** 读取 Deployment 完整定义（脱敏：env 只保留名称与来源，不含密钥值） */
export async function getDeployment(namespace: string, name: string) {
  const deployment = await appsApi.readNamespacedDeployment({ name, namespace });
  const spec = (deployment.spec ?? {}) as k8s.V1DeploymentSpec;
  const template = spec.template?.spec;
  const containers = (template?.containers ?? []) as k8s.V1Container[];
  const volumes = (template?.volumes ?? []) as k8s.V1Volume[];
  return {
    name: deployment.metadata?.name,
    namespace: deployment.metadata?.namespace,
    replicas: spec.replicas,
    strategy: spec.strategy?.type,
    selector: spec.selector?.matchLabels ?? {},
    containers: containers.map((c) => ({
      name: c.name,
      image: c.image,
      imagePullPolicy: c.imagePullPolicy,
      resources: c.resources,
      ports: (c.ports ?? []).map((p) => ({ name: p.name, containerPort: p.containerPort, protocol: p.protocol })),
      env: (c.env ?? []).map((e) => ({
        name: e.name,
        from: e.valueFrom
          ? (e.valueFrom.secretKeyRef?.name ?? e.valueFrom.configMapKeyRef?.name ?? "other")
          : "literal",
      })),
      volumeMounts: (c.volumeMounts ?? []).map((v) => ({ name: v.name, mountPath: v.mountPath })),
    })),
    volumes: volumes.map((v) => ({
      name: v.name,
      type: v.emptyDir
        ? "emptyDir"
        : v.persistentVolumeClaim
          ? "persistentVolumeClaim"
          : v.configMap
            ? "configMap"
            : v.secret
              ? "secret"
              : v.hostPath
                ? "hostPath"
                : "other",
      pvcName: v.persistentVolumeClaim?.claimName,
    })),
  };
}

/** 通过 kube-apiserver 的 exec 通道在目标 Pod 内执行只读命令（返回合并后的 stdout/stderr 文本） */
export function execPodCommand(
  namespace: string,
  podName: string,
  command: string,
  container?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const exec = new k8s.Exec(kubeConfig);
    let out = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(out);
    };
    const timeout = setTimeout(() => finish(new Error("exec timeout")), 20000);

    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      stderr.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      const socketPromise = exec.exec(
        namespace,
        podName,
        container ?? "",
        ["sh", "-c", command],
        stdout,
        stderr,
        null,
        false,
        (status) => {
          if (status?.status === "Failure") finish(new Error(status.message ?? "exec failed"));
          else finish();
        },
      );
      socketPromise.then(
        (socket) => socket.on("error", (err: Error) => finish(err)),
        (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
      );
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

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
  reason?: string;
  evictionMessage?: string;
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

  const phase = status.phase ?? "Unknown";
  let derivedStatus = phase;
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
  } else if (status.reason) {
    // 无容器状态但 Pod 有终态 reason（典型: Evicted）
    derivedStatus = status.reason;
  }

  const lastTerm = containerStatus?.lastState?.terminated;
  const disruption = status.conditions?.find((c) => c.type === "DisruptionTarget");

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
    reason: status.reason,
    evictionMessage: disruption?.message,
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
