// ============================================================================
// MCP Agent Discovery
//
// 根据 host 别名决定：
// 1. 优先查找 MCP_ENDPOINTS 环境变量中的 gRPC target
// 2. 否则尝试 SSH Host Registry 作为 fallback
// 3. 变更类命令不会自动降级到 SSH（安全策略）
// ============================================================================

import { loadHostRegistry, findHost } from "../gateway/sshHosts.js";
import type { HostTransport, McpEndpoint } from "./types.js";

interface EndpointMap {
  [host: string]: string;
}

function parseMcpEndpoints(): EndpointMap {
  const raw = process.env.MCP_ENDPOINTS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EndpointMap;
  } catch (e: any) {
    throw new Error(`MCP_ENDPOINTS 环境变量 JSON 解析失败: ${e.message}`);
  }
}

export function discoverTransport(host: string): HostTransport {
  const endpoints = parseMcpEndpoints();
  const target = endpoints[host];

  if (target) {
    const endpoint: McpEndpoint = {
      host,
      transport: "grpc",
      grpcTarget: target,
    };
    return {
      host,
      mcpEnabled: true,
      mcpEndpoint: endpoint,
      sshFallback: process.env.MCP_DISABLE_SSH_FALLBACK !== "true",
    };
  }

  // 尝试 SSH Host Registry 作为 fallback
  const registry = loadHostRegistry();
  const sshHost = findHost(registry, host);

  return {
    host,
    mcpEnabled: false,
    sshFallback: !!sshHost,
  };
}

export function isReadonlyTool(tool: string): boolean {
  const readonlyTools = new Set([
    "get_cpu_usage",
    "get_memory_info",
    "get_disk_usage",
    "get_network_stats",
    "get_process_info",
    "tail_syslog",
  ]);
  return readonlyTools.has(tool);
}
