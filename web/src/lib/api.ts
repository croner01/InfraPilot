// ============================================================================
// API Client — 前端统一封装，带错误提示回调
// ============================================================================

import type { AgentSession, TimelineEvent, Alert, LogEntry, ServiceHealth } from "./types.js";

// 默认走同源 /api，由 vite dev proxy 或 nginx 反代到后端；
// 跨域部署时可显式设置 VITE_API_HOST 覆盖。
const API_HOST = import.meta.env.VITE_API_HOST ?? "";
export const API_BASE = API_HOST ? `${API_HOST}/api` : "/api";
export const WS_BASE = API_HOST ? API_HOST.replace(/^http/, "ws") : "";

export type ApiError = { message: string; status?: number };

export type OnError = (err: ApiError) => void;

// -------------------- 认证 Token（P0：JWT Bearer） --------------------

const TOKEN_KEY = "infrapilot.token";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "on-call" | "viewer";
  disabled?: boolean;
  createdAt?: string;
};

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(path: string, options?: RequestInit, onError?: OnError): Promise<T | undefined> {
  try {
    const token = getAuthToken();
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...((options?.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    if (!res.ok) {
      if (res.status === 401) clearAuthToken();
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

export function login(username: string, password: string, onError?: OnError) {
  return request<{ ok: boolean; token: string; user: AuthUser }>(
    "/auth/login",
    { method: "POST", body: JSON.stringify({ username, password }) },
    onError,
  );
}

export function fetchMe(onError?: OnError) {
  return request<{ user: AuthUser }>("/auth/me", undefined, onError);
}

export function logout(onError?: OnError) {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" }, onError);
}

export type AdminUser = AuthUser & { sessionCount?: number; totalTokens?: number };

export function fetchUsers(onError?: OnError) {
  return request<{ users: AdminUser[] }>("/auth/users", undefined, onError);
}

export function createUser(
  body: { username: string; displayName?: string; role: AdminUser["role"]; password: string },
  onError?: OnError,
) {
  return request<{ ok: boolean; user: AdminUser }>("/auth/users", { method: "POST", body: JSON.stringify(body) }, onError);
}

export function updateUser(
  id: string,
  patch: { displayName?: string; role?: AdminUser["role"]; password?: string; disabled?: boolean },
  onError?: OnError,
) {
  return request<{ ok: boolean; user: AdminUser }>(`/auth/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }, onError);
}

export function deleteUser(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/auth/users/${encodeURIComponent(id)}`, { method: "DELETE" }, onError);
}

// -------------------- 服务拓扑（K8s 聚合） --------------------

export type TopoNodeKind = "ingress" | "service" | "openstack" | "data" | "middleware";
export type TopoNodeStatus = "ok" | "warn" | "err" | "idle";

export type TopoNode = {
  id: string;
  label: string;
  kind: TopoNodeKind;
  ns: string;
  status: TopoNodeStatus;
  replicas?: string;
  labels?: Record<string, string>;
  alert?: string;
};

export type TopoEdge = { from: string; to: string; label?: string; status: TopoNodeStatus };

export type TopologyResponse = { nodes: TopoNode[]; edges: TopoEdge[]; generatedAt?: string };

export function fetchTopology(namespace?: string, onError?: OnError) {
  const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  return request<TopologyResponse>(`/topology${qs}`, undefined, onError);
}

export function listSessions(onError?: OnError) {
  return request<{ id: string; title: string; status: string; created_at: string; updated_at: string }[]>("/sessions", undefined, onError);
}

export function getSession(id: string, onError?: OnError) {
  return request<AgentSession>(`/sessions/${id}`, undefined, onError);
}

export function createSession(title: string, onError?: OnError, subject?: string) {
  return request<AgentSession>(
    "/sessions",
    { method: "POST", body: JSON.stringify(subject ? { title, subject } : { title }) },
    onError,
  );
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

export type CancelSessionResult = {
  ok: boolean;
  /** 是否真的打断了正在执行的轮次 */
  interrupted: boolean;
  /** 会话状态是否被本次调用改变（任务已结束时为 false） */
  changed: boolean;
  session?: AgentSession;
};

/** 中断当前任务：停止进行中的 Agent 轮次并把会话置为已关闭 */
export function cancelSession(id: string, onError?: OnError) {
  return request<CancelSessionResult>(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }, onError);
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

export type AlertSyncResult = {
  ok: boolean;
  created: number;
  updated: number;
  resolved: number;
  firing: number;
  error?: string;
};

/** 把 Prometheus 当前 firing 告警同步进本地表，让告警列表展示真实数据 */
export function syncAlerts(onError?: OnError) {
  return request<AlertSyncResult>('/alerts/sync', { method: 'POST' }, onError);
}

export type ServiceHealthResponse = {
  services: ServiceHealth[];
  source: 'prometheus' | 'none';
  error?: string | null;
  total: number;
};

/** 服务健康总览：真实 Prometheus(kube-state-metrics) 聚合 */
export function fetchServiceHealth(onError?: OnError) {
  return request<ServiceHealthResponse>('/health/services', undefined, onError);
}

export function updateAlert(
  id: string,
  patch: { status?: Alert['status']; sessionId?: string },
  onError?: OnError,
) {
  return request<{ ok: boolean; alert: Alert }>(`/alerts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }, onError);
}

// -------------------- 用量统计 / 成本核算 --------------------

export type UsageModelPrice = { model: string; inputPerM: number; outputPerM: number };

export type UsageTotals = {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
  cost: number;
  avgLatency: number;
};

export type UsageDayPoint = { date: string; prompt: number; completion: number };

export type UsageSessionRow = {
  id: string;
  title: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  latencyP50: number;
};

export type UsageModelRow = { model: string; tokens: number; calls: number };

export type UsageSummary = {
  totals: UsageTotals;
  series: UsageDayPoint[];
  sessions: UsageSessionRow[];
  models: UsageModelRow[];
  prices: UsageModelPrice[];
  range: { days: number };
};

export function fetchUsageSummary(days = 14, sessionLimit = 20, onError?: OnError) {
  return request<UsageSummary>(`/usage/summary?days=${days}&sessionLimit=${sessionLimit}`, undefined, onError);
}

export type SessionUsage = {
  sessionId: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
};

export function fetchSessionUsage(sessionId: string, onError?: OnError) {
  return request<SessionUsage>(`/usage/sessions/${encodeURIComponent(sessionId)}`, undefined, onError);
}

export function fetchModelPrices(onError?: OnError) {
  return request<{ prices: UsageModelPrice[] }>("/config/model-prices", undefined, onError);
}

export function saveModelPrices(prices: UsageModelPrice[], onError?: OnError) {
  return request<{ ok: boolean; prices: UsageModelPrice[] }>("/config/model-prices", {
    method: "PUT",
    body: JSON.stringify({ prices }),
  }, onError);
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

// -------------------- 数据源：远端 K8s 集群 --------------------

/**
 * 远端 K8s 集群登记项。
 *
 * 密钥字段（kubeconfig / token / clientCert / clientKey / caCert）只在保存时上行，
 * 后端读取接口一律脱敏，只回传 has* 标记；编辑时留空表示沿用原值。
 */
export type K8sCluster = {
  id: string;
  name: string;
  server?: string;
  authType: "kubeconfig" | "token" | "clientCert";
  kubeconfig?: string;
  token?: string;
  tokenEnv?: string;
  caCert?: string;
  caCertPath?: string;
  clientCert?: string;
  clientKey?: string;
  insecureSkipTlsVerify?: boolean;
  enabled: boolean;
  isDefault?: boolean;
  hasToken?: boolean;
  hasKubeconfig?: boolean;
  hasClientCert?: boolean;
  hasCaCert?: boolean;
};

export type K8sClustersResponse = {
  clusters: K8sCluster[];
  defaultClusterId?: string | null;
  /** 未登记任何集群时为 true：Agent 走进程内 kubeconfig（本地集群） */
  localFallback?: boolean;
};

export function fetchK8sClusters(onError?: OnError) {
  return request<K8sClustersResponse>("/config/k8s-clusters", undefined, onError);
}

export function upsertK8sCluster(cluster: K8sCluster, onError?: OnError) {
  return request<K8sClustersResponse & { ok: boolean }>("/config/k8s-clusters", { method: "POST", body: JSON.stringify(cluster) }, onError);
}

export function deleteK8sCluster(id: string, onError?: OnError) {
  return request<K8sClustersResponse & { ok: boolean }>(`/config/k8s-clusters/${encodeURIComponent(id)}`, { method: "DELETE" }, onError);
}

export function testK8sCluster(id: string, onError?: OnError) {
  return request<{ ok: boolean; reachable: boolean; serverVersion?: string; nodeCount?: number; error?: string }>(
    `/config/k8s-clusters/${encodeURIComponent(id)}/test`,
    { method: "POST" },
    onError,
  );
}

// -------------------- 数据源：Prometheus 指标后端 --------------------

export type PrometheusBackend = {
  id: string;
  type: "prometheus";
  name: string;
  enabled: boolean;
  url: string;
  externalLabels?: Record<string, string>;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
};

/**
 * 数据库方言：mariadb 与 MySQL 协议完全兼容（mysql2 驱动原生支持）。
 * clickhouse / elasticsearch 为规划类型：后端驱动接入前，UI 允许配置但连接测试与
 * SQL 查询将返回"驱动待接入"提示。
 */
export type DatabaseDialect = "sqlite" | "mysql" | "mariadb" | "clickhouse" | "elasticsearch" | "postgres";

export type DatabaseBackend = {
  id: string;
  type: "database";
  name: string;
  enabled: boolean;
  dialect: DatabaseDialect;
  host: string;
  port?: number;
  database?: string;
  username?: string;
  passwordEnv?: string;
  readonly?: boolean;
  maxRows?: number;
};

export type PromSeries = { name: string; points: [number, number][] };

export type PromQueryResponse = {
  ok: boolean;
  error?: string;
  result?: { resultType: string };
  series?: PromSeries[];
};

export type PromTableResponse = {
  ok: boolean;
  error?: string;
  result?: {
    resultType: string;
    samples: Array<{ metric: Record<string, string>; value?: [number, string] }>;
  };
};

export type DbQueryResponse = {
  ok: boolean;
  error?: string;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  total?: number;
  truncated?: boolean;
  reachable?: boolean;
};

export function fetchMetricSystems(onError?: OnError) {
  return request<{ systems: PrometheusBackend[] }>("/config/metric-systems", undefined, onError);
}

export function upsertMetricSystem(system: PrometheusBackend, onError?: OnError) {
  return request<{ ok: boolean; systems: PrometheusBackend[] }>("/config/metric-systems", { method: "POST", body: JSON.stringify(system) }, onError);
}

export function deleteMetricSystem(id: string, onError?: OnError) {
  return request<{ ok: boolean; systems: PrometheusBackend[] }>(`/config/metric-systems/${id}`, { method: "DELETE" }, onError);
}

export function testMetricSystem(id: string, onError?: OnError) {
  return request<{ ok: boolean; reachable: boolean; version?: string; error?: string }>(`/config/metric-systems/${id}/test`, { method: "POST" }, onError);
}

export function fetchDatabaseSystems(onError?: OnError) {
  return request<{ systems: DatabaseBackend[] }>("/config/database-systems", undefined, onError);
}

export function upsertDatabaseSystem(system: DatabaseBackend, onError?: OnError) {
  return request<{ ok: boolean; systems: DatabaseBackend[] }>("/config/database-systems", { method: "POST", body: JSON.stringify(system) }, onError);
}

export function deleteDatabaseSystem(id: string, onError?: OnError) {
  return request<{ ok: boolean; systems: DatabaseBackend[] }>(`/config/database-systems/${id}`, { method: "DELETE" }, onError);
}

export function testDatabaseSystem(id: string, onError?: OnError) {
  return request<{ ok: boolean; reachable: boolean; error?: string }>(`/config/database-systems/${id}/test`, { method: "POST" }, onError);
}

export function promInstantQuery(id: string, query: string, onError?: OnError) {
  return request<PromTableResponse>(`/data-sources/prom/${id}/query`, { method: "POST", body: JSON.stringify({ query }) }, onError);
}

export function promRangeQuery(id: string, query: string, opts?: { start?: string; end?: string; step?: string }, onError?: OnError) {
  return request<PromQueryResponse>(`/data-sources/prom/${id}/query-range`, { method: "POST", body: JSON.stringify({ query, ...opts }) }, onError);
}

export function promLabelValues(id: string, label: string, onError?: OnError) {
  return request<{ ok: boolean; values: string[]; error?: string }>(`/data-sources/prom/${id}/labels/${encodeURIComponent(label)}`, undefined, onError);
}

export function dbQuery(id: string, sql: string, onError?: OnError) {
  return request<DbQueryResponse>(`/data-sources/db/${id}/query`, { method: "POST", body: JSON.stringify({ sql }) }, onError);
}

// -------------------- 数据源工作台：日志检索 --------------------

export type ElkSearchRow = {
  timestamp?: string;
  "@timestamp"?: string;
  level?: string;
  message?: string;
  service?: string;
  namespace?: string;
  [key: string]: unknown;
};

export function elkSearch(params: {
  namespace?: string;
  index_prefix?: string;
  level?: string;
  keyword?: string;
  limit?: number;
  since?: string;
}, onError?: OnError) {
  return request<{ ok: boolean; error?: string; data?: { total?: number; logs?: ElkSearchRow[]; records?: ElkSearchRow[] } }>(
    "/elk/search",
    { method: "POST", body: JSON.stringify(params) },
    onError,
  );
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

// -------------------- Skill Factory：从诊断会话沉淀技能 --------------------

export type FactorySession = {
  id: string;
  title: string;
  concluded?: { summary?: string } | null;
  planSteps?: number;
  tools?: string[];
  status?: string;
};

export type FactoryDraft = {
  name: string;
  content: string;
  path?: string;
  sessionId?: string;
  source?: string;
};

export function listFactorySessions(onError?: OnError) {
  return request<{ sessions: FactorySession[] }>("/skills/factory/sessions", undefined, onError);
}

export function generateFactoryDraft(sessionId: string, onError?: OnError) {
  return request<{ ok: boolean } & FactoryDraft>(
    "/skills/factory/generate",
    { method: "POST", body: JSON.stringify({ sessionId }) },
    onError,
  );
}

export function listFactoryPending(onError?: OnError) {
  return request<{ drafts: FactoryDraft[] }>("/skills/factory/pending", undefined, onError);
}

export function approveFactoryDraft(name: string, content: string, onError?: OnError) {
  return request<{ ok: boolean; name: string }>(
    "/skills/factory/approve",
    { method: "POST", body: JSON.stringify({ name, content }) },
    onError,
  );
}

export function rejectFactoryDraft(name: string, onError?: OnError) {
  return request<{ ok: boolean }>(
    "/skills/factory/reject",
    { method: "POST", body: JSON.stringify({ name }) },
    onError,
  );
}

// -------------------- 会话产物（Artifacts，P3） --------------------

export type Artifact = {
  id: string;
  sessionId?: string | null;
  name: string;
  path: string;
  mime: string;
  size: number;
  kind?: string | null;
  sha256?: string | null;
  createdAt: string;
  downloadUrl: string;
};

export function listArtifacts(sessionId?: string, onError?: OnError) {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<{ artifacts: Artifact[]; count: number }>(`/artifacts${qs}`, undefined, onError);
}

export function deleteArtifact(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" }, onError);
}

export function artifactDownloadUrl(id: string): string {
  return `${API_BASE}/artifacts/${encodeURIComponent(id)}/download`;
}

// -------------------- Trace 数据源（Jaeger / Tempo，P2） --------------------

export type TraceBackend = {
  id: string;
  type: "jaeger" | "tempo" | string;
  name: string;
  url: string;
  enabled: boolean;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
};

export function fetchTraceSystems(onError?: OnError) {
  return request<{ systems: TraceBackend[] }>("/config/trace-systems", undefined, onError);
}

export function upsertTraceSystem(system: TraceBackend, onError?: OnError) {
  return request<{ ok: boolean; systems: TraceBackend[] }>("/config/trace-systems", {
    method: "POST",
    body: JSON.stringify(system),
  }, onError);
}

export function deleteTraceSystem(id: string, onError?: OnError) {
  return request<{ ok: boolean; systems: TraceBackend[] }>(
    `/config/trace-systems/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    onError,
  );
}

export function testTraceSystem(id: string, onError?: OnError) {
  return request<{ ok?: boolean; reachable?: boolean; services?: string[]; count?: number; error?: string }>(
    `/config/trace-systems/${encodeURIComponent(id)}/test`,
    { method: "POST" },
    onError,
  );
}

// -------------------- 定时任务（Schedules，P2） --------------------

export type Schedule = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  skills: string[];
  userId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  runCount?: number;
  lastSessionId?: string | null;
  lastError?: string | null;
};

export type SchedulerStatus = {
  running: boolean;
  tickSeconds: number;
  count: number;
  enabledCount?: number;
  nextRunAt?: string | null;
};

export function listSchedules(onError?: OnError) {
  return request<{ schedules: Schedule[] }>("/schedules", undefined, onError);
}

export function fetchSchedulerStatus(onError?: OnError) {
  return request<SchedulerStatus>("/schedules/status", undefined, onError);
}

export function validateCron(cron: string, onError?: OnError) {
  return request<{ ok: boolean; nextRun: string }>("/schedules/validate", {
    method: "POST",
    body: JSON.stringify({ cron }),
  }, onError);
}

export function createSchedule(
  body: { name?: string; cron: string; prompt: string; enabled?: boolean; skills?: string[] },
  onError?: OnError,
) {
  return request<{ ok: boolean; schedule: Schedule }>("/schedules", {
    method: "POST",
    body: JSON.stringify(body),
  }, onError);
}

export function updateSchedule(
  id: string,
  body: Partial<Pick<Schedule, "name" | "cron" | "prompt" | "enabled" | "skills">>,
  onError?: OnError,
) {
  return request<{ ok: boolean; schedule: Schedule }>(`/schedules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }, onError);
}

export function deleteSchedule(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }, onError);
}

export function runSchedule(id: string, onError?: OnError) {
  return request<{ ok: boolean; sessionId?: string; schedule?: Schedule; error?: string | null }>(
    `/schedules/${encodeURIComponent(id)}/run`,
    { method: "POST" },
    onError,
  );
}

// -------------------- 评测与回流（Eval + LLM-as-judge，P2） --------------------

export type EvalCase = {
  id: string;
  case: { id?: string; name?: string; message?: string; expected?: string; [key: string]: unknown };
  source_session_id?: string | null;
  origin: string;
  created_at: string;
  updated_at: string;
};

export type JudgementResult = {
  ok: boolean;
  sessionId: string;
  status: string;
  score: number;
  verdict: "pass" | "fail";
  rationale: string;
  strengths?: string[];
  weaknesses?: string[];
  hallucination_risk?: number;
  mode?: string;
  error?: string;
};

export type EvalRun = {
  id: string;
  case_id: string;
  session_id?: string | null;
  passed: boolean;
  score: number;
  detail_json?: string | null;
  created_at: string;
};

export function listEvalCases(onError?: OnError) {
  return request<{ cases: EvalCase[]; count: number; casesDir: string }>("/eval/cases", undefined, onError);
}

export function deleteEvalCase(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/eval/cases/${encodeURIComponent(id)}`, { method: "DELETE" }, onError);
}

export function judgeSession(
  body: { sessionId: string; expected?: string; allowLlm?: boolean },
  onError?: OnError,
) {
  return request<JudgementResult>("/eval/judge", {
    method: "POST",
    body: JSON.stringify(body),
  }, onError);
}

export function promoteSession(
  body: { sessionId: string; id?: string; expected?: string },
  onError?: OnError,
) {
  return request<{ ok: boolean; case: EvalCase }>("/eval/promote", {
    method: "POST",
    body: JSON.stringify(body),
  }, onError);
}

export function listEvalRuns(caseId?: string, limit = 50, onError?: OnError) {
  const params = new URLSearchParams();
  if (caseId) params.set("caseId", caseId);
  params.set("limit", String(limit));
  return request<{ runs: EvalRun[]; count: number }>(`/eval/runs?${params.toString()}`, undefined, onError);
}

// -------------------- 会话级免审批白名单 --------------------

export type SessionAllowEntry = {
  skill: string;
  tool: string;
  createdAt: string;
  createdBy?: string | null;
};

export function fetchSessionAllowlist(sessionId: string, onError?: OnError) {
  return request<{ allowlist: SessionAllowEntry[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/allowlist`,
    undefined,
    onError,
  );
}

export function addSessionAllowlist(sessionId: string, skill: string, tool: string, onError?: OnError) {
  return request<{ ok: boolean; allowlist: SessionAllowEntry[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/allowlist`,
    { method: "POST", body: JSON.stringify({ skill, tool }) },
    onError,
  );
}

export function removeSessionAllowlist(sessionId: string, skill: string, tool: string, onError?: OnError) {
  return request<{ ok: boolean; allowlist: SessionAllowEntry[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/allowlist/${encodeURIComponent(skill)}/${encodeURIComponent(tool)}`,
    { method: "DELETE" },
    onError,
  );
}

// -------------------- 知识库单条详情 --------------------

export function fetchKnowledgeCase(id: string, onError?: OnError) {
  return request<KnowledgeCase>(`/knowledge/cases/${encodeURIComponent(id)}`, undefined, onError);
}

export function deleteKnowledgeCase(id: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/knowledge/cases/${encodeURIComponent(id)}`, { method: "DELETE" }, onError);
}

// -------------------- LLM 调用明细（逐次用量） --------------------

export type LlmCall = {
  id: string;
  session_id?: string | null;
  provider_id?: string | null;
  model: string;
  call_type: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  cost: number;
  created_at: string;
};

export function fetchUsageCalls(sessionId?: string, limit = 100, onError?: OnError) {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  params.set("limit", String(limit));
  return request<{ calls: LlmCall[] }>(`/usage/calls?${params.toString()}`, undefined, onError);
}
