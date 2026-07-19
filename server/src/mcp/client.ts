// ============================================================================
// MCP Client Router
//
// 对外暴露统一的 `executeLinuxToolOnHost`，内部决定走 gRPC MCP 还是 SSH Proxy。
// - MCP 优先：若 host 注册了 MCP endpoint 且健康检查通过，走 gRPC。
// - SSH fallback：只读工具在无 MCP 时 fallback 到 SSH Proxy；变更类工具不降级。
// ============================================================================

import { grpcMcpClient } from "./grpcClient.js";
import { executeOnHost } from "../skills/linux/remoteExecutor.js";
import { discoverTransport, isReadonlyTool } from "./discovery.js";
import { redact } from "../gateway/redact.js";
import type { McpCallOptions, McpResult } from "./types.js";
import type { ToolExecutionResult } from "../types.js";

export interface ExecuteOptions {
  tool: string;
  args: Record<string, unknown>;
  caller?: string;
  timeoutMs?: number;
}

function toolToCommand(tool: string, args: Record<string, unknown>): { command: string; args: string[] } {
  switch (tool) {
    case "get_cpu_usage":
      return { command: "sh", args: ["-c", "top -b -n 1 | head -n 15"] };
    case "get_memory_info":
      return { command: "free", args: ["-m"] };
    case "get_disk_usage":
      return { command: "df", args: ["-h"] };
    case "get_process_info": {
      const pattern = String(args.name_pattern ?? "").replace(/[^a-zA-Z0-9_.\-]/g, "");
      return {
        command: "sh",
        args: ["-c", `ps -eo pid,rss,pcpu,etimes,cmd | grep -i '${pattern}' | grep -v grep || true`],
      };
    }
    case "tail_syslog":
      return {
        command: "sh",
        args: ["-c", "dmesg 2>/dev/null | tail -n 20 || echo '(无dmesg访问权限)'"],
      };
    case "get_network_stats":
      return { command: "ss", args: ["-s"] };
    default:
      return { command: "echo", args: ["unsupported fallback"] };
  }
}

async function executeViaSshFallback(tool: string, args: Record<string, unknown>, options?: { timeoutMs?: number; caller?: string }): Promise<ToolExecutionResult> {
  const host = String(args.host ?? "local");
  const { command, args: cmdArgs } = toolToCommand(tool, args);
  const result = await executeOnHost(host, command, cmdArgs, options);

  return {
    success: result.success,
    stdout: redact(result.stdout ?? ""),
    stderr: redact(result.stderr ?? ""),
    error: result.error,
    durationMs: result.durationMs,
    data: { transport: "ssh_proxy" },
  };
}

function mcpResultToToolResult(result: McpResult): ToolExecutionResult {
  return {
    success: result.success,
    data: result.data ? { ...result.data, transport: "grpc" } : { transport: "grpc" },
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    durationMs: result.durationMs,
  };
}

export async function executeLinuxToolOnHost(opts: ExecuteOptions): Promise<ToolExecutionResult> {
  const host = String(opts.args.host ?? "local");

  // local 主机直接走 SSH fallback（即本地执行）
  if (host === "local") {
    return executeViaSshFallback(opts.tool, opts.args, { timeoutMs: opts.timeoutMs, caller: opts.caller });
  }

  const transport = discoverTransport(host);

  // 优先尝试 MCP
  if (transport.mcpEnabled && transport.mcpEndpoint) {
    try {
      const health = await grpcMcpClient.health(transport.mcpEndpoint);
      if (health.ok) {
        const callOpts: McpCallOptions = {
          tool: opts.tool,
          args: opts.args,
          caller: opts.caller,
          timeoutMs: opts.timeoutMs,
        };
        const mcpResult = await grpcMcpClient.call(transport.mcpEndpoint, callOpts);
        return mcpResultToToolResult(mcpResult);
      }
    } catch (e: any) {
      // MCP 不可用，继续 fallback
    }
  }

  // SSH fallback：仅只读工具允许降级
  if (transport.sshFallback && isReadonlyTool(opts.tool)) {
    return executeViaSshFallback(opts.tool, opts.args, { timeoutMs: opts.timeoutMs, caller: opts.caller });
  }

  return {
    success: false,
    error: transport.sshFallback
      ? `变更类工具 ${opts.tool} 不允许通过 SSH 执行（目标主机 ${host} 无可用 MCP Agent）`
      : `未找到主机 ${host} 的可用执行通道（无 MCP Agent 且无 SSH 配置）`,
    durationMs: 0,
  };
}
