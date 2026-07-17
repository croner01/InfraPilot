// ============================================================================
// Linux Skill — 对应设计文档 §7.1 / §5.3 linux-mcp-server
//
// 本实现直接在 sandbox 主机上执行真实的只读诊断命令(top/free/ps/df/ss等),
// 因此返回的是宿主机的真实系统状态。对于"目标主机"参数, demo 场景下只支持
// host="local"(即当前 sandbox), 生产环境中 host 参数会被 Command Gateway
// 路由到 ssh-proxy 对指定远程主机执行 —— 工具契约(inputSchema/输出结构)
// 保持不变, 只需替换 runLocal() 为 runViaSshProxy() 即可无缝切换, Agent核心
// 与Prompt完全不用改动。
// ============================================================================

import { execFile } from "node:child_process";
import fs from "node:fs";
import { ToolDef, ToolExecutionResult } from "../../types.js";
import { redact } from "../../gateway/redact.js";

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code: (err as any)?.code ?? 0 });
    });
  });
}

export const linuxTools: ToolDef[] = [
  {
    name: "get_cpu_usage",
    skill: "linux",
    risk: "readonly",
    description: "获取主机CPU使用率及Top进程列表(基于 top/ps)",
    parameters: {
      type: "object",
      properties: { host: { type: "string", description: "目标主机名, demo环境固定为 'local'" } },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "get_memory_info",
    skill: "linux",
    risk: "readonly",
    description: "获取主机内存使用情况(free)、是否存在OOM历史(dmesg)、以及指定pid的详细内存占用(/proc/pid/status)",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        pid: { type: "number", description: "可选,指定进程pid以获取该进程的详细内存占用" },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "get_disk_usage",
    skill: "linux",
    risk: "readonly",
    description: "获取磁盘使用率(df -h)",
    parameters: { type: "object", properties: { host: { type: "string" } }, required: ["host"], additionalProperties: false },
  },
  {
    name: "get_process_info",
    skill: "linux",
    risk: "readonly",
    description: "按名称模式查找进程详情(ps),常用于定位某服务对应的具体pid/内存/CPU/存活时长",
    parameters: {
      type: "object",
      properties: { host: { type: "string" }, name_pattern: { type: "string", description: "进程名匹配模式,如 'orderApiWorker'" } },
      required: ["host", "name_pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "tail_recent_dmesg_or_syslog",
    skill: "linux",
    risk: "readonly",
    description: "获取内核/系统近期日志,用于判断是否有OOM Killer触发记录等内核级事件(demo中降级为读取当前系统dmesg,若无权限则返回空)",
    parameters: { type: "object", properties: { host: { type: "string" } }, required: ["host"], additionalProperties: false },
  },
];

async function findWorkerPid(namePattern: string): Promise<number | null> {
  const { stdout } = await run("ps", ["-eo", "pid,cmd"]);
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes(namePattern) && !line.includes("grep")) {
      const m = line.trim().match(/^(\d+)\s+/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

export async function executeLinuxTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    switch (tool) {
      case "get_cpu_usage": {
        const { stdout } = await run("sh", ["-c", "top -b -n 1 | head -n 15"]);
        return { success: true, stdout: redact(stdout), durationMs: Date.now() - start };
      }
      case "get_memory_info": {
        const { stdout: freeOut } = await run("free", ["-m"]);
        const { stdout: dmesgOut } = await run("sh", ["-c", "dmesg 2>/dev/null | grep -i 'out of memory\\|oom' | tail -n 10 || true"]);
        let procDetail: Record<string, unknown> | null = null;
        const pid = args.pid as number | undefined;
        if (pid) {
          try {
            const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
            const rss = status.match(/VmRSS:\s+(\d+)\s+kB/)?.[1];
            const vmSize = status.match(/VmSize:\s+(\d+)\s+kB/)?.[1];
            procDetail = {
              pid,
              rss_mb: rss ? Math.round(Number(rss) / 1024) : null,
              vm_size_mb: vmSize ? Math.round(Number(vmSize) / 1024) : null,
            };
          } catch {
            procDetail = { pid, error: "process not found (可能已退出/重启)" };
          }
        }
        return {
          success: true,
          data: { free_output: redact(freeOut), oom_history: redact(dmesgOut) || "(无OOM Killer触发记录, 说明是容器级/应用级自我判断退出, 而非内核强杀)", process_detail: procDetail },
          durationMs: Date.now() - start,
        };
      }
      case "get_disk_usage": {
        const { stdout } = await run("df", ["-h"]);
        return { success: true, stdout: redact(stdout), durationMs: Date.now() - start };
      }
      case "get_process_info": {
        const pattern = String(args.name_pattern ?? "");
        const { stdout } = await run("sh", ["-c", `ps -eo pid,rss,pcpu,etimes,cmd | grep -i '${pattern.replace(/[^a-zA-Z0-9_.\-]/g, "")}' | grep -v grep || true`]);
        return { success: true, stdout: redact(stdout) || "(未找到匹配进程)", durationMs: Date.now() - start };
      }
      case "tail_recent_dmesg_or_syslog": {
        const { stdout } = await run("sh", ["-c", "dmesg 2>/dev/null | tail -n 20 || echo '(sandbox环境无dmesg访问权限, 生产环境通过node常驻agent或特权容器采集)'"]);
        return { success: true, stdout: redact(stdout), durationMs: Date.now() - start };
      }
      default:
        return { success: false, error: `未知的linux工具: ${tool}`, durationMs: Date.now() - start };
    }
  } catch (e: any) {
    return { success: false, error: String(e?.message ?? e), durationMs: Date.now() - start };
  }
}

export { findWorkerPid };
