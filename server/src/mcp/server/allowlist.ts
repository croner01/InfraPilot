// ============================================================================
// linux-mcp-server — 变更类命令白名单
// ============================================================================

export const ALLOWED_SERVICES = new Set([
  "nginx",
  "docker",
  "containerd",
  "kubelet",
  "sshd",
  "cron",
]);

export const ALLOWED_SIGNALS = new Set(["SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2"]);

export function isServiceAllowed(serviceName: string): boolean {
  return ALLOWED_SERVICES.has(serviceName);
}

export function isSignalAllowed(signal: string): boolean {
  return ALLOWED_SIGNALS.has(signal);
}

export function sanitizePattern(pattern: string): string {
  // 只允许字母数字下划线点横线，防止 shell 注入
  return pattern.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

// ============================================================================
// 通用只读命令白名单 —— run_command 使用
// 设计目标：覆盖日常 Linux/K8s 诊断命令，并支持环境变量扩展
// ============================================================================

const DEFAULT_ALLOWED_COMMANDS = new Set([
  // 文件/文本查看
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "stat",
  "file",
  "find",
  "grep",
  "awk",
  "sed",
  "jq",
  "sort",
  "uniq",
  "wc",
  // 系统/进程/网络
  "ps",
  "top",
  "ss",
  "netstat",
  "ip",
  "ifconfig",
  "lsof",
  "df",
  "du",
  "free",
  "vmstat",
  "iostat",
  "pidstat",
  "uptime",
  "uname",
  "lscpu",
  "lsblk",
  "fdisk",
  "dmesg",
  "journalctl",
  "systemctl",
  // 网络诊断
  "ping",
  "traceroute",
  "nslookup",
  "dig",
  "curl",
  "wget",
  "nc",
  // K8s / 容器
  "kubectl",
  "crictl",
  "docker",
]);

/**
 * 某些命令只允许特定只读子命令，避免通过白名单绕过变更类工具审批。
 * 例如 systemctl restart 必须走 restart_service 工具。
 */
const COMMAND_SUBCOMMAND_ALLOWLIST: Record<string, Set<string> | undefined> = {
  systemctl: new Set(["status", "is-active", "is-enabled", "is-failed", "show", "list-units", "list-unit-files"]),
  journalctl: undefined, // 任意子命令默认只读
  kubectl: new Set([
    "get",
    "describe",
    "logs",
    "top",
    "version",
    "auth",
    "api-resources",
    "api-versions",
    "explain",
  ]),
  crictl: new Set(["ps", "pods", "logs", "inspect", "stat", "info", "version"]),
  docker: new Set(["ps", "images", "stats", "inspect", "logs", "info", "version"]),
};

function loadEnvExtensions(): Set<string> {
  const extra = process.env.MCP_COMMAND_ALLOWLIST;
  if (!extra) return new Set();
  return new Set(
    extra
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
  );
}

export function getAllowedCommands(): Set<string> {
  return new Set([...DEFAULT_ALLOWED_COMMANDS, ...loadEnvExtensions()]);
}

export function isCommandAllowed(command: string, args: string[] = []): { allowed: boolean; reason?: string } {
  // 只允许命令名本身，禁止绝对路径或路径穿越
  if (command.includes("/") || command.includes("\\") || command.startsWith(".")) {
    return { allowed: false, reason: "command 只能是 PATH 中的命令名，不能包含路径" };
  }

  const allowed = getAllowedCommands();
  if (!allowed.has(command)) {
    return { allowed: false, reason: `命令 ${command} 不在白名单中。可通过 MCP_COMMAND_ALLOWLIST 扩展` };
  }

  const subAllowlist = COMMAND_SUBCOMMAND_ALLOWLIST[command];
  if (subAllowlist && args.length > 0) {
    const first = args[0];
    // 跳过全局选项，例如 kubectl --namespace default get ...
    let idx = 0;
    while (idx < args.length && args[idx].startsWith("-")) idx++;
    const sub = args[idx];
    if (sub && !subAllowlist.has(sub)) {
      return { allowed: false, reason: `命令 ${command} ${sub} 不在允许子命令列表中` };
    }
  }

  return { allowed: true };
}
