// ============================================================================
// Runtime Configuration Store
//
// 为前端配置面板提供持久化能力：远程主机、日志系统（ELK/ClickHouse/Generic）
// 等配置可在运行时通过 API 读写，并落盘到 data/runtime-config.json。
// 生产环境仍优先从环境变量或 K8s Secret/ConfigMap 注入；本模块作为 demo/本地开发补充。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import type { ElkBackend, HostEntry, HostRegistry, LogBackend, LlmProvider, McpConfig, MemoryConfig, RuntimeConfig } from "./types.js";

// 与 db.ts 保持一致：测试环境通过 INFRAPILOT_DATA_DIR 隔离运行时配置
const DATA_DIR = process.env.INFRAPILOT_DATA_DIR
  ? path.resolve(process.env.INFRAPILOT_DATA_DIR)
  : path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "runtime-config.json");

function load(): RuntimeConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as RuntimeConfig;
    }
  } catch {
    // ignore
  }
  return {};
}

function save(config: RuntimeConfig) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// -------------------- Log Systems --------------------

function defaultElkBackend(): ElkBackend {
  return {
    id: "default-elk",
    type: "elk",
    name: "默认 OpenSearch",
    enabled: true,
    node: process.env.OPENSEARCH_NODE ?? "http://127.0.0.1:9200",
    targets: process.env.LOG_SHIP_TARGETS ? JSON.parse(process.env.LOG_SHIP_TARGETS) : [
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
    ],
  };
}

export function getLogSystems(): LogBackend[] {
  const runtime = load().logSystems;
  if (runtime && runtime.length > 0) {
    return runtime;
  }
  // 兼容旧版环境变量，自动迁移为 default-elk
  return [defaultElkBackend()];
}

export function getEnabledLogSystems(): LogBackend[] {
  return getLogSystems().filter((b) => b.enabled);
}

export function getDefaultElkBackend(): ElkBackend | undefined {
  return getLogSystems().find((b): b is ElkBackend => b.type === "elk" && b.enabled) ??
    getLogSystems().find((b): b is ElkBackend => b.type === "elk");
}

export function setLogSystems(systems: LogBackend[]) {
  const current = load();
  current.logSystems = systems;
  save(current);
  syncElkEnv(systems);
}

export function upsertLogSystem(backend: LogBackend) {
  const current = load();
  const systems = (current.logSystems ?? []).filter((b) => b.id !== backend.id);
  systems.push(backend);
  current.logSystems = systems;
  save(current);
  syncElkEnv(systems);
}

export function deleteLogSystem(id: string) {
  const current = load();
  const systems = (current.logSystems ?? []).filter((b) => b.id !== id);
  current.logSystems = systems;
  save(current);
  syncElkEnv(systems);
}

function syncElkEnv(systems: LogBackend[]) {
  const elk = systems.find((b): b is ElkBackend => b.type === "elk");
  if (elk) {
    process.env.OPENSEARCH_NODE = elk.node;
    process.env.LOG_SHIP_TARGETS = JSON.stringify(elk.targets);
  }
}

// -------------------- Remote Hosts --------------------

export function getHostRegistry(): HostRegistry {
  const runtimeHosts = load().hosts;
  if (runtimeHosts && runtimeHosts.length > 0) {
    return { hosts: runtimeHosts };
  }
  const envHosts = process.env.SSH_HOSTS;
  if (envHosts) {
    return JSON.parse(envHosts) as HostRegistry;
  }
  return { hosts: [] };
}

export function setHosts(hosts: HostEntry[]) {
  const current = load();
  current.hosts = hosts;
  process.env.SSH_HOSTS = JSON.stringify({ hosts });
  save(current);
}

// 启动时调用：将 runtime-config.json 中的主机同步到 SSH_HOSTS，确保 sshProxy 能读取
export function syncRuntimeHostsToEnv() {
  const hosts = load().hosts;
  if (hosts && hosts.length > 0) {
    process.env.SSH_HOSTS = JSON.stringify({ hosts });
  }
}

// 兼容旧版 elk 字段读取
export function getLegacyElkConfig(): { node: string; targets: ElkBackend["targets"] } {
  const elk = getDefaultElkBackend();
  if (elk) return { node: elk.node, targets: elk.targets };
  return defaultElkBackend();
}

// -------------------- LLM Providers --------------------

function defaultLlmProviders(): LlmProvider[] {
  return [
    {
      id: "openai",
      type: "openai",
      name: "OpenAI",
      enabled: false,
      baseURL: "https://api.openai.com/v1",
      models: "GPT-4o / GPT-4 / GPT-3.5 系列",
      recommendedModel: "gpt-4o",
    },
    {
      id: "deepseek",
      type: "deepseek",
      name: "DeepSeek",
      enabled: true,
      isDefault: true,
      baseURL: "https://www.genspark.ai/api/llm_proxy/v1",
      models: "DeepSeek V4, 支持 deepseek-v4-flash / deepseek-v4-pro, 1M 上下文",
      recommendedModel: "deepseek-v4-flash",
    },
  ];
}

export function getLlmProviders(): LlmProvider[] {
  const runtime = load().llmProviders;
  if (runtime && runtime.length > 0) {
    return runtime;
  }
  return defaultLlmProviders();
}

export function getDefaultLlmProvider(): LlmProvider | undefined {
  return getLlmProviders().find((p) => p.enabled && p.isDefault) ?? getLlmProviders().find((p) => p.enabled);
}

export function setLlmProviders(providers: LlmProvider[]) {
  const current = load();
  current.llmProviders = providers;
  save(current);
  syncLlmEnv(providers);
}

export function upsertLlmProvider(provider: LlmProvider) {
  const current = load();
  const providers = (current.llmProviders ?? []).filter((p) => p.id !== provider.id);
  providers.push(provider);
  current.llmProviders = providers;
  save(current);
  syncLlmEnv(providers);
}

export function deleteLlmProvider(id: string) {
  const current = load();
  const providers = (current.llmProviders ?? []).filter((p) => p.id !== id);
  current.llmProviders = providers;
  save(current);
  syncLlmEnv(providers);
}

export function setDefaultLlmProvider(id: string) {
  const providers = getLlmProviders().map((p) => ({ ...p, isDefault: p.id === id }));
  setLlmProviders(providers);
}

function syncLlmEnv(providers: LlmProvider[]) {
  const defaultProvider = providers.find((p) => p.enabled && p.isDefault) ?? providers.find((p) => p.enabled);
  if (defaultProvider) {
    process.env.OPENAI_BASE_URL = defaultProvider.baseURL;
    process.env.REASONING_MODEL = defaultProvider.recommendedModel ?? "deepseek-v4-pro";
    process.env.FAST_MODEL = defaultProvider.recommendedModel ?? "deepseek-v4-flash";
    const apiKey = defaultProvider.apiKey ?? process.env[defaultProvider.apiKeyEnv ?? ""];
    if (apiKey) {
      process.env.OPENAI_API_KEY = apiKey;
    }
  }
}

// -------------------- MCP Configuration --------------------

const DEFAULT_MCP_PORT = 8443;

export function getMcpConfig(): McpConfig {
  const runtime = load().mcp ?? {};
  return {
    serverPort: runtime.serverPort ?? Number(process.env.MCP_SERVER_PORT ?? DEFAULT_MCP_PORT),
    jwtSecret: process.env.MCP_JWT_SECRET ?? runtime.jwtSecret ?? "",
  };
}

export function setMcpConfig(config: McpConfig) {
  const current = load();
  current.mcp = config;
  save(current);
  syncMcpEnv(config);
}

export function syncMcpEnv(config?: McpConfig) {
  const mcp = config ?? getMcpConfig();
  if (mcp.serverPort) {
    process.env.MCP_SERVER_PORT = String(mcp.serverPort);
  }
  if (mcp.jwtSecret) {
    process.env.MCP_JWT_SECRET = mcp.jwtSecret;
  }
}

/** 生成至少 32 字节的随机 JWT Secret */
export function generateMcpJwtSecret(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let secret = "";
  for (let i = 0; i < 48; i++) {
    secret += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return secret;
}

// -------------------- Memory Configuration --------------------

const DEFAULT_MEMORY_CONFIG: MemoryConfig = { enabled: true, recallTopK: 3 };

export function getMemoryConfig(): MemoryConfig {
  return load().memory ?? DEFAULT_MEMORY_CONFIG;
}

export function setMemoryConfig(cfg: MemoryConfig) {
  const current = load();
  current.memory = {
    enabled: cfg.enabled ?? DEFAULT_MEMORY_CONFIG.enabled,
    recallTopK: Number(cfg.recallTopK) || DEFAULT_MEMORY_CONFIG.recallTopK,
  };
  save(current);
}
