// ============================================================================
// Demo "K8s kubelet" 模拟器 —— 管理 order-api 演示工作负载的生命周期
//
// 设计说明(诚实标注): 本 sandbox 环境没有可用的真实 Kubernetes/OpenStack 集群,
// 因此本模块以一个真实的本机子进程(order-api)模拟一个 Pod:
//   - 子进程是真实 OS 进程, 会真实地消耗内存直至真实退出(exit code 137)
//   - 本模块像 kubelet 一样监控退出并按 CrashLoopBackOff 语义重启、计数 restartCount
//   - k8s Skill(skills/k8s)对上层暴露的接口与 kubectl 语义严格对齐(describe pod
//     的返回结构与真实 kubectl 输出字段一致), 生产环境中把这里的实现替换为
//     真正的 @kubernetes/client-node 调用即可, Agent 核心与工具契约不需要变化。
// ============================================================================

import { ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "orderApiWorker.mjs");
export const LOG_FILE = path.join(process.cwd(), "data", "order-api.log");

export interface PodEvent {
  time: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
}

export interface PodState {
  podName: string;
  namespace: string;
  status: "Running" | "CrashLoopBackOff" | "Pending";
  restartCount: number;
  pid?: number;
  startedAt: string;
  lastState?: { reason: string; exitCode: number; finishedAt: string };
  resources: { limitsMemoryMb: number };
  events: PodEvent[];
  currentRssMb: number;
}

class OrderApiSupervisor {
  private child?: ChildProcess;
  private state: PodState;
  private restartTimer?: NodeJS.Timeout;
  private memPoll?: NodeJS.Timeout;
  private crashLoopStreak = 0;
  private destroyed = false;
  private limitMb = 200; // 模拟 k8s resources.limits.memory, 初始配置过低导致故障

  constructor() {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    this.state = {
      podName: "order-api-7f9c-x2j8l",
      namespace: "order-service",
      status: "Pending",
      restartCount: 0,
      startedAt: new Date().toISOString(),
      resources: { limitsMemoryMb: this.limitMb },
      events: [],
      currentRssMb: 0,
    };
  }

  getState(): PodState {
    return { ...this.state, events: [...this.state.events] };
  }

  /** 修复动作会调用此方法上调内存 limit 并重启 —— 对应 Remediation 执行落地 */
  patchMemoryLimit(newLimitMb: number) {
    this.limitMb = newLimitMb;
    this.state.resources.limitsMemoryMb = newLimitMb;
    this.pushEvent("Normal", "Patched", `resources.limits.memory 调整为 ${newLimitMb}Mi`);
    this.restartNow("配置变更触发重启");
  }

  /** 完全重置演示场景(用于前端"重新开始演示"按钮) */
  resetScenario(limitMb = 200) {
    this.limitMb = limitMb;
    this.state.restartCount = 0;
    this.state.status = "Pending";
    this.state.events = [];
    this.state.lastState = undefined;
    this.crashLoopStreak = 0;
    this.state.resources.limitsMemoryMb = limitMb;
    if (this.child) {
      this.child.removeAllListeners("exit");
      this.child.kill("SIGKILL");
      this.child = undefined;
    }
    if (this.restartTimer) clearTimeout(this.restartTimer);
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, "");
    this.spawn();
  }

  restartNow(reason: string) {
    if (this.child) {
      this.child.kill("SIGTERM");
    } else {
      this.spawn();
    }
    this.pushEvent("Normal", "Restarted", reason);
  }

  start() {
    if (this.destroyed) return;
    this.spawn();
    this.memPoll = setInterval(() => this.pollMemory(), 700);
  }

  stop() {
    this.destroyed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.memPoll) clearInterval(this.memPoll);
    this.child?.kill("SIGKILL");
  }

  private pollMemory() {
    if (!this.child?.pid) return;
    try {
      const statusPath = `/proc/${this.child.pid}/status`;
      const raw = fs.readFileSync(statusPath, "utf8");
      const match = raw.match(/VmRSS:\s+(\d+)\s+kB/);
      if (match) {
        this.state.currentRssMb = Math.round(Number(match[1]) / 1024);
      }
    } catch {
      // 进程已退出等情况, 忽略
    }
  }

  private spawn() {
    this.state.status = "Running";
    this.state.pid = undefined;
    const child = fork(WORKER_PATH, [], {
      env: {
        ...process.env,
        OOM_THRESHOLD_MB: String(this.limitMb),
        LEAK_RATE_MB: "6",
        TICK_MS: "700",
        LOG_FILE,
        PORT: "0",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    this.state.pid = child.pid;
    this.state.startedAt = new Date().toISOString();
    this.pushEvent("Normal", "Started", `容器已启动 pid=${child.pid}`);

    child.on("exit", (code) => {
      const exitCode = code ?? 1;
      const reason = exitCode === 137 ? "OOMKilled" : exitCode === 0 ? "Completed" : "Error";
      this.state.lastState = { reason, exitCode, finishedAt: new Date().toISOString() };
      this.state.restartCount += 1;
      this.child = undefined;
      this.state.pid = undefined;

      if (reason === "OOMKilled") {
        this.crashLoopStreak += 1;
        this.pushEvent("Warning", "OOMKilling", `容器因内存超限被终止, exit code ${exitCode}`);
      }

      if (this.crashLoopStreak >= 2) {
        this.state.status = "CrashLoopBackOff";
      }

      if (this.destroyed) return;
      // 模拟 kubelet 的指数退避重启策略(demo中简化为固定短延迟以便快速观测)
      const backoffMs = Math.min(1200 * this.state.restartCount, 6000);
      this.pushEvent("Warning", "BackOff", `将在 ${Math.round(backoffMs / 1000)}s 后重试启动容器`);
      this.restartTimer = setTimeout(() => this.spawn(), backoffMs);
    });
  }

  private pushEvent(type: "Normal" | "Warning", reason: string, message: string) {
    this.state.events.push({ time: new Date().toISOString(), type, reason, message });
    if (this.state.events.length > 30) this.state.events.shift();
  }
}

export const orderApiSupervisor = new OrderApiSupervisor();
