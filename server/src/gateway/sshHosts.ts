// ============================================================================
// SSH Host Registry — 远程主机注册表
//
// 负责维护"host 别名 → SSH 连接信息"的映射。支持三种配置来源(优先级从高到低):
// 1. SSH_HOSTS 环境变量(JSON 字符串) —— 适合容器/CI 直接注入
// 2. SSH_HOSTS_CONFIG 环境变量指定的配置文件(JSON/YAML) —— 适合本地开发/运维管理
// 3. /etc/infrapilot/ssh-hosts.yaml (或 .json) 默认路径
//
// 安全原则:
// - 配置文件里不直接写私钥明文,而是写 privateKeyPath 或 privateKeyEnv
// - 密码/私钥优先从环境变量或 K8s Secret 挂载的文件读取
// - 本模块仅做配置聚合,不执行连接,凭据解析交给 sshProxy
// ============================================================================

import fs from "node:fs";
import path from "node:path";

export type AuthType = "password" | "privateKey" | "agent";

export interface HostAuth {
  type: AuthType;
  /** 密码明文(不推荐,仅用于 demo/测试)或环境变量名 */
  password?: string;
  /** 密码来自哪个环境变量 */
  passwordEnv?: string;
  /** 私钥文件路径 */
  privateKeyPath?: string;
  /** 私钥内容来自哪个环境变量 */
  privateKeyEnv?: string;
  /** 私钥 passphrase */
  passphrase?: string;
  /** passphrase 来自哪个环境变量 */
  passphraseEnv?: string;
}

export interface HostEntry {
  /** Agent/用户使用的逻辑主机名,如 "node-1" */
  name: string;
  /** SSH 连接用的真实地址(IP 或 FQDN) */
  hostname: string;
  /** SSH 端口,默认 22 */
  port?: number;
  /** SSH 登录用户名 */
  username: string;
  /** 认证信息 */
  auth: HostAuth;
  /** 标签,用于后续按标签批量选择主机 */
  labels?: Record<string, string>;
  /** 角色标签,如 ["k8s-master", "network-node"] */
  tags?: string[];
}

export interface HostRegistry {
  hosts: HostEntry[];
}

const DEFAULT_CONFIG_PATHS = [
  "/etc/infrapilot/ssh-hosts.yaml",
  "/etc/infrapilot/ssh-hosts.yml",
  "/etc/infrapilot/ssh-hosts.json",
];

function parseYamlLike(content: string): HostRegistry {
  // 极简 YAML 子集解析: 只支持本项目配置格式,不引入 js-yaml 依赖
  // 生产环境如需完整 YAML,可替换为 js-yaml.load()
  const lines = content.split("\n");
  const hosts: HostEntry[] = [];
  let current: Partial<HostEntry> & { auth?: Partial<HostAuth> } = {};
  let currentAuth: Partial<HostAuth> = {};
  let inHosts = false;
  let indentStack: { key: string; obj: any }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0];
    if (!line.trim()) continue;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed === "hosts:") {
      inHosts = true;
      continue;
    }
    if (!inHosts) continue;

    // 新的 host 条目: "- name: node-1"
    if (trimmed.startsWith("- ")) {
      if (current.name) {
        hosts.push({
          ...current,
          auth: currentAuth as HostAuth,
          port: current.port ?? 22,
        } as HostEntry);
      }
      current = {};
      currentAuth = {};
      const kv = trimmed.replace("- ", "").split(":");
      const key = kv[0].trim();
      const value = kv.slice(1).join(":").trim().replace(/^["']|["']$/g, "");
      (current as any)[key] = value;
      continue;
    }

    // 键值对
    const kv = trimmed.split(":");
    const key = kv[0].trim();
    const value = kv.slice(1).join(":").trim().replace(/^["']|["']$/g, "");

    if (indent >= 4 && ["type", "password", "passwordEnv", "privateKeyPath", "privateKeyEnv", "passphrase", "passphraseEnv"].includes(key)) {
      (currentAuth as any)[key] = value;
    } else if (key === "auth") {
      // auth: 行本身无值,子项缩进
      continue;
    } else if (key === "labels" || key === "tags") {
      // 简化: 暂不解析内嵌 map/array
    } else {
      (current as any)[key] = value;
    }
  }

  if (current.name) {
    hosts.push({
      ...current,
      auth: currentAuth as HostAuth,
      port: current.port ?? 22,
    } as HostEntry);
  }

  return { hosts };
}

export function loadHostsFromFile(filePath: string): HostRegistry {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf8");
  if (ext === ".json") {
    return JSON.parse(content) as HostRegistry;
  }
  return parseYamlLike(content);
}

export function loadHostsFromEnv(): HostRegistry | undefined {
  const raw = process.env.SSH_HOSTS;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as HostRegistry;
  } catch (e: any) {
    throw new Error(`SSH_HOSTS 环境变量 JSON 解析失败: ${e.message}`);
  }
}

export function loadHostRegistry(): HostRegistry {
  // 1. 环境变量 JSON
  const fromEnv = loadHostsFromEnv();
  if (fromEnv) return fromEnv;

  // 2. 指定配置文件
  const configPath = process.env.SSH_HOSTS_CONFIG;
  if (configPath && fs.existsSync(configPath)) {
    return loadHostsFromFile(configPath);
  }

  // 3. 默认路径
  for (const p of DEFAULT_CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      return loadHostsFromFile(p);
    }
  }

  // 4. 默认空注册表(只有 local)
  return { hosts: [] };
}

export function findHost(registry: HostRegistry, name: string): HostEntry | undefined {
  return registry.hosts.find((h) => h.name === name || h.hostname === name);
}

export function resolveAuthSecret(auth: HostAuth): HostAuth {
  const resolved: HostAuth = { ...auth };
  if (auth.passwordEnv && process.env[auth.passwordEnv]) {
    resolved.password = process.env[auth.passwordEnv];
  }
  if (auth.privateKeyEnv && process.env[auth.privateKeyEnv]) {
    resolved.privateKeyPath = undefined; // 使用环境变量内容时忽略路径
    // 不直接在这里读取,由 sshProxy 按需读取,避免内存中常驻明文私钥
  }
  if (auth.passphraseEnv && process.env[auth.passphraseEnv]) {
    resolved.passphrase = process.env[auth.passphraseEnv];
  }
  return resolved;
}

export function getPrivateKeyContent(auth: HostAuth): string | undefined {
  if (auth.privateKeyEnv && process.env[auth.privateKeyEnv]) {
    return process.env[auth.privateKeyEnv];
  }
  if (auth.privateKeyPath && fs.existsSync(auth.privateKeyPath)) {
    return fs.readFileSync(auth.privateKeyPath, "utf8");
  }
  return undefined;
}
