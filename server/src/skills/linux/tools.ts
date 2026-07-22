// ============================================================================
// Linux Skill — 对应设计文档 §7.1 / §5.3 linux-mcp-server
//
// 本实现支持三种执行模式:
// 1. host="local": 在当前 sandbox/后端主机本地执行真实只读诊断命令（保留 Phase 1 行为）
// 2. host=注册别名且存在 linux-mcp-server Agent: 通过 MCP Client Router 走 gRPC 结构化调用
// 3. host=注册别名但无 MCP Agent: 只读工具 fallback 到 SSH Proxy；变更类工具拒绝执行
//
// 工具契约(inputSchema/输出结构)保持不变,Agent 与 Prompt 无需改动。
// ============================================================================

import { ToolDef, ToolExecutionResult } from "../../types.js";
import { executeOnHost } from "./remoteExecutor.js";
import { executeLinuxToolOnHost } from "../../mcp/client.js";
import { linuxAgentTools } from "./agentTools.js";
import { redact } from "../../gateway/redact.js";
import { isCommandAllowed } from "../../mcp/server/allowlist.js";

export const linuxTools: ToolDef[] = [
  {
    name: "get_cpu_usage",
    skill: "linux",
    risk: "readonly",
    description: "获取主机CPU使用率及Top进程列表(基于 top/ps)。支持指定远程主机名,未指定则在本机执行。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名,如 'local' 或 Host Registry 中注册的别名 'node-1'" },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "get_memory_info",
    skill: "linux",
    risk: "readonly",
    description: "获取主机内存使用情况(free)、是否存在OOM历史(dmesg)、以及指定pid的详细内存占用(/proc/pid/status)。支持远程主机。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名,如 'local' 或 'node-1'" },
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
    description: "获取磁盘使用率(df -h)。支持远程主机。",
    parameters: {
      type: "object",
      properties: { host: { type: "string", description: "目标主机名,如 'local' 或 'node-1'" } },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "get_process_info",
    skill: "linux",
    risk: "readonly",
    description: "按名称模式查找进程详情(ps),常用于定位某服务对应的具体pid/内存/CPU/存活时长。支持远程主机。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名,如 'local' 或 'node-1'" },
        name_pattern: { type: "string", description: "进程名匹配模式,如 'orderApiWorker'" },
      },
      required: ["host", "name_pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "tail_recent_dmesg_or_syslog",
    skill: "linux",
    risk: "readonly",
    description: "获取内核/系统近期日志,用于判断是否有OOM Killer触发记录等内核级事件。支持远程主机。",
    parameters: {
      type: "object",
      properties: { host: { type: "string", description: "目标主机名,如 'local' 或 'node-1'" } },
      required: ["host"],
      additionalProperties: false,
    },
  },
  ...linuxAgentTools,
];

async function findWorkerPid(namePattern: string): Promise<number | null> {
  const { stdout } = await executeOnHost("local", "ps", ["-eo", "pid,cmd"]);
  const lines = stdout?.split("\n") ?? [];
  for (const line of lines) {
    if (line.includes(namePattern) && !line.includes("grep")) {
      const m = line.trim().match(/^(\d+)\s+/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function sanitizePattern(pattern: string): string {
  return pattern.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

async function executeLocalLinuxTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();

  switch (tool) {
    case "get_cpu_usage": {
      const result = await executeOnHost("local", "sh", ["-c", "top -b -n 1 | head -n 15"], { timeoutMs: 10000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "get_memory_info": {
      const [freeRes, dmesgRes] = await Promise.all([
        executeOnHost("local", "free", ["-m"], { timeoutMs: 8000 }),
        executeOnHost("local", "sh", ["-c", "dmesg 2>/dev/null | grep -i 'out of memory\\|oom' | tail -n 10 || true"], { timeoutMs: 8000 }),
      ]);

      let procDetail: Record<string, unknown> | null = null;
      const pid = args.pid as number | undefined;
      if (pid) {
        try {
          const status = await executeOnHost("local", "cat", [`/proc/${pid}/status`]);
          const rss = status.stdout?.match(/VmRSS:\s+(\d+)\s+kB/)?.[1];
          const vmSize = status.stdout?.match(/VmSize:\s+(\d+)\s+kB/)?.[1];
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
        success: freeRes.success,
        data: {
          free_output: redact(freeRes.stdout ?? ""),
          oom_history: redact(dmesgRes.stdout ?? "") || "(无OOM Killer触发记录, 说明是容器级/应用级自我判断退出, 而非内核强杀)",
          process_detail: procDetail,
        },
        stderr: freeRes.stderr || dmesgRes.stderr,
        error: freeRes.error || dmesgRes.error,
        durationMs: Date.now() - start,
      };
    }
    case "get_disk_usage": {
      const result = await executeOnHost("local", "df", ["-h"], { timeoutMs: 8000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "get_process_info": {
      const pattern = sanitizePattern(String(args.name_pattern ?? ""));
      const result = await executeOnHost(
        "local",
        "sh",
        ["-c", `ps -eo pid,rss,pcpu,etimes,cmd | grep -i '${pattern}' | grep -v grep || true`],
        { timeoutMs: 8000 }
      );
      return { success: result.success, stdout: result.stdout || "(未找到匹配进程)", stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "tail_recent_dmesg_or_syslog":
    case "tail_syslog": {
      const result = await executeOnHost(
        "local",
        "sh",
        ["-c", "dmesg 2>/dev/null | tail -n 20 || echo '(无dmesg访问权限, 生产环境通过node常驻agent或特权容器采集)'"],
        { timeoutMs: 8000 }
      );
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "get_network_stats": {
      const result = await executeOnHost("local", "ss", ["-s"], { timeoutMs: 8000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "run_command": {
      const command = String(args.command ?? "");
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const check = isCommandAllowed(command, cmdArgs);
      if (!check.allowed) {
        return { success: false, error: check.reason, durationMs: Date.now() - start };
      }
      const result = await executeOnHost("local", command, cmdArgs, { timeoutMs: Number(args.timeout_ms ?? 10000) });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "read_file": {
      const result = await executeOnHost("local", "cat", [String(args.path ?? "")], { timeoutMs: 10000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "tail_file": {
      const lines = String(args.lines ?? 20);
      const result = await executeOnHost("local", "tail", ["-n", lines, String(args.path ?? "")], { timeoutMs: 10000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "list_directory": {
      const result = await executeOnHost("local", "ls", ["-la", String(args.path ?? ".")], { timeoutMs: 8000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "check_service_status": {
      const result = await executeOnHost("local", "systemctl", ["status", String(args.service_name ?? "")], { timeoutMs: 10000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "get_kubernetes_resource": {
      const kubectlArgs = buildKubectlArgs("get", args);
      const result = await executeOnHost("local", "kubectl", kubectlArgs, { timeoutMs: 15000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "describe_kubernetes_resource": {
      const kubectlArgs = buildKubectlArgs("describe", args);
      const result = await executeOnHost("local", "kubectl", kubectlArgs, { timeoutMs: 15000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    case "get_pod_logs": {
      const kubectlArgs = buildKubectlLogArgs(args);
      const result = await executeOnHost("local", "kubectl", kubectlArgs, { timeoutMs: 15000 });
      return { success: result.success, stdout: result.stdout, stderr: result.stderr, error: result.error, durationMs: Date.now() - start };
    }
    default:
      return { success: false, error: `本地不支持的linux工具: ${tool}`, durationMs: Date.now() - start };
  }
}

function buildKubectlArgs(subCommand: string, args: Record<string, unknown>): string[] {
  const out: string[] = [subCommand];
  if (args.namespace) out.push("-n", String(args.namespace));
  if (args.all_namespaces) out.push("--all-namespaces");
  out.push(String(args.resource ?? "pods"));
  if (args.name) out.push(String(args.name));
  if (args.output) out.push("-o", String(args.output));
  return out;
}

function buildKubectlLogArgs(args: Record<string, unknown>): string[] {
  const out: string[] = ["logs"];
  if (args.namespace) out.push("-n", String(args.namespace));
  out.push(String(args.pod_name ?? ""));
  if (args.container) out.push("-c", String(args.container));
  if (args.tail_lines !== undefined) out.push("--tail", String(args.tail_lines));
  if (args.previous) out.push("--previous");
  if (args.since) out.push("--since", String(args.since));
  return out;
}

export async function executeLinuxTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  const host = String(args.host ?? "local");

  try {
    if (host === "local") {
      return await executeLocalLinuxTool(tool, args);
    }

    // 远程主机：通过 MCP Client Router（MCP 优先 / SSH fallback）
    return await executeLinuxToolOnHost({
      tool,
      args,
      caller: "linux-skill",
      timeoutMs: tool === "restart_service" || tool === "kill_process" ? 30000 : 10000,
    });
  } catch (e: any) {
    return { success: false, error: String(e?.message ?? e), durationMs: Date.now() - start };
  }
}

export { findWorkerPid };
