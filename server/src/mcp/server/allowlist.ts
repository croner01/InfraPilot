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
