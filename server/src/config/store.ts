// ============================================================================
// Runtime Configuration Store
//
// 为前端配置面板提供持久化能力：远程主机、ELK 采集目标等配置可在运行时
// 通过 API 读写，并落盘到 data/runtime-config.json。生产环境仍优先从环境变量
// 或 K8s Secret/ConfigMap 注入；本模块作为 demo/本地开发的补充。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import type { HostEntry, HostRegistry } from "../gateway/sshHosts.js";
import type { ShipTarget } from "../skills/elk/logShipper.js";

const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "runtime-config.json");

interface RuntimeConfig {
  elk?: {
    node?: string;
    targets?: ShipTarget[];
  };
  hosts?: HostEntry[];
}

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

export function getElkConfig(): { node: string; targets: ShipTarget[] } {
  const runtime = load().elk;
  const node = runtime?.node ?? process.env.OPENSEARCH_NODE ?? "http://127.0.0.1:9200";
  const targets = runtime?.targets ?? (process.env.LOG_SHIP_TARGETS ? JSON.parse(process.env.LOG_SHIP_TARGETS) : undefined) ?? [
    { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" },
  ];
  return { node, targets };
}

export function setElkConfig(config: { node?: string; targets?: ShipTarget[] }) {
  const current = load();
  current.elk = {
    node: config.node ?? current.elk?.node ?? process.env.OPENSEARCH_NODE ?? "http://127.0.0.1:9200",
    targets: config.targets ?? current.elk?.targets,
  };
  if (config.node) process.env.OPENSEARCH_NODE = config.node;
  if (config.targets) process.env.LOG_SHIP_TARGETS = JSON.stringify(config.targets);
  save(current);
}

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
