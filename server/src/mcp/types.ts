// ============================================================================
// MCP (Model Context Protocol) Transport 共享类型
// 对应设计文档 §5 MCP Server 设计
// ============================================================================

import type { ToolDef } from "../types.js";

export type McpTransport = "grpc" | "ssh_proxy";

export interface McpEndpoint {
  /** 逻辑主机名，与 SSH Host Registry 中的 name 对齐 */
  host: string;
  transport: McpTransport;
  /** gRPC target，例如 "localhost:8443" 或 "dns:///linux-mcp-server-node-1:8443" */
  grpcTarget?: string;
  /** 标签，用于后续按标签批量选择主机 */
  labels?: Record<string, string>;
}

export interface HostTransport {
  host: string;
  /** 是否优先使用 linux-mcp-server */
  mcpEnabled: boolean;
  mcpEndpoint?: McpEndpoint;
  /** 无 MCP Agent 时是否允许 fallback 到 SSH */
  sshFallback: boolean;
}

export interface McpCallOptions {
  tool: string;
  args: Record<string, unknown>;
  caller?: string;
  timeoutMs?: number;
}

export interface McpHealthResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface McpClient {
  health(endpoint: McpEndpoint): Promise<McpHealthResult>;
  call(endpoint: McpEndpoint, request: McpCallOptions): Promise<McpResult>;
  listTools(endpoint: McpEndpoint): Promise<ToolDef[]>;
}

/**
 * MCP 调用返回的统一结构，由 Client Router 转换为 ToolExecutionResult。
 */
export interface McpResult {
  success: boolean;
  data?: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
  /** 原始 exit code，仅变更类命令可能非 0 */
  exitCode?: number;
}

/**
 * JWT payload，用于 MCP Server 校验调用范围。
 */
export interface McpJwtPayload {
  /** 会话 ID */
  sub: string;
  /** 受众，固定为 "linux-mcp-server" */
  aud: string;
  /** 允许调用的工具列表 */
  tools: string[];
  /** 过期时间（unix timestamp） */
  exp: number;
  /** 签发时间 */
  iat: number;
}
