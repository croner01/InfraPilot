// ============================================================================
// MCP Agent Discovery
//
// 当前实现：
// 1. 优先查找 MCP_ENDPOINTS 环境变量中的 gRPC target
// 2. 否则尝试 SSH Host Registry 作为 fallback
// 3. 变更类命令不会自动降级到 SSH（安全策略）
//
// 注：Headless Service DNS 自动发现（通过 K8s DNS 解析 linux-mcp-server Pod）
// 已评估但优先级标记为低，暂不实现；后续如需扩展，可在此模块增加 DNS SRV/A 记录解析。
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
  // 1. 优先从 Host Registry 读取 MCP 配置（前端统一配置）
  const registry = loadHostRegistry();
  const registryHost = findHost(registry, host);
  if (registryHost?.auth.type === "mcp" && registryHost.auth.endpoint) {
    const endpoint: McpEndpoint = {
      host,
      transport: "grpc",
      grpcTarget: registryHost.auth.endpoint,
    };
    return {
      host,
      mcpEnabled: true,
      mcpEndpoint: endpoint,
      // MCP 主机不再走 SSH fallback，避免把 gRPC endpoint 误当成 SSH 地址
      sshFallback: false,
    };
  }

  // 2. 兜底：MCP_ENDPOINTS 环境变量（兼容旧配置）
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

  // 3. SSH Host Registry 作为 fallback
  const sshHost = registryHost;

  return {
    host,
    mcpEnabled: false,
    sshFallback: !!sshHost && sshHost.auth.type !== "mcp",
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
