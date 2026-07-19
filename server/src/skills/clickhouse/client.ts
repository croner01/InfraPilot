// ============================================================================
// ClickHouse Skill — 客户端连接
//
// 支持从以下位置读取连接配置(优先级从高到低):
// 1. 前端/调用方传入的临时参数 (host, database, username, password)
// 2. 环境变量 CLICKHOUSE_*
// 3. K8s Service 自动发现: 如果后端运行在集群外,通过 K8s API 读取 clickhouse.islap svc 的 ClusterIP
// 4. 默认值: http://clickhouse.islap.svc.cluster.local:8123 / default / logs / logs
//
// 因为当前 ClickHouse 由 K8s 托管在 islap 命名空间,后端如果在集群内运行,
// 使用服务名访问最稳定;在本地开发/sandbox 时,集群 DNS 通常不可解析,
// 所以自动发现 ClusterIP 是更可靠的默认行为。
// ============================================================================

import { createClient, ClickHouseClient } from "@clickhouse/client";
import { coreApi } from "../k8s/client.js";

export interface ClickHouseConnection {
  host: string;
  database: string;
  table: string;
  username: string;
  password: string;
}

export const DEFAULT_CLICKHOUSE: ClickHouseConnection = {
  host: "http://clickhouse.islap.svc.cluster.local:8123",
  database: "logs",
  table: "logs",
  username: "default",
  password: "",
};

/** 通过 K8s API 自动发现 islap/clickhouse 服务的 ClusterIP 和 http 端口 */
async function discoverClickHouseUrl(): Promise<string | undefined> {
  try {
    const svc = await coreApi.readNamespacedService({ name: "clickhouse", namespace: "islap" });
    const clusterIP = svc.spec?.clusterIP;
    const httpPort = svc.spec?.ports?.find((p) => p.name === "http" || p.port === 8123)?.port ?? 8123;
    if (clusterIP && clusterIP !== "None") {
      return `http://${clusterIP}:${httpPort}`;
    }
  } catch (err: any) {
    console.warn("[clickhouse client] K8s Service 自动发现失败:", err?.message ?? err);
  }
  return undefined;
}

let discoveredUrl: string | undefined;
let discoveryPromise: Promise<string | undefined> | undefined;

export async function getDefaultClickHouseUrl(): Promise<string> {
  if (discoveredUrl) return discoveredUrl;
  if (!discoveryPromise) {
    discoveryPromise = discoverClickHouseUrl().then((url) => {
      if (url) {
        discoveredUrl = url;
        console.log(`[clickhouse client] 通过 K8s API 发现 ClickHouse 地址: ${url}`);
      }
      return url;
    });
  }
  const url = await discoveryPromise;
  return url ?? DEFAULT_CLICKHOUSE.host;
}

function fromEnv(): Partial<ClickHouseConnection> {
  return {
    host: process.env.CLICKHOUSE_HOST,
    database: process.env.CLICKHOUSE_DATABASE,
    table: process.env.CLICKHOUSE_TABLE,
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
  };
}

export async function buildConnection(overrides?: Partial<ClickHouseConnection>): Promise<ClickHouseConnection> {
  const env = fromEnv();
  const host = overrides?.host ?? env.host ?? (await getDefaultClickHouseUrl());
  return {
    host,
    database: overrides?.database ?? env.database ?? DEFAULT_CLICKHOUSE.database,
    table: overrides?.table ?? env.table ?? DEFAULT_CLICKHOUSE.table,
    username: overrides?.username ?? env.username ?? DEFAULT_CLICKHOUSE.username,
    password: overrides?.password ?? env.password ?? DEFAULT_CLICKHOUSE.password,
  };
}

export async function createClickHouseClient(conn?: Partial<ClickHouseConnection>): Promise<ClickHouseClient> {
  const c = await buildConnection(conn);
  const requestTimeoutMs = Number(process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS ?? 60000);
  return createClient({
    url: c.host,
    database: c.database,
    username: c.username,
    password: c.password,
    request_timeout: requestTimeoutMs,
  });
}
