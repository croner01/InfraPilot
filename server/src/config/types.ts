// ============================================================================
// Runtime Configuration Types
//
// 支持多类后端数据源：
// - 日志后端（ELK/OpenSearch、ClickHouse、Generic）
// - 指标后端（Prometheus / 兼容 VictoriaMetrics 等 PromQL API）
// - 数据库后端（SQLite / MySQL / PostgreSQL，只读查询）
// 以及远程主机注册表。
// 所有凭据类字段建议通过环境变量名间接引用，避免明文落盘。
// ============================================================================

import type { HostEntry, HostRegistry } from "../gateway/sshHosts.js";

export type LogBackendType = "elk" | "clickhouse" | "generic";

export interface LogBackendBase {
  id: string;
  type: LogBackendType;
  name: string;
  enabled: boolean;
}

export interface ElkBackend extends LogBackendBase {
  type: "elk";
  node: string;
  username?: string;
  /** 密码优先从 passwordEnv 对应的环境变量读取 */
  passwordEnv?: string;
  /** 是否忽略 TLS 证书（仅用于本地/沙箱环境） */
  skipTlsVerify?: boolean;
  /** 按 namespace/podPrefix 维度指定采集目标 */
  targets: Array<{
    namespace: string;
    podNamePrefix: string;
    indexPrefix: string;
  }>;
}

export interface ClickHouseBackend extends LogBackendBase {
  type: "clickhouse";
  host: string;
  port?: number;
  database: string;
  username: string;
  /** 密码优先从 passwordEnv 对应的环境变量读取 */
  passwordEnv?: string;
  /** 日志表名 */
  table: string;
  /** 时间字段名 */
  timestampColumn?: string;
  /** 消息字段名 */
  messageColumn?: string;
}

export interface GenericBackend extends LogBackendBase {
  type: "generic";
  url: string;
  /** 请求头，通常包含 Authorization；敏感头建议通过 headerEnv 间接注入 */
  headers?: Record<string, string>;
  /** 敏感请求头对应的 env var，例如 {"Authorization": "LOG_API_TOKEN"} */
  headerEnv?: Record<string, string>;
  queryTemplate?: string;
}

export type LogBackend = ElkBackend | ClickHouseBackend | GenericBackend;

// -------------------- 指标后端（Prometheus） --------------------

export interface PrometheusBackend {
  id: string;
  type: "prometheus";
  name: string;
  enabled: boolean;
  /** Prometheus API 地址，如 http://prometheus:9090 */
  url: string;
  /** 全局外部标签（如 cloud_name），会附加到指标查询结果的展示中 */
  externalLabels?: Record<string, string>;
  /** 请求头，通常包含 Authorization；敏感头建议通过 headerEnv 间接注入 */
  headers?: Record<string, string>;
  /** 敏感请求头对应的 env var，例如 {"Authorization": "PROM_TOKEN"} */
  headerEnv?: Record<string, string>;
}

// -------------------- 数据库后端（只读查询） --------------------

export type DatabaseDialect = "sqlite" | "mysql" | "postgres";

export interface DatabaseBackend {
  id: string;
  type: "database";
  name: string;
  enabled: boolean;
  dialect: DatabaseDialect;
  /** sqlite: 文件路径；mysql/postgres: 主机名 */
  host: string;
  port?: number;
  /** 数据库名（sqlite 忽略） */
  database?: string;
  username?: string;
  /** 密码优先从 passwordEnv 对应的环境变量读取 */
  passwordEnv?: string;
  /** 是否只读模式（默认 true，仅允许 SELECT/EXPLAIN/SHOW/DESCRIBE） */
  readonly?: boolean;
  /** 最大返回行数，默认 200 */
  maxRows?: number;
}

// -------------------- LLM Providers --------------------

export type LlmProviderType = "openai" | "deepseek" | "qwen" | "glm" | "moonshot" | "minimax" | "baichuan" | "anthropic" | "google" | "generic";

export interface LlmProvider {
  id: string;
  type: LlmProviderType;
  /** 显示名称, 如 "OpenAI" */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否设为默认模型 */
  isDefault?: boolean;
  /** API Base URL, 如 https://api.openai.com/v1 */
  baseURL: string;
  /** API Key 明文, 如 sk-xxx。生产环境建议通过 K8s Secret 挂载并配合加密存储 */
  apiKey?: string;
  /** 兼容旧配置：API Key 所在环境变量名 */
  apiKeyEnv?: string;
  /** 模型系列描述, 如 "GPT-4o / GPT-4 / GPT-3.5 系列" */
  models: string;
  /** 推荐模型, 如 gpt-4o */
  recommendedModel?: string;
}

export interface McpConfig {
  /** MCP gRPC server port, 默认 8443 */
  serverPort?: number;
  /** MCP JWT 签名密钥；生产环境应通过环境变量或 K8s Secret 注入，不建议明文写入配置文件 */
  jwtSecret?: string;
}

export interface MemoryConfig {
  /** 是否启用跨会话记忆召回 */
  enabled: boolean;
  /** 新建会话时召回的历史记忆条数 */
  recallTopK: number;
}

export interface RuntimeConfig {
  logSystems?: LogBackend[];
  metricSystems?: PrometheusBackend[];
  databaseSystems?: DatabaseBackend[];
  hosts?: HostEntry[];
  llmProviders?: LlmProvider[];
  mcp?: McpConfig;
  memory?: MemoryConfig;
}

export type { HostEntry, HostRegistry };
