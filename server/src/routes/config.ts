// ============================================================================
// Configuration API — 日志系统（ELK/ClickHouse/Generic）与远程主机配置
// ============================================================================

import { Router } from "express";
import { Client } from "ssh2";
import {
  deleteLogSystem,
  getHostRegistry,
  getLogSystems,
  getLlmProviders,
  getMcpConfig,
  setDefaultLlmProvider,
  setHosts,
  setLogSystems,
  setMcpConfig,
  upsertLogSystem,
  upsertLlmProvider,
  deleteLlmProvider,
  generateMcpJwtSecret,
  getMemoryConfig,
  setMemoryConfig,
} from "../config/store.js";
import type { HostEntry, LogBackend, LlmProvider, MemoryConfig } from "../config/types.js";
import { findHost, getPrivateKeyContent, resolveAuthSecret } from "../gateway/sshHosts.js";
import { reloadShipTargets, getShipStatus } from "../skills/elk/logShipper.js";

export const configRouter = Router();

// -------------------- Log Systems --------------------

configRouter.get("/log-systems", (_req, res) => {
  res.json({ systems: getLogSystems() });
});

configRouter.put("/log-systems", (req, res) => {
  const { systems } = req.body ?? {};
  if (!Array.isArray(systems)) {
    res.status(400).json({ error: "systems must be an array" });
    return;
  }
  setLogSystems(systems as LogBackend[]);
  reloadShipTargets();
  res.json({ ok: true, systems: getLogSystems() });
});

configRouter.post("/log-systems", (req, res) => {
  const system = req.body as LogBackend;
  if (!system?.id || !system?.type || !system?.name) {
    res.status(400).json({ error: "id, type and name are required" });
    return;
  }
  upsertLogSystem(system);
  reloadShipTargets();
  res.json({ ok: true, systems: getLogSystems() });
});

configRouter.delete("/log-systems/:id", (req, res) => {
  const { id } = req.params;
  deleteLogSystem(id);
  reloadShipTargets();
  res.json({ ok: true, systems: getLogSystems() });
});

configRouter.post("/log-systems/:id/test", async (req, res) => {
  const { id } = req.params;
  const system = getLogSystems().find((s) => s.id === id);
  if (!system) {
    res.status(404).json({ error: "log system not found" });
    return;
  }
  try {
    const reachable = await testLogSystem(system);
    res.json({ ok: true, reachable, systemId: id });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err?.message ?? String(err), systemId: id });
  }
});

// 采集状态：返回该 ELK 后端各采集目标的文件数/最近采集/错误信息
configRouter.get("/log-systems/:id/ship-status", (req, res) => {
  const { id } = req.params;
  const system = getLogSystems().find((s) => s.id === id);
  if (!system) {
    res.status(404).json({ error: "log system not found" });
    return;
  }
  if (system.type !== "elk") {
    res.json({ ok: true, statuses: [] });
    return;
  }
  res.json({ ok: true, statuses: getShipStatus() });
});

async function testLogSystem(system: LogBackend): Promise<boolean> {
  if (system.type === "elk") {
    const { Client } = await import("@opensearch-project/opensearch");
    const client = new Client({ node: system.node });
    await client.cluster.health({ wait_for_status: "yellow", timeout: "5s" });
    return true;
  }
  if (system.type === "clickhouse") {
    // 轻量 HTTP 探活：查询 system.tables 确认数据库存在
    const url = new URL("/", `http://${system.host}:${system.port ?? 8123}`);
    const params = new URLSearchParams({ query: `SELECT 1 FROM system.databases WHERE name = '${system.database}'` });
    const response = await fetch(`${url.toString()}?${params.toString()}`, {
      headers: system.passwordEnv && process.env[system.passwordEnv]
        ? { "X-ClickHouse-User": system.username, "X-ClickHouse-Key": process.env[system.passwordEnv]! }
        : { "X-ClickHouse-User": system.username },
    });
    if (!response.ok) throw new Error(`ClickHouse 返回 ${response.status}`);
    return true;
  }
  if (system.type === "generic") {
    const headers: Record<string, string> = { ...(system.headers ?? {}) };
    if (system.headerEnv) {
      for (const [key, envName] of Object.entries(system.headerEnv)) {
        if (process.env[envName]) headers[key] = process.env[envName]!;
      }
    }
    const response = await fetch(system.url, { method: "HEAD", headers });
    return response.ok;
  }
  throw new Error(`unsupported log system type: ${(system as any).type}`);
}

// -------------------- 远程主机配置 --------------------

configRouter.get("/hosts", (_req, res) => {
  res.json(getHostRegistry());
});

configRouter.put("/hosts", (req, res) => {
  const { hosts } = req.body ?? {};
  if (!Array.isArray(hosts)) {
    res.status(400).json({ error: "hosts must be an array" });
    return;
  }
  setHosts(hosts as HostEntry[]);
  res.json({ ok: true, hosts });
});

configRouter.post("/hosts", (req, res) => {
  const entry = req.body as HostEntry;
  if (!entry?.name || !entry?.auth?.type) {
    res.status(400).json({ error: "name and auth.type are required" });
    return;
  }
  if (entry.auth.type !== "mcp" && (!entry?.hostname || !entry?.username)) {
    res.status(400).json({ error: "hostname and username are required for SSH hosts" });
    return;
  }
  if (entry.auth.type === "mcp" && !entry.auth.endpoint) {
    res.status(400).json({ error: "endpoint is required for MCP hosts" });
    return;
  }
  const current = getHostRegistry();
  const filtered = current.hosts.filter((h) => h.name !== entry.name);
  filtered.push({ ...entry, port: entry.port ?? 22 });
  setHosts(filtered);
  res.json({ ok: true, hosts: filtered });
});

configRouter.delete("/hosts/:name", (req, res) => {
  const { name } = req.params;
  const current = getHostRegistry();
  const filtered = current.hosts.filter((h) => h.name !== name);
  if (filtered.length === current.hosts.length) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  setHosts(filtered);
  res.json({ ok: true, hosts: filtered });
});

configRouter.post("/hosts/:name/test", async (req, res) => {
  const { name } = req.params;
  const registry = getHostRegistry();
  const host = findHost(registry, name);
  if (!host) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  try {
    const reachable = host.auth.type === "mcp" ? await testMcpConnection(host) : await testSshConnection(host);
    res.json({ ok: true, reachable, host: name });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err?.message ?? String(err), host: name });
  }
});

async function testMcpConnection(host: HostEntry): Promise<boolean> {
  const endpoint = host.auth.endpoint;
  if (!endpoint) throw new Error("MCP endpoint not configured");
  const { grpcMcpClient } = await import("../mcp/grpcClient.js");
  const health = await grpcMcpClient.health({ host: host.name, transport: "grpc", grpcTarget: endpoint });
  if (!health.ok) throw new Error("MCP health check failed");
  return true;
}

// -------------------- LLM Providers --------------------

configRouter.get("/llm-providers", (_req, res) => {
  res.json({ providers: getLlmProviders() });
});

configRouter.post("/llm-providers", (req, res) => {
  const provider = req.body as LlmProvider;
  if (!provider?.id || !provider?.type || !provider?.name || !provider?.baseURL) {
    res.status(400).json({ error: "id, type, name and baseURL are required" });
    return;
  }
  upsertLlmProvider(provider);
  res.json({ ok: true, providers: getLlmProviders() });
});

configRouter.delete("/llm-providers/:id", (req, res) => {
  const { id } = req.params;
  deleteLlmProvider(id);
  res.json({ ok: true, providers: getLlmProviders() });
});

configRouter.post("/llm-providers/:id/default", (req, res) => {
  const { id } = req.params;
  setDefaultLlmProvider(id);
  res.json({ ok: true, providers: getLlmProviders() });
});

configRouter.post("/llm-providers/:id/test", async (req, res) => {
  const { id } = req.params;
  const provider = getLlmProviders().find((p) => p.id === id);
  if (!provider) {
    res.status(404).json({ error: "provider not found" });
    return;
  }
  try {
    const reachable = await testLlmProvider(provider);
    res.json({ ok: true, reachable, providerId: id });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err?.message ?? String(err), providerId: id });
  }
});

// -------------------- MCP Configuration --------------------

configRouter.get("/mcp", (_req, res) => {
  res.json(getMcpConfig());
});

configRouter.put("/mcp", (req, res) => {
  const { serverPort, jwtSecret } = req.body ?? {};
  setMcpConfig({ serverPort, jwtSecret });
  res.json({ ok: true });
});

configRouter.post("/mcp/generate-secret", (_req, res) => {
  res.json({ secret: generateMcpJwtSecret() });
});

async function testLlmProvider(provider: LlmProvider): Promise<boolean> {
  const { OpenAI } = await import("openai");
  const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv ?? ""] ?? "sk-test";
  if (!apiKey || apiKey === "sk-test") {
    throw new Error("API Key 未配置");
  }
  const client = new OpenAI({ apiKey, baseURL: provider.baseURL });
  const model = provider.recommendedModel || "gpt-4o";
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    max_tokens: 5,
  });
  // 消费第一个 chunk 即认为连通
  for await (const _chunk of stream) {
    return true;
  }
  return true;
}

function testSshConnection(host: HostEntry): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.end();
      reject(new Error("SSH 连接超时"));
    }, 8000);

    client.on("ready", () => {
      clearTimeout(timeout);
      client.end();
      resolve(true);
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    const auth = resolveAuthSecret(host.auth);
    const connectConfig: any = {
      host: host.hostname,
      port: host.port ?? 22,
      username: host.username,
      readyTimeout: 8000,
      keepaliveInterval: 0,
    };

    if (auth.type === "password" && auth.password) {
      connectConfig.password = auth.password;
    } else if (auth.type === "privateKey") {
      const key = getPrivateKeyContent(auth);
      if (!key) {
        reject(new Error("未找到私钥内容"));
        return;
      }
      connectConfig.privateKey = key;
      if (auth.passphrase) connectConfig.passphrase = auth.passphrase;
    } else if (auth.type === "agent") {
      connectConfig.agent = process.env.SSH_AUTH_SOCK || "/run/user/0/keyring/ssh";
    }

    client.connect(connectConfig);
  });
}

// -------------------- Memory Configuration --------------------

configRouter.get("/memory", (_req, res) => {
  res.json(getMemoryConfig());
});

configRouter.put("/memory", (req, res) => {
  const { enabled, recallTopK } = req.body ?? {};
  setMemoryConfig({ enabled, recallTopK } as MemoryConfig);
  res.json({ ok: true, ...getMemoryConfig() });
});
