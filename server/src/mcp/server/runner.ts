// ============================================================================
// linux-mcp-server — 本地命令执行与结构化解析
// ============================================================================

import { execFile } from "node:child_process";
import fs from "node:fs";
import { redact } from "../../gateway/redact.js";

export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
  error?: string;
}

export function run(
  cmd: string,
  args: string[],
  timeoutMs = 8000
): Promise<RunResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as any)?.code ?? 0;
      resolve({
        success: code === 0,
        stdout: redact(stdout?.toString() ?? ""),
        stderr: redact(stderr?.toString() ?? ""),
        code,
        durationMs: Date.now() - start,
        error: code !== 0 ? `命令退出码非 0: ${code}` : undefined,
      });
    });
  });
}

// ----------------------------------------------------------------------------
// CPU
// ----------------------------------------------------------------------------

export async function getCpuUsage(topN = 5): Promise<{
  success: boolean;
  usage_percent: number;
  top_processes: { pid: number; cmd: string; cpu_percent: number; rss_mb: number }[];
  error?: string;
}> {
  const result = await run("sh", ["-c", "top -b -n 1"], 10000);
  if (!result.success) {
    return { success: false, usage_percent: 0, top_processes: [], error: result.error };
  }

  const lines = result.stdout.split("\n");
  let usagePercent = 0;
  const topProcesses: { pid: number; cmd: string; cpu_percent: number; rss_mb: number }[] = [];

  // 解析 %Cpu(s):  0.0 us,  0.0 sy, ...
  for (const line of lines) {
    const cpuMatch = line.match(/%Cpu\(s\):\s*([\d.]+)\s+us/);
    if (cpuMatch) {
      usagePercent = parseFloat(cpuMatch[1]);
      break;
    }
  }

  // 解析进程列表（从 "  PID USER" 之后开始）
  let inProcessSection = false;
  for (const line of lines) {
    if (line.includes("PID") && line.includes("USER")) {
      inProcessSection = true;
      continue;
    }
    if (!inProcessSection) continue;
    if (!line.trim()) continue;

    // top -b 格式：PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND
    const parts = line.trim().split(/\s+/);
    if (parts.length < 12) continue;
    const pid = parseInt(parts[0], 10);
    const cpu = parseFloat(parts[8]);
    const res = parts[5];
    const cmd = parts.slice(11).join(" ");

    let rssMb = 0;
    if (res.endsWith("g")) rssMb = Math.round(parseFloat(res) * 1024 * 1024);
    else if (res.endsWith("m")) rssMb = Math.round(parseFloat(res) * 1024);
    else if (res.endsWith("k")) rssMb = Math.round(parseFloat(res) / 1024);
    else rssMb = Math.round(parseFloat(res) / 1024);

    topProcesses.push({ pid, cmd, cpu_percent: cpu, rss_mb: rssMb });
    if (topProcesses.length >= topN) break;
  }

  return { success: true, usage_percent: usagePercent, top_processes: topProcesses };
}

// ----------------------------------------------------------------------------
// Memory
// ----------------------------------------------------------------------------

export async function getMemoryInfo(pid?: number): Promise<{
  success: boolean;
  total_mb: number;
  used_mb: number;
  available_mb: number;
  oom_history: string;
  process_detail?: { pid: number; rss_mb: number; vm_size_mb: number };
  error?: string;
}> {
  const freeResult = await run("free", ["-m"], 8000);
  const dmesgResult = await run("sh", ["-c", "dmesg 2>/dev/null | grep -i 'out of memory\\|oom' | tail -n 10 || true"], 8000);

  if (!freeResult.success) {
    return { success: false, total_mb: 0, used_mb: 0, available_mb: 0, oom_history: "", error: freeResult.error };
  }

  let totalMb = 0, usedMb = 0, availableMb = 0;
  for (const line of freeResult.stdout.split("\n")) {
    const m = line.match(/^Mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (m) {
      totalMb = parseInt(m[1], 10);
      usedMb = parseInt(m[2], 10);
      availableMb = parseInt(m[6], 10);
      break;
    }
  }

  let processDetail;
  if (pid) {
    const statusResult = await run("cat", [`/proc/${pid}/status`], 5000);
    const rss = statusResult.stdout.match(/VmRSS:\s+(\d+)\s+kB/)?.[1];
    const vmSize = statusResult.stdout.match(/VmSize:\s+(\d+)\s+kB/)?.[1];
    processDetail = {
      pid,
      rss_mb: rss ? Math.round(Number(rss) / 1024) : 0,
      vm_size_mb: vmSize ? Math.round(Number(vmSize) / 1024) : 0,
    };
  }

  return {
    success: true,
    total_mb: totalMb,
    used_mb: usedMb,
    available_mb: availableMb,
    oom_history: dmesgResult.stdout || "(无 OOM Killer 触发记录)",
    process_detail: processDetail,
  };
}

// ----------------------------------------------------------------------------
// Disk
// ----------------------------------------------------------------------------

export async function getDiskUsage(): Promise<{
  success: boolean;
  disks: { filesystem: string; size_mb: number; used_mb: number; available_mb: number; use_percent: number; mounted_on: string }[];
  error?: string;
}> {
  const result = await run("df", ["-B1M"], 8000);
  if (!result.success) return { success: false, disks: [], error: result.error };

  const disks: { filesystem: string; size_mb: number; used_mb: number; available_mb: number; use_percent: number; mounted_on: string }[] = [];
  const lines = result.stdout.split("\n").slice(1);

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, size, used, available, usePercent, ...mountedParts] = parts;
    disks.push({
      filesystem,
      size_mb: parseInt(size, 10),
      used_mb: parseInt(used, 10),
      available_mb: parseInt(available, 10),
      use_percent: parseInt(usePercent.replace("%", ""), 10),
      mounted_on: mountedParts.join(" "),
    });
  }

  return { success: true, disks };
}

// ----------------------------------------------------------------------------
// Network
// ----------------------------------------------------------------------------

export async function getNetworkStats(iface?: string): Promise<{
  success: boolean;
  total_connections: number;
  tcp_established: number;
  tcp_time_wait: number;
  interfaces: { name: string; rx_bytes: number; tx_bytes: number; rx_errors: number; tx_errors: number }[];
  error?: string;
}> {
  const ssResult = await run("ss", ["-s"], 8000);
  let totalConnections = 0;
  let tcpEstablished = 0;
  let tcpTimeWait = 0;

  if (ssResult.success) {
    for (const line of ssResult.stdout.split("\n")) {
      const totalMatch = line.match(/TCP:\s+(\d+)/);
      if (totalMatch) totalConnections = parseInt(totalMatch[1], 10);
      const estMatch = line.match(/(\d+)\s+estab/);
      if (estMatch) tcpEstablished = parseInt(estMatch[1], 10);
      const twMatch = line.match(/(\d+)\s+timewait/);
      if (twMatch) tcpTimeWait = parseInt(twMatch[1], 10);
    }
  }

  const interfaces: { name: string; rx_bytes: number; tx_bytes: number; rx_errors: number; tx_errors: number }[] = [];
  try {
    const netDev = fs.readFileSync("/proc/net/dev", "utf8");
    for (const line of netDev.split("\n").slice(2)) {
      const parts = line.trim().split(/\s*:\s*/);
      if (parts.length < 2) continue;
      const name = parts[0].trim();
      if (name === "lo") continue;
      if (iface && name !== iface) continue;
      const stats = parts[1].trim().split(/\s+/).map(Number);
      interfaces.push({
        name,
        rx_bytes: stats[0],
        rx_errors: stats[2],
        tx_bytes: stats[8],
        tx_errors: stats[10],
      });
    }
  } catch {
    // /proc/net/dev 读取失败不影响主流程
  }

  return { success: true, total_connections: totalConnections, tcp_established: tcpEstablished, tcp_time_wait: tcpTimeWait, interfaces };
}

// ----------------------------------------------------------------------------
// Process
// ----------------------------------------------------------------------------

export async function getProcessInfo(namePattern: string): Promise<{
  success: boolean;
  processes: { pid: number; cmd: string; cpu_percent: number; rss_mb: number }[];
  error?: string;
}> {
  const safePattern = namePattern.replace(/[^a-zA-Z0-9_.\-]/g, "");
  const result = await run(
    "sh",
    ["-c", `ps -eo pid,rss,pcpu,etimes,cmd | grep -i '${safePattern}' | grep -v grep || true`],
    8000
  );

  const processes: { pid: number; cmd: string; cpu_percent: number; rss_mb: number }[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const pid = parseInt(parts[0], 10);
    const rss = parseInt(parts[1], 10);
    const cpu = parseFloat(parts[2]);
    const cmd = parts.slice(4).join(" ");
    processes.push({ pid, cmd, cpu_percent: cpu, rss_mb: Math.round(rss / 1024) });
  }

  return { success: true, processes };
}

// ----------------------------------------------------------------------------
// Syslog
// ----------------------------------------------------------------------------

export async function tailSyslog(lines = 20): Promise<{
  success: boolean;
  lines: string[];
  error?: string;
}> {
  let result;
  if (fs.existsSync("/var/log/syslog")) {
    result = await run("tail", ["-n", String(lines), "/var/log/syslog"], 8000);
  } else {
    result = await run("sh", ["-c", `journalctl -n ${lines} --no-pager 2>/dev/null || dmesg 2>/dev/null | tail -n ${lines} || echo '(无日志访问权限)'`], 8000);
  }

  return {
    success: result.success,
    lines: result.stdout.split("\n").filter(Boolean),
    error: result.error,
  };
}

// ----------------------------------------------------------------------------
// Service restart
// ----------------------------------------------------------------------------

const ALLOWED_SERVICES = new Set(["nginx", "docker", "containerd", "kubelet", "sshd", "cron"]);

export async function restartService(serviceName: string): Promise<RunResult> {
  if (!ALLOWED_SERVICES.has(serviceName)) {
    return { success: false, stdout: "", stderr: "", code: 1, durationMs: 0, error: `服务 ${serviceName} 不在允许重启列表中` };
  }
  return run("systemctl", ["restart", serviceName], 30000);
}

// ----------------------------------------------------------------------------
// Process kill
// ----------------------------------------------------------------------------

const ALLOWED_SIGNALS = new Set(["SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2"]);

export async function killProcess(pid: number, signal = "SIGTERM"): Promise<RunResult> {
  if (!ALLOWED_SIGNALS.has(signal)) {
    return { success: false, stdout: "", stderr: "", code: 1, durationMs: 0, error: `信号 ${signal} 不在允许列表中` };
  }
  if (pid <= 0) {
    return { success: false, stdout: "", stderr: "", code: 1, durationMs: 0, error: "pid 必须大于 0" };
  }
  return run("kill", [`-${signal}`, String(pid)], 10000);
}
