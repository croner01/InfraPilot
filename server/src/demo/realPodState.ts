// ============================================================================
// 演示场景状态适配器 —— 从真实K8s集群读取 order-api Pod 状态,
// 输出与旧 demo/supervisor.ts 完全一致的 PodState 结构, 使前端面板无需改动。
//
// 替代了原先基于本机子进程模拟的 orderApiSupervisor: 现在 restartCount /
// status(CrashLoopBackOff/OOMKilled) / lastState / events 全部来自真实
// kubelet 上报的数据(见 server/src/skills/k8s/client.ts), currentRssMb 通过
// crictl stats 读取真实容器内存占用。
// ============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listEventsForPod, listPods, deletePod, patchDeploymentMemoryLimit } from "../skills/k8s/client.js";

const execFileAsync = promisify(execFile);

const NAMESPACE = "order-service";
const DEPLOYMENT = "order-api";
const CONTAINER = "order-api";

export interface PodEvent {
  time: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
}

export interface PodState {
  podName: string;
  namespace: string;
  status: string;
  restartCount: number;
  startedAt?: string;
  lastState?: { reason: string; exitCode: number; finishedAt: string };
  resources: { limitsMemoryMb: number };
  events: PodEvent[];
  currentRssMb: number;
}

async function readCurrentRssMb(podName: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("sudo", ["crictl", "stats", "-o", "json", "--pod", podName], {
      timeout: 3000,
    });
    const parsed = JSON.parse(stdout);
    const stat = parsed?.stats?.[0];
    const bytes = Number(stat?.memory?.workingSetBytes?.value ?? 0);
    return bytes > 0 ? Math.round(bytes / 1024 / 1024) : 0;
  } catch {
    return 0; // 容器已退出/正在重启窗口期等, 读取不到即返回0, 不影响主状态展示
  }
}

/** 从真实集群查询 order-api 演示Pod的完整状态, 结构与旧模拟器保持一致 */
export async function getRealPodState(): Promise<PodState | null> {
  const pods = await listPods(NAMESPACE);
  const pod = pods.find((p) => p.name.startsWith(DEPLOYMENT));
  if (!pod) return null;

  const rawEvents = await listEventsForPod(NAMESPACE, pod.name);
  const events: PodEvent[] = rawEvents.slice(-10).map((e) => ({
    time: e.time,
    type: e.type === "Warning" ? "Warning" : "Normal",
    reason: e.reason,
    message: e.message,
  }));

  const limitStr = pod.resources?.limits?.memory ?? "";
  const limitMb = limitStr.endsWith("Mi")
    ? Number(limitStr.replace("Mi", ""))
    : limitStr.endsWith("Gi")
      ? Number(limitStr.replace("Gi", "")) * 1024
      : 0;

  const currentRssMb = await readCurrentRssMb(pod.name);

  return {
    podName: pod.name,
    namespace: pod.namespace,
    status: pod.status,
    restartCount: pod.restartCount,
    startedAt: pod.startedAt,
    lastState: pod.lastState
      ? { reason: pod.lastState.reason, exitCode: pod.lastState.exitCode, finishedAt: pod.lastState.finishedAt }
      : undefined,
    resources: { limitsMemoryMb: limitMb },
    events,
    currentRssMb,
  };
}

/** 重置演示场景: 把内存limit改回200Mi(故障态)并删除当前Pod触发重建 */
export async function resetRealDemoScenario(limitMb = 200): Promise<void> {
  await patchDeploymentMemoryLimit(NAMESPACE, DEPLOYMENT, CONTAINER, limitMb);
  const pods = await listPods(NAMESPACE);
  const pod = pods.find((p) => p.name.startsWith(DEPLOYMENT));
  if (pod) {
    await deletePod(NAMESPACE, pod.name);
  }
}
