// ============================================================================
// gRPC MCP Client — 调用 linux-mcp-server
// ============================================================================

import * as grpc from "@grpc/grpc-js";
import { getLinuxDiagnosticClient } from "./protoLoader.js";
import { signMcpJwt, createClientCredentials, loadTlsConfigFromEnv } from "./auth.js";
import { redact } from "../gateway/redact.js";
import type { McpCallOptions, McpClient, McpEndpoint, McpHealthResult, McpResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10000;
const MUTATION_TIMEOUT_MS = 30000;

const READONLY_TOOLS = new Set([
  "get_cpu_usage",
  "get_memory_info",
  "get_disk_usage",
  "get_network_stats",
  "get_process_info",
  "tail_syslog",
  "run_command",
  "read_file",
  "tail_file",
  "list_directory",
  "check_service_status",
  "get_kubernetes_resource",
  "describe_kubernetes_resource",
  "get_pod_logs",
]);

function isReadonly(tool: string): boolean {
  return READONLY_TOOLS.has(tool);
}

function getDeadline(timeoutMs: number): number {
  return Date.now() + timeoutMs;
}

export class GrpcMcpClient implements McpClient {
  private getClient(endpoint: McpEndpoint) {
    const target = endpoint.grpcTarget ?? "localhost:8443";
    const credentials = createClientCredentials(loadTlsConfigFromEnv());
    return getLinuxDiagnosticClient(target, credentials);
  }

  private getMetadata(tool: string): grpc.Metadata {
    const meta = new grpc.Metadata();
    // MVP：主 server 本地签发短期 JWT
    const token = signMcpJwt({ sessionId: "infrapilot-server", tools: [tool], expiresInSeconds: 300 });
    meta.add("authorization", `Bearer ${token}`);
    return meta;
  }

  async health(endpoint: McpEndpoint): Promise<McpHealthResult> {
    return new Promise((resolve) => {
      const client = this.getClient(endpoint);
      const meta = this.getMetadata("Health");
      client.Health({}, meta, { deadline: getDeadline(3000) }, (err: grpc.ServiceError | null, resp: any) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve({ ok: resp.ok, version: resp.version });
      });
    });
  }

  async call(endpoint: McpEndpoint, request: McpCallOptions): Promise<McpResult> {
    const start = Date.now();
    const client = this.getClient(endpoint);
    const meta = this.getMetadata(request.tool);
    const timeoutMs = request.timeoutMs ?? (isReadonly(request.tool) ? DEFAULT_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
    const tool = request.tool;
    const args = request.args;

    return new Promise((resolve) => {
      const handleError = (err: grpc.ServiceError | null, fallbackMsg: string) => {
        const error = err?.message ?? fallbackMsg;
        resolve({ success: false, error, durationMs: Date.now() - start });
      };

      const cb = (err: grpc.ServiceError | null, resp: any) => {
        if (err) {
          handleError(err, `gRPC 调用失败: ${tool}`);
          return;
        }
        resolve(this.toMcpResult(resp, Date.now() - start));
      };

      const deadline = getDeadline(timeoutMs);
      const req = this.buildGrpcRequest(tool, args);

      switch (tool) {
        case "get_cpu_usage":
          client.GetCpuUsage(req, meta, { deadline }, cb);
          break;
        case "get_memory_info":
          client.GetMemoryInfo(req, meta, { deadline }, cb);
          break;
        case "get_disk_usage":
          client.GetDiskUsage(req, meta, { deadline }, cb);
          break;
        case "get_network_stats":
          client.GetNetworkStats(req, meta, { deadline }, cb);
          break;
        case "get_process_info":
          client.GetProcessInfo(req, meta, { deadline }, cb);
          break;
        case "tail_syslog":
          client.TailSyslog(req, meta, { deadline }, cb);
          break;
        case "run_command":
        case "read_file":
        case "tail_file":
        case "list_directory":
        case "check_service_status":
        case "get_kubernetes_resource":
        case "describe_kubernetes_resource":
        case "get_pod_logs":
          client.RunCommand(req, meta, { deadline }, cb);
          break;
        case "restart_service":
          client.RestartService(req, meta, { deadline }, cb);
          break;
        case "kill_process":
          client.KillProcess(req, meta, { deadline }, cb);
          break;
        default:
          resolve({ success: false, error: `不支持的 MCP 工具: ${tool}`, durationMs: Date.now() - start });
      }
    });
  }

  async listTools(_endpoint: McpEndpoint): Promise<any[]> {
    // gRPC 服务未实现动态 list；返回静态工具列表即可
    return [];
  }

  private buildGrpcRequest(tool: string, args: Record<string, unknown>): any {
    const req: Record<string, any> = {};
    switch (tool) {
      case "get_cpu_usage":
        req.host = String(args.host ?? "local");
        req.top_n = Number(args.top_n ?? 5);
        break;
      case "get_memory_info":
        req.host = String(args.host ?? "local");
        if (args.pid) req.pid = Number(args.pid);
        break;
      case "get_disk_usage":
      case "tail_syslog":
      case "get_network_stats":
        req.host = String(args.host ?? "local");
        if (args.iface) req.iface = String(args.iface);
        if (args.lines) req.lines = Number(args.lines);
        break;
      case "get_process_info":
        req.host = String(args.host ?? "local");
        req.name_pattern = String(args.name_pattern ?? "");
        break;
      case "restart_service":
        req.host = String(args.host ?? "local");
        req.service_name = String(args.service_name ?? "");
        break;
      case "kill_process":
        req.host = String(args.host ?? "local");
        req.pid = Number(args.pid ?? 0);
        req.signal = String(args.signal ?? "SIGTERM");
        break;

      // 通用命令执行 —— 直接透传 command/args
      case "run_command": {
        req.host = String(args.host ?? "local");
        req.command = String(args.command ?? "");
        req.args = Array.isArray(args.args) ? args.args.map(String) : [];
        if (args.timeout_ms) req.timeout_ms = Number(args.timeout_ms);
        break;
      }

      // 常用只读命令的封装，最终都通过 RunCommand 发送
      case "read_file":
        req.host = String(args.host ?? "local");
        req.command = "cat";
        req.args = [String(args.path ?? "")];
        break;
      case "tail_file":
        req.host = String(args.host ?? "local");
        req.command = "tail";
        req.args = ["-n", String(args.lines ?? 20), String(args.path ?? "")];
        break;
      case "list_directory":
        req.host = String(args.host ?? "local");
        req.command = "ls";
        req.args = ["-la", String(args.path ?? ".")];
        break;
      case "check_service_status":
        req.host = String(args.host ?? "local");
        req.command = "systemctl";
        req.args = ["status", String(args.service_name ?? "")];
        break;
      case "get_kubernetes_resource":
        req.host = String(args.host ?? "local");
        req.command = "kubectl";
        req.args = buildKubectlArgs("get", args);
        break;
      case "describe_kubernetes_resource":
        req.host = String(args.host ?? "local");
        req.command = "kubectl";
        req.args = buildKubectlArgs("describe", args);
        break;
      case "get_pod_logs":
        req.host = String(args.host ?? "local");
        req.command = "kubectl";
        req.args = buildKubectlLogArgs(args);
        break;
    }
    return req;
  }

  private toMcpResult(resp: any, durationMs: number): McpResult {
    const base = {
      success: resp.success ?? false,
      error: resp.error || undefined,
      durationMs,
      exitCode: resp.exit_code ?? undefined,
    };

    // 结构化数据优先放入 data
    const data: Record<string, unknown> = {};
    const stdout: string[] = [];

    if (resp.usage_percent !== undefined) data.usage_percent = Number(resp.usage_percent);
    if (resp.top_processes) data.top_processes = resp.top_processes;
    if (resp.total_mb !== undefined) {
      data.total_mb = Number(resp.total_mb);
      data.used_mb = Number(resp.used_mb);
      data.available_mb = Number(resp.available_mb);
      data.oom_history = resp.oom_history || "";
      if (resp.process_detail) data.process_detail = resp.process_detail;
    }
    if (resp.disks) data.disks = resp.disks;
    if (resp.total_connections !== undefined) {
      data.total_connections = Number(resp.total_connections);
      data.tcp_established = Number(resp.tcp_established);
      data.tcp_time_wait = Number(resp.tcp_time_wait);
      data.interfaces = resp.interfaces || [];
    }
    if (resp.processes) data.processes = resp.processes;
    if (resp.lines) data.lines = resp.lines;

    if (resp.stdout) stdout.push(redact(String(resp.stdout)));
    if (resp.stderr) stdout.push(`stderr: ${redact(String(resp.stderr))}`);

    return {
      ...base,
      data: Object.keys(data).length > 0 ? data : undefined,
      stdout: stdout.length > 0 ? stdout.join("\n") : undefined,
    };
  }
}

function buildKubectlArgs(subCommand: string, args: Record<string, unknown>): string[] {
  const out: string[] = [subCommand];
  if (args.namespace) {
    out.push("-n", String(args.namespace));
  }
  if (args.all_namespaces) {
    out.push("--all-namespaces");
  }
  out.push(String(args.resource ?? "pods"));
  if (args.name) {
    out.push(String(args.name));
  }
  if (args.output) {
    out.push("-o", String(args.output));
  }
  return out;
}

function buildKubectlLogArgs(args: Record<string, unknown>): string[] {
  const out: string[] = ["logs"];
  if (args.namespace) {
    out.push("-n", String(args.namespace));
  }
  out.push(String(args.pod_name ?? ""));
  if (args.container) {
    out.push("-c", String(args.container));
  }
  if (args.tail_lines !== undefined) {
    out.push("--tail", String(args.tail_lines));
  }
  if (args.previous) {
    out.push("--previous");
  }
  if (args.since) {
    out.push("--since", String(args.since));
  }
  return out;
}

export const grpcMcpClient = new GrpcMcpClient();
