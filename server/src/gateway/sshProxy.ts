// ============================================================================
// SSH Proxy — 远程主机命令执行代理
//
// 位于 Command Gateway 层,是项目中唯一直接持有 SSH 私钥/密码的模块。
// 职责:
// 1. 根据 host 别名从 Host Registry 获取连接信息
// 2. 校验命令白名单,拒绝危险操作
// 3. 通过 ssh2 库在远程主机上执行命令
// 4. 对 stdout/stderr 做敏感信息脱敏
// 5. 记录审计日志(调用方、目标主机、命令、风险等级、结果摘要)
//
// 设计文档对应: §7.1 linux-mcp-server、§8.3 安全网关、§13.2 部署架构
// ============================================================================

import { Client } from "ssh2";
import { loadHostRegistry, findHost, resolveAuthSecret, getPrivateKeyContent } from "./sshHosts.js";
import type { HostEntry, HostRegistry } from "./sshHosts.js";
import { redact } from "./redact.js";
import { v4 as uuidv4 } from "uuid";

export interface SshExecuteOptions {
  /** 逻辑主机名(来自 Host Registry) */
  host: string;
  /** 命令基名,如 "top" */
  command: string;
  /** 命令参数数组,如 ["-b", "-n", "1"] */
  args: string[];
  /**
   * 预构建的完整 shell 命令行(如 "top -b -n 1 | head -n 15")，仅用于受信任的 Linux Skill 内部命令模板。
   * 如果提供 cmdLine，将优先使用它，并走独立的命令模板安全校验。
   */
  cmdLine?: string;
  /** 调用方标识,用于审计 */
  caller?: string;
  /** 超时毫秒,默认 30000 */
  timeoutMs?: number;
}

export interface SshExecuteResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  error?: string;
}

// 默认只读诊断命令白名单。变更类命令(如 systemctl restart/reboot/kill 等)默认禁用,
// 如需开放,通过 SSH_COMMAND_ALLOWLIST 环境变量覆盖。
export const DEFAULT_DIAGNOSTIC_ALLOWLIST = new Set([
  // 进程/CPU/内存/磁盘
  "top", "htop", "ps", "free", "vmstat", "mpstat", "iostat", "pidstat", "df", "du", "lsblk", "fdisk", "ls",
  // 内核/系统日志
  "dmesg", "journalctl", "uptime", "uname", "cat", "tail", "head", "grep", "zgrep",
  // 网络
  "ss", "netstat", "ip", "ifconfig", "ping", "traceroute", "nslookup", "dig", "curl", "wget",
  // K8s/OpenStack 相关诊断
  "systemctl", "service", "virsh", "ovs-vsctl", "ovs-ofctl", "brctl", "ipvsadm",
  // 文件查找
  "find", "lsof", "stat", "file",
  // 等待/测试(只读,无状态变更)
  "sleep", "echo",
]);

// systemctl 仅允许 status 子命令,禁止 restart/stop/start 等变更操作(除非显式配置)
const DANGEROUS_SUBCOMMANDS = ["restart", "stop", "start", "reload", "enable", "disable", "mask", "unmask"];

// 受信任的 Linux Skill 内部 shell 命令模板。用于处理包含管道、grep 等复杂只读诊断命令。
// 这些模板必须严格限定:只读、无用户输入插值、无文件写入。
const SAFE_CMDLINE_PATTERNS: RegExp[] = [
  /^top -b -n \d+ \| head -n \d+$/,
  /^dmesg(?:\s+2>\/dev\/null)?\s*\|\s*grep -i '[^']*'\s*\|\s*tail -n \d+(?:\s+\|\|\s*true)?$/,
  /^ps -eo pid,(?:rss,pcpu,etimes,|)cmd \| grep -i '[a-zA-Z0-9_.\-]+' \| grep -v grep \|\| true$/,
  /^dmesg(?:\s+2>\/dev\/null)?\s*\|\s*tail -n \d+(?:\s+\|\|\s*echo '[^']*')?$/,
];

function loadAllowlist(): Set<string> {
  const env = process.env.SSH_COMMAND_ALLOWLIST;
  if (!env) return DEFAULT_DIAGNOSTIC_ALLOWLIST;
  return new Set(env.split(",").map((s) => s.trim()).filter(Boolean));
}

function isAllowlisted(command: string, args: string[]): boolean {
  const allowlist = loadAllowlist();
  const base = command.toLowerCase();
  if (!allowlist.has(base)) return false;

  // systemctl 只允许 status/is-active/is-enabled/is-failed 等只读子命令
  if (base === "systemctl" && args.length > 0) {
    const sub = args[0].toLowerCase();
    if (DANGEROUS_SUBCOMMANDS.includes(sub)) return false;
  }

  // 简单防御: 禁止参数里出现 shell 元字符或路径遍历
  const dangerousChars = /[;&|`$(){}\[\]<>]/;
  for (const a of args) {
    if (dangerousChars.test(a)) return false;
  }
  return true;
}

function isTrustedCmdLine(cmdLine: string): boolean {
  return SAFE_CMDLINE_PATTERNS.some((p) => p.test(cmdLine));
}

interface SshAuditEvent {
  id: string;
  host: string;
  hostname: string;
  command: string;
  caller: string;
  allowed: boolean;
  success: boolean;
  error?: string;
  durationMs: number;
  timestamp: string;
}

/**
 * 记录 SSH Proxy 层审计日志。
 * 当前输出到 stderr(结构化 JSON),便于接入企业日志采集;Command Gateway 层还会再写一份 SQLite 审计。
 */
function writeSshAudit(event: SshAuditEvent) {
  try {
    console.error(`[SSH_AUDIT] ${JSON.stringify(event)}`);
  } catch {
    // 审计日志写入失败不应影响主流程
  }
}

function buildAuditEvent(
  opts: SshExecuteOptions,
  entry: HostEntry | undefined,
  allowed: boolean,
  success: boolean,
  error: string | undefined,
  durationMs: number
): SshAuditEvent {
  return {
    id: uuidv4(),
    host: opts.host,
    hostname: entry?.hostname ?? "unknown",
    command: opts.cmdLine ? `sh -c ${opts.cmdLine}` : `${opts.command} ${opts.args.join(" ")}`,
    caller: opts.caller ?? "unknown",
    allowed,
    success,
    error,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

/** 将命令和参数安全地组合为单一 shell 命令字符串,供 ssh2 exec 使用 */
function buildCommandString(command: string, args: string[]): string {
  const shellEscape = (s: string) => {
    if (/^[a-zA-Z0-9_.\-/:=@]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
  };
  return [command, ...args].map(shellEscape).join(" ");
}

export async function executeRemoteCommand(opts: SshExecuteOptions): Promise<SshExecuteResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30000;
  let entry: HostEntry | undefined;

  try {
    const registry: HostRegistry = loadHostRegistry();
    entry = findHost(registry, opts.host);
    if (!entry) {
      const durationMs = Date.now() - start;
      const audit = buildAuditEvent(opts, undefined, false, false, `未在 Host Registry 中找到主机: ${opts.host}`, durationMs);
      writeSshAudit(audit);
      return {
        success: false,
        stdout: "",
        stderr: "",
        durationMs,
        error: audit.error,
      };
    }

    let cmdStr: string;
    if (opts.cmdLine) {
      if (!isTrustedCmdLine(opts.cmdLine)) {
        const durationMs = Date.now() - start;
        const audit = buildAuditEvent(opts, entry, false, false, `命令不在受信任的模板列表中: ${opts.cmdLine}`, durationMs);
        writeSshAudit(audit);
        return {
          success: false,
          stdout: "",
          stderr: "",
          durationMs,
          error: audit.error,
        };
      }
      cmdStr = opts.cmdLine;
    } else {
      if (!isAllowlisted(opts.command, opts.args)) {
        const durationMs = Date.now() - start;
        const audit = buildAuditEvent(
          opts,
          entry,
          false,
          false,
          `命令不在允许列表中或被判定为危险操作: ${opts.command} ${opts.args.join(" ")}`,
          durationMs
        );
        writeSshAudit(audit);
        return {
          success: false,
          stdout: "",
          stderr: "",
          durationMs,
          error: audit.error,
        };
      }
      cmdStr = buildCommandString(opts.command, opts.args);
    }

    const auth = resolveAuthSecret(entry.auth);
    const hostEntry = entry; // 类型收窄: 运行到此处 entry 必定已定义

    return new Promise<SshExecuteResult>((resolve) => {
      const client = new Client();
      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];
      let settled = false;

      const finish = (result: SshExecuteResult) => {
        if (settled) return;
        settled = true;
        const audit = buildAuditEvent(opts, hostEntry, true, result.success, result.error, result.durationMs);
        writeSshAudit(audit);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        client.end();
        finish({
          success: false,
          stdout: redact(Buffer.concat(stdoutChunks).toString("utf8")),
          stderr: redact(Buffer.concat(stderrChunks).toString("utf8")),
          durationMs: Date.now() - start,
          error: `SSH 命令执行超时(${timeoutMs}ms): ${cmdStr}`,
        });
      }, timeoutMs);

      client.on("ready", () => {
        client.exec(cmdStr, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            client.end();
            finish({
              success: false,
              stdout: "",
              stderr: "",
              durationMs: Date.now() - start,
              error: `SSH exec 失败: ${err.message}`,
            });
            return;
          }

          stream.on("close", (code: number | null, signal: string | null) => {
            clearTimeout(timeout);
            client.end();
            finish({
              success: code === 0,
              stdout: redact(Buffer.concat(stdoutChunks).toString("utf8")),
              stderr: redact(Buffer.concat(stderrChunks).toString("utf8")),
              exitCode: code ?? undefined,
              signal: signal ?? undefined,
              durationMs: Date.now() - start,
              error: code !== 0 && code !== null ? `远程命令退出码非 0: ${code}` : undefined,
            });
          });

          stream.on("data", (data: Buffer) => stdoutChunks.push(data));
          stream.stderr.on("data", (data: Buffer) => stderrChunks.push(data));
        });
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        client.end();
        finish({
          success: false,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - start,
          error: `SSH 连接失败: ${err.message}`,
        });
      });

      const connectConfig: any = {
        host: hostEntry.hostname,
        port: hostEntry.port ?? 22,
        username: hostEntry.username,
        readyTimeout: timeoutMs,
      };

      if (auth.type === "privateKey") {
        const keyContent = getPrivateKeyContent(auth);
        if (!keyContent) {
          clearTimeout(timeout);
          client.end();
          finish({
            success: false,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - start,
            error: `未找到私钥: privateKeyPath=${auth.privateKeyPath}, privateKeyEnv=${auth.privateKeyEnv}`,
          });
          return;
        }
        connectConfig.privateKey = keyContent;
        if (auth.passphrase) connectConfig.passphrase = auth.passphrase;
      } else if (auth.type === "password") {
        connectConfig.password = auth.password ?? "";
      } else if (auth.type === "agent") {
        connectConfig.agent = process.env.SSH_AUTH_SOCK;
      }

      client.connect(connectConfig);
    });
  } catch (e: any) {
    const durationMs = Date.now() - start;
    const audit = buildAuditEvent(opts, entry, true, false, `SSH Proxy 内部错误: ${e?.message ?? String(e)}`, durationMs);
    writeSshAudit(audit);
    return {
      success: false,
      stdout: "",
      stderr: "",
      durationMs,
      error: audit.error,
    };
  }
}

export { loadHostRegistry, findHost };
export type { HostEntry, HostRegistry };
