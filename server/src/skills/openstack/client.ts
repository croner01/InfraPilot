// ============================================================================
// OpenStack Client
//
// 直接调用 OpenStack REST API（Keystone v3 token auth + Nova/Neutron/Placement）。
// Node.js 生态没有成熟官方 OpenStack SDK，因此使用内置 fetch 实现。
// 凭据通过 OS_* 环境变量注入，符合项目“凭据不走前端输入”的安全约定。
// ============================================================================

import type { ToolExecutionResult } from "../../types.js";

export interface OpenStackConfig {
  authUrl: string;
  username: string;
  password: string;
  projectName: string;
  projectDomainId: string;
  userDomainId: string;
  regionName?: string;
}

interface ServiceCatalog {
  type: string;
  name: string;
  endpoints: Array<{
    interface: string;
    region: string;
    url: string;
  }>;
}

interface AuthCache {
  token: string;
  expiresAt: number;
  catalog: ServiceCatalog[];
}

interface AuthTokenResponse {
  token: {
    expires_at: string;
    catalog: ServiceCatalog[];
  };
}

let authCache: AuthCache | null = null;

export class OpenStackClientError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: unknown
  ) {
    super(message);
    this.name = "OpenStackClientError";
  }
}

export function fromEnv(): OpenStackConfig {
  const authUrl = process.env.OS_AUTH_URL;
  const username = process.env.OS_USERNAME;
  const password = process.env.OS_PASSWORD;
  const projectName = process.env.OS_PROJECT_NAME;
  const projectDomainId = process.env.OS_PROJECT_DOMAIN_ID ?? "default";
  const userDomainId = process.env.OS_USER_DOMAIN_ID ?? "default";
  const regionName = process.env.OS_REGION_NAME;

  if (!authUrl || !username || !password || !projectName) {
    throw new OpenStackClientError(
      "缺少 OpenStack 认证环境变量：OS_AUTH_URL、OS_USERNAME、OS_PASSWORD、OS_PROJECT_NAME"
    );
  }

  return {
    authUrl,
    username,
    password,
    projectName,
    projectDomainId,
    userDomainId,
    regionName,
  };
}

export function buildConfig(overrides?: Partial<OpenStackConfig>): OpenStackConfig {
  return { ...fromEnv(), ...overrides };
}

export function resetAuthCache(): void {
  authCache = null;
}

async function authenticate(config: OpenStackConfig): Promise<AuthCache> {
  const body = {
    auth: {
      identity: {
        methods: ["password"],
        password: {
          user: {
            name: config.username,
            domain: { id: config.userDomainId },
            password: config.password,
          },
        },
      },
      scope: {
        project: {
          name: config.projectName,
          domain: { id: config.projectDomainId },
        },
      },
    },
  };

  const res = await fetch(`${config.authUrl}/v3/auth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new OpenStackClientError(
      `Keystone 认证失败: ${res.status} ${text}`,
      res.status,
      text
    );
  }

  const token = res.headers.get("X-Subject-Token");
  if (!token) {
    throw new OpenStackClientError("Keystone 响应缺少 X-Subject-Token");
  }

  const data = (await res.json()) as AuthTokenResponse;
  const expiresAt = new Date(data.token.expires_at).getTime();

  return {
    token,
    expiresAt,
    catalog: data.token.catalog,
  };
}

async function ensureAuth(config: OpenStackConfig): Promise<AuthCache> {
  const now = Date.now();
  if (authCache && authCache.expiresAt - now > 60_000) {
    return authCache;
  }
  authCache = await authenticate(config);
  return authCache;
}

export async function getAuthToken(config?: OpenStackConfig): Promise<string> {
  const cache = await ensureAuth(config ?? fromEnv());
  return cache.token;
}

function resolveEndpoint(
  catalog: ServiceCatalog[],
  serviceType: "compute" | "network" | "placement",
  config: OpenStackConfig
): string {
  const service = catalog.find((s) => s.type === serviceType);
  if (!service) {
    throw new OpenStackClientError(`服务目录中未找到服务类型: ${serviceType}`);
  }

  let endpoints = service.endpoints.filter((e) => e.interface === "public");
  if (config.regionName) {
    const regional = endpoints.filter((e) => e.region === config.regionName);
    if (regional.length > 0) {
      endpoints = regional;
    }
  }

  if (endpoints.length === 0) {
    throw new OpenStackClientError(`未找到 ${serviceType} 的可用 public endpoint`);
  }

  return endpoints[0].url.replace(/\/$/, "");
}

export async function openstackRequest(
  serviceType: "compute" | "network" | "placement",
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; region?: string } = {}
): Promise<{ status: number; data: unknown }> {
  const config = fromEnv();
  const cache = await ensureAuth(config);
  const endpoint = resolveEndpoint(cache.catalog, serviceType, config);

  const url = `${endpoint}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    "X-Auth-Token": cache.token,
    Accept: "application/json",
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    // Token 过期或失效，尝试重新认证一次
    resetAuthCache();
    const retryCache = await ensureAuth(config);
    const retryHeaders = { ...headers, "X-Auth-Token": retryCache.token };
    const retryRes = await fetch(url, {
      method: options.method ?? "GET",
      headers: retryHeaders,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return await parseResponse(retryRes);
  }

  return await parseResponse(res);
}

async function parseResponse(res: Response): Promise<{ status: number; data: unknown }> {
  let data: unknown;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : text || `HTTP ${res.status}`;
    throw new OpenStackClientError(
      `OpenStack API 请求失败: ${message}`,
      res.status,
      data
    );
  }

  return { status: res.status, data };
}

// ============================================================================
// 工具级封装：返回统一的 ToolExecutionResult
// ============================================================================

export interface NormalizedServer {
  id: string;
  name: string;
  status: string;
  tenantId: string;
  flavorId: string;
  imageId?: string;
  hypervisorHostname?: string;
  fault?: { message: string; code: number; details?: string };
  addresses: Record<string, unknown>;
  created: string;
  updated: string;
}

export interface NormalizedEvent {
  action: string;
  instanceUuid: string;
  requestId: string;
  startTime: string;
  message?: string;
}

export interface NormalizedHypervisor {
  id: number;
  hypervisorHostname: string;
  vcpus: number;
  vcpusUsed: number;
  memoryMb: number;
  memoryMbUsed: number;
  runningVms: number;
  state: string;
  status: string;
}

export interface NormalizedAgent {
  id: string;
  agentType: string;
  host: string;
  availabilityZone?: string;
  alive: boolean;
  adminStateUp: boolean;
}

export interface NormalizedService {
  id: string;
  binary: string;
  host: string;
  status: string;
  state: string;
  zone: string;
}

function okResult(data: unknown, durationMs: number): ToolExecutionResult {
  return { success: true, data, durationMs };
}

function errResult(error: unknown, start: number): ToolExecutionResult {
  if (error instanceof OpenStackClientError) {
    return { success: false, error: error.message, durationMs: Date.now() - start };
  }
  if (error instanceof Error) {
    return { success: false, error: error.message, durationMs: Date.now() - start };
  }
  return { success: false, error: String(error), durationMs: Date.now() - start };
}

export async function showServer(serverId: string): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const { data } = await openstackRequest("compute", `/servers/${serverId}`);
    const server = (data as { server: any }).server;
    const normalized: NormalizedServer = {
      id: server.id,
      name: server.name,
      status: server.status,
      tenantId: server.tenant_id,
      flavorId: server.flavor?.id,
      imageId: server.image?.id,
      hypervisorHostname: server["OS-EXT-SRV-ATTR:hypervisor_hostname"],
      fault: server.fault,
      addresses: server.addresses,
      created: server.created,
      updated: server.updated,
    };
    return okResult(normalized, Date.now() - start);
  } catch (e) {
    return errResult(e, start);
  }
}

export async function listServerEvents(serverId: string): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const { data } = await openstackRequest("compute", `/servers/${serverId}/os-instance-actions`);
    const actions = (data as { instanceActions: any[] }).instanceActions ?? [];
    const normalized: NormalizedEvent[] = actions.map((a) => ({
      action: a.action,
      instanceUuid: a.instance_uuid,
      requestId: a.request_id,
      startTime: a.start_time,
      message: a.message,
    }));
    return okResult(normalized, Date.now() - start);
  } catch (e) {
    return errResult(e, start);
  }
}

export async function listHypervisors(): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const { data } = await openstackRequest("compute", "/os-hypervisors/detail");
    const hypervisors = (data as { hypervisors: any[] }).hypervisors ?? [];
    const normalized: NormalizedHypervisor[] = hypervisors.map((h) => ({
      id: h.id,
      hypervisorHostname: h.hypervisor_hostname,
      vcpus: h.vcpus,
      vcpusUsed: h.vcpus_used,
      memoryMb: h.memory_mb,
      memoryMbUsed: h.memory_mb_used,
      runningVms: h.running_vms,
      state: h.state,
      status: h.status,
    }));
    return okResult(normalized, Date.now() - start);
  } catch (e) {
    return errResult(e, start);
  }
}

export async function listAllocationCandidates(resources: string): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const encoded = encodeURIComponent(resources);
    const { data } = await openstackRequest(
      "placement",
      `/allocation_candidates?resources=${encoded}`
    );
    return okResult(data, Date.now() - start);
  } catch (e) {
    return errResult(e, start);
  }
}

export async function listNeutronAgents(): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const { data } = await openstackRequest("network", "/v2.0/agents");
    const agents = (data as { agents: any[] }).agents ?? [];
    const normalized: NormalizedAgent[] = agents.map((a) => ({
      id: a.id,
      agentType: a.agent_type,
      host: a.host,
      availabilityZone: a.availability_zone,
      alive: a.alive,
      adminStateUp: a.admin_state_up,
    }));
    return okResult(normalized, Date.now() - start);
  } catch (e) {
    return errResult(e, start);
  }
}

export async function listNovaServices(): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const { data } = await openstackRequest("compute", "/os-services");
    const services = (data as { services: any[] }).services ?? [];
    const normalized: NormalizedService[] = services.map((s) => ({
      id: s.id,
      binary: s.binary,
      host: s.host,
      status: s.status,
      state: s.state,
      zone: s.zone,
    }));
    return okResult(normalized, Date.now() - start);
  } catch (e) {
    return errResult(e, start);
  }
}

export async function rebootServer(serverId: string, rebootType: "SOFT" | "HARD"): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    await openstackRequest("compute", `/servers/${serverId}/action`, {
      method: "POST",
      body: { reboot: { type: rebootType } },
    });
    return okResult(
      { serverId, rebootType, message: "重启请求已发送" },
      Date.now() - start
    );
  } catch (e) {
    return errResult(e, start);
  }
}
