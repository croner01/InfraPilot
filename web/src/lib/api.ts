// ============================================================================
// API Client — 前端统一封装，带错误提示回调
// ============================================================================

import type { AgentSession, TimelineEvent, Alert, LogEntry } from "./types.js";

// 默认走同源 /api，由 vite dev proxy 或 nginx 反代到后端；
// 跨域部署时可显式设置 VITE_API_HOST 覆盖。
const API_HOST = import.meta.env.VITE_API_HOST ?? "";
export const API_BASE = API_HOST ? `${API_HOST}/api` : "/api";
export const WS_BASE = API_HOST ? API_HOST.replace(/^http/, "ws") : "";

export type ApiError = { message: string; status?: number };

export type OnError = (err: ApiError) => void;

async function request<T>(path: string, options?: RequestInit, onError?: OnError): Promise<T | undefined> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "请求失败");
      const err: ApiError = { message: `${res.status}: ${text}`, status: res.status };
      onError?.(err);
      return undefined;
    }
    return (await res.json()) as T;
  } catch (e: any) {
    const err: ApiError = { message: e?.message ?? "网络错误" };
    onError?.(err);
    return undefined;
  }
}

export function listSessions(onError?: OnError) {
  return request<{ id: string; title: string; status: string; created_at: string; updated_at: string }[]>("/sessions", undefined, onError);
}

export function getSession(id: string, onError?: OnError) {
  return request<AgentSession>(`/sessions/${id}`, undefined, onError);
}

export function createSession(title: string, onError?: OnError) {
  return request<AgentSession>("/sessions", { method: "POST", body: JSON.stringify({ title }) }, onError);
}

export function deleteSession(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" }, onError);
}

export function updateSessionTitle(id: string, title: string, onError?: OnError) {
  return request<{ ok: boolean; session: AgentSession }>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }, onError);
}

export function sendMessage(id: string, message: string, onError?: OnError) {
  return request<{ accepted: boolean }>(`/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ message }) }, onError);
}

export function decideApproval(approvalId: string, approved: boolean, approvedBy: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ approved, approvedBy }) }, onError);
}

export function fetchSessionAudit(id: string, onError?: OnError) {
  return request<any[]>(`/sessions/${id}/audit`, undefined, onError);
}

export function fetchSessionEvents(id: string, onError?: OnError) {
  return request<TimelineEvent[]>(`/sessions/${id}/events`, undefined, onError);
}

export function fetchAlerts(onError?: OnError) {
  return request<{ alerts: Alert[] }>('/alerts', undefined, onError);
}

export function fetchObjectLogs(
  namespace: string,
  name: string,
  options?: { since?: string; limit?: number },
  onError?: OnError,
) {
  const qs = new URLSearchParams();
  if (options?.since) qs.set('since', options.since);
  if (options?.limit) qs.set('limit', String(options.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ logs: LogEntry[] }>(`/objects/${namespace}/${name}/logs${suffix}`, undefined, onError);
}

export function fetchPodState(onError?: OnError) {
  return request<any>("/demo/pod-state", undefined, onError);
}

export function resetDemoScenario(onError?: OnError) {
  return request<{ ok: boolean }>("/demo/restart-scenario", { method: "POST" }, onError);
}

export type PodEvent = {
  time: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
};

export type PodResource = { limits?: Record<string, string>; requests?: Record<string, string> };

export type PodInfo = {
  name: string;
  namespace: string;
  status: string;
  restartCount: number;
  ready: boolean;
  podIp?: string;
  nodeName?: string;
  startedAt?: string;
  lastState?: { reason: string; exitCode: number; finishedAt: string; startedAt?: string };
  resources?: PodResource;
  containerName?: string;
  uid?: string;
  ownerDeployment?: string;
};

export function listPods(namespace?: string, abnormalOnly?: boolean, onError?: OnError) {
  const qs = new URLSearchParams();
  if (namespace) qs.set("namespace", namespace);
  if (abnormalOnly) qs.set("abnormalOnly", "true");
  return request<{ pods: PodInfo[] }>(`/k8s/pods?${qs.toString()}`, undefined, onError);
}

export function getPodDetail(namespace: string, name: string, onError?: OnError) {
  return request<{ pod: PodInfo; events: PodEvent[] }>(`/k8s/pods/${namespace}/${name}`, undefined, onError);
}

export type LogBackend = ElkBackend | ClickHouseBackend | GenericBackend;

export type LogTarget = { namespace: string; podNamePrefix: string; indexPrefix: string };

export type LogBackendType = "elk" | "clickhouse" | "generic";

export type ShipTargetStatus = {
  target: LogTarget;
  fileCount: number;
  lastScannedAt?: string;
  lastShippedAt?: string;
  lastShippedCount: number;
  totalShipped: number;
  lastError?: string;
  lastErrorAt?: string;
  warning?: string;
};

export type LogBackendBase = { id: string; type: LogBackendType; name: string; enabled: boolean };

export type ElkBackend = LogBackendBase & {
  type: "elk";
  node: string;
  username?: string;
  passwordEnv?: string;
  skipTlsVerify?: boolean;
  targets: LogTarget[];
};

export type ClickHouseBackend = LogBackendBase & {
  type: "clickhouse";
  host: string;
  port?: number;
  database: string;
  username: string;
  passwordEnv?: string;
  table: string;
  timestampColumn?: string;
  messageColumn?: string;
};

export type GenericBackend = LogBackendBase & {
  type: "generic";
  url: string;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  queryTemplate?: string;
};

export type LlmProviderType =
  | "openai"
  | "deepseek"
  | "qwen"
  | "glm"
  | "moonshot"
  | "minimax"
  | "baichuan"
  | "anthropic"
  | "google"
  | "generic";

export type LlmProvider = {
  id: string;
  type: LlmProviderType;
  name: string;
  enabled: boolean;
  isDefault?: boolean;
  baseURL: string;
  /** API Key 明文；生产环境建议由后端加密存储 */
  apiKey?: string;
  /** 兼容旧配置 */
  apiKeyEnv?: string;
  models: string;
  recommendedModel?: string;
};

export type McpConfig = {
  serverPort: number;
  jwtSecret: string;
};

export function fetchMcpConfig(onError?: OnError) {
  return request<McpConfig>("/config/mcp", undefined, onError);
}

export function updateMcpConfig(config: Partial<McpConfig>, onError?: OnError) {
  return request<{ ok: boolean }>("/config/mcp", { method: "PUT", body: JSON.stringify(config) }, onError);
}

export function generateMcpSecret(onError?: OnError) {
  return request<{ secret: string }>("/config/mcp/generate-secret", { method: "POST" }, onError);
}

export type MemoryConfig = {
  enabled: boolean;
  recallTopK: number;
};

export type MemoryEntry = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
};

export function fetchMemoryConfig(onError?: OnError) {
  return request<MemoryConfig>("/config/memory", undefined, onError);
}

export function updateMemoryConfig(config: Partial<MemoryConfig>, onError?: OnError) {
  return request<{ ok: boolean } & MemoryConfig>("/config/memory", { method: "PUT", body: JSON.stringify(config) }, onError);
}

export function listMemories(onError?: OnError) {
  return request<{ memories: MemoryEntry[] }>("/memories", undefined, onError);
}

export function deleteMemory(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/memories/${id}`, { method: "DELETE" }, onError);
}

export function fetchLogSystems(onError?: OnError) {
  return request<{ systems: LogBackend[] }>("/config/log-systems", undefined, onError);
}

export function updateLogSystems(systems: LogBackend[], onError?: OnError) {
  return request<{ systems: LogBackend[] }>("/config/log-systems", { method: "PUT", body: JSON.stringify({ systems }) }, onError);
}

export function upsertLogSystem(system: LogBackend, onError?: OnError) {
  return request<{ systems: LogBackend[] }>("/config/log-systems", { method: "POST", body: JSON.stringify(system) }, onError);
}

export function deleteLogSystem(id: string, onError?: OnError) {
  return request<{ systems: LogBackend[] }>(`/config/log-systems/${id}`, { method: "DELETE" }, onError);
}

export function testLogSystem(id: string, onError?: OnError) {
  return request<{ ok: boolean; reachable: boolean; error?: string }>(`/config/log-systems/${id}/test`, { method: "POST" }, onError);
}

export function fetchShipStatus(id: string, onError?: OnError) {
  return request<{ ok: boolean; statuses: ShipTargetStatus[] }>(`/config/log-systems/${id}/ship-status`, undefined, onError);
}

export function fetchLlmProviders(onError?: OnError) {
  return request<{ providers: LlmProvider[] }>("/config/llm-providers", undefined, onError);
}

export function upsertLlmProvider(provider: LlmProvider, onError?: OnError) {
  return request<{ ok: boolean; providers: LlmProvider[] }>("/config/llm-providers", { method: "POST", body: JSON.stringify(provider) }, onError);
}

export function deleteLlmProvider(id: string, onError?: OnError) {
  return request<{ ok: boolean; providers: LlmProvider[] }>(`/config/llm-providers/${id}`, { method: "DELETE" }, onError);
}

export function setDefaultLlmProvider(id: string, onError?: OnError) {
  return request<{ ok: boolean; providers: LlmProvider[] }>(`/config/llm-providers/${id}/default`, { method: "POST" }, onError);
}

export function testLlmProvider(id: string, onError?: OnError) {
  return request<{ ok: boolean; reachable: boolean; error?: string }>(`/config/llm-providers/${id}/test`, { method: "POST" }, onError);
}

export type HostAuth =
  | { type: "password"; password?: string; passwordEnv?: string }
  | { type: "privateKey"; privateKey?: string; privateKeyPath?: string; privateKeyEnv?: string; passphrase?: string; passphraseEnv?: string }
  | { type: "agent" }
  | { type: "mcp"; endpoint?: string };

export type HostEntry = {
  name: string;
  hostname: string;
  port?: number;
  username: string;
  auth: HostAuth;
  labels?: Record<string, string>;
  tags?: string[];
};

export function fetchHosts(onError?: OnError) {
  return request<{ hosts: HostEntry[] }>("/config/hosts", undefined, onError);
}

export function saveHost(entry: HostEntry, onError?: OnError) {
  return request<{ ok: boolean; hosts: HostEntry[] }>("/config/hosts", { method: "POST", body: JSON.stringify(entry) }, onError);
}

export function deleteHost(name: string, onError?: OnError) {
  return request<{ ok: boolean; hosts: HostEntry[] }>(`/config/hosts/${name}`, { method: "DELETE" }, onError);
}

export function testHost(name: string, onError?: OnError) {
  return request<{ ok: boolean; reachable: boolean; error?: string }>(`/config/hosts/${name}/test`, { method: "POST" }, onError);
}

export type KnowledgeCase = {
  id: string;
  title: string;
  problemType: string;
  severity: "p0" | "p1" | "p2" | "p3";
  summary: string;
  rootCauses: string[];
  solutions: string[];
  serviceName?: string;
  tags?: string[];
  sourceSessionId?: string;
  createdAt: string;
  resolved: boolean;
};

export function listKnowledgeCases(onError?: OnError) {
  return request<{ cases: KnowledgeCase[] }>("/knowledge/cases", undefined, onError);
}

export function searchKnowledgeCases(query: string, onError?: OnError) {
  return request<{ results: Array<KnowledgeCase & { score: number }> }>(`/knowledge/search?query=${encodeURIComponent(query)}`, undefined, onError);
}

export function addKnowledgeCase(body: Omit<KnowledgeCase, "id" | "createdAt" | "resolved">, onError?: OnError) {
  return request<{ ok: boolean; case: KnowledgeCase }>("/knowledge/cases", { method: "POST", body: JSON.stringify(body) }, onError);
}

export function wsUrl(sessionId: string) {
  return `${WS_BASE}/ws?sessionId=${sessionId}`;
}

export type LogRelation = { source: string; target: string; relation: string };

export type DrawioGenerateResult = {
  ok: boolean;
  xml: string;
  output_path: string;
  node_count: number;
  edge_count: number;
};

export type DrawioExportResult = {
  ok: boolean;
  output_path: string;
  format: "png" | "svg" | "pdf";
  data: string;
};

export function generateDrawioFlowchart(logRelations: LogRelation[], title?: string, onError?: OnError) {
  return request<DrawioGenerateResult>("/skills/drawio/generate", {
    method: "POST",
    body: JSON.stringify({ log_relations: logRelations, title }),
  }, onError);
}

export function exportDrawioDiagram(inputPath: string, format: "png" | "svg" | "pdf", onError?: OnError) {
  return request<DrawioExportResult>("/skills/drawio/export", {
    method: "POST",
    body: JSON.stringify({ input_path: inputPath, format }),
  }, onError);
}

export function downloadDrawioUrl(path: string) {
  return `${API_BASE}/skills/drawio/download?path=${encodeURIComponent(path)}`;
}

export interface SkillPackageInfo {
  name: string;
  description: string;
  enabled: boolean;
  references: string[];
  scripts: string[];
  assets: string[];
  source?: string;
  version?: string;
}

export interface CuratedSkill {
  name: string;
  repo: string;
  path: string;
  description: string;
}

export function listSkills(onError?: OnError) {
  return request<{ skills: SkillPackageInfo[] }>("/skills", undefined, onError);
}

export function listCuratedSkills(onError?: OnError) {
  return request<{ skills: CuratedSkill[] }>("/skills/curated", undefined, onError);
}

export function installSkill(
  body: { repo: string; path: string; ref?: string; token?: string },
  onError?: OnError
) {
  return request<{ ok: boolean; name: string }>("/skills/install", {
    method: "POST",
    body: JSON.stringify(body),
  }, onError);
}

export function setSkillEnabled(name: string, enabled: boolean, onError?: OnError) {
  return request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }, onError);
}

export function uninstallSkill(name: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }, onError);
}
