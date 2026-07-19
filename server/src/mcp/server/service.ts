// ============================================================================
// linux-mcp-server — gRPC service 实现
// ============================================================================

import * as grpc from "@grpc/grpc-js";
import { v4 as uuidv4 } from "uuid";
import { createAuthMiddleware } from "./auth.js";
import {
  getCpuUsage,
  getMemoryInfo,
  getDiskUsage,
  getNetworkStats,
  getProcessInfo,
  tailSyslog,
  restartService,
  killProcess,
} from "./runner.js";

function writeAudit(tool: string, success: boolean, error: string | undefined, durationMs: number) {
  try {
    const event = {
      id: uuidv4(),
      source: "linux-mcp-server",
      tool,
      success,
      error,
      durationMs,
      timestamp: new Date().toISOString(),
    };
    console.error(`[MCP_AUDIT] ${JSON.stringify(event)}`);
  } catch {
    // ignore
  }
}

function finish<T>(
  callback: grpc.sendUnaryData<T>,
  response: T,
  tool: string,
  start: number,
  error?: string
) {
  const durationMs = Date.now() - start;
  writeAudit(tool, !error, error, durationMs);
  callback(null, response);
}

export const linuxDiagnosticService = {
  health: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
    callback(null, { ok: true, version: "0.2.0" });
  },

  getCpuUsage: createAuthMiddleware<any, any>("get_cpu_usage")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await getCpuUsage(req.top_n ?? 5);
      finish(callback, { ...result, duration_ms: Date.now() - start }, "get_cpu_usage", start, result.error);
    }
  ),

  getMemoryInfo: createAuthMiddleware<any, any>("get_memory_info")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await getMemoryInfo(req.pid ?? undefined);
      finish(callback, { ...result, duration_ms: Date.now() - start }, "get_memory_info", start, result.error);
    }
  ),

  getDiskUsage: createAuthMiddleware<any, any>("get_disk_usage")(
    async (_call, callback) => {
      const start = Date.now();
      const result = await getDiskUsage();
      finish(callback, { ...result, duration_ms: Date.now() - start }, "get_disk_usage", start, result.error);
    }
  ),

  getNetworkStats: createAuthMiddleware<any, any>("get_network_stats")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await getNetworkStats(req.iface || undefined);
      finish(callback, { ...result, duration_ms: Date.now() - start }, "get_network_stats", start, result.error);
    }
  ),

  getProcessInfo: createAuthMiddleware<any, any>("get_process_info")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await getProcessInfo(req.name_pattern ?? "");
      finish(callback, { ...result, duration_ms: Date.now() - start }, "get_process_info", start, result.error);
    }
  ),

  tailSyslog: createAuthMiddleware<any, any>("tail_syslog")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await tailSyslog(req.lines ?? 20);
      finish(callback, { ...result, duration_ms: Date.now() - start }, "tail_syslog", start, result.error);
    }
  ),

  restartService: createAuthMiddleware<any, any>("restart_service")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await restartService(req.service_name ?? "");
      finish(
        callback,
        {
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.code,
          error: result.error,
          duration_ms: Date.now() - start,
        },
        "restart_service",
        start,
        result.error
      );
    }
  ),

  killProcess: createAuthMiddleware<any, any>("kill_process")(
    async (call, callback) => {
      const start = Date.now();
      const req = call.request;
      const result = await killProcess(req.pid ?? 0, req.signal || "SIGTERM");
      finish(
        callback,
        {
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.code,
          error: result.error,
          duration_ms: Date.now() - start,
        },
        "kill_process",
        start,
        result.error
      );
    }
  ),
};
