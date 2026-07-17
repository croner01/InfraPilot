// ============================================================================
// 演示工作负载: order-api (纯 JS, 作为独立子进程被 supervisor.ts fork 运行)
//
// 目的: 提供一个"真实可诊断"的故障场景 —— 该进程会逐步泄漏内存, 达到 RSS 阈值
// 后自我退出(exit code 137, 模拟 OOMKilled), 由父进程 supervisor 检测退出并
// 重启(模拟 K8s 的 CrashLoopBackOff 语义), 并把结构化 JSON 日志写入文件,
// 供 ELK Skill 的日志检索/聚类算法处理 —— 整套 Agent 诊断的是真实系统状态。
//
// Env:
//   OOM_THRESHOLD_MB  内存达到该阈值后退出(默认 200MB)
//   LEAK_RATE_MB      每个tick泄漏多少MB(默认 6MB)
//   TICK_MS           tick间隔毫秒(默认 700ms)
//   LOG_FILE          结构化日志输出文件路径
// ============================================================================

import fs from "node:fs";
import http from "node:http";

const OOM_THRESHOLD_MB = Number(process.env.OOM_THRESHOLD_MB ?? 200);
const LEAK_RATE_MB = Number(process.env.LEAK_RATE_MB ?? 6);
const TICK_MS = Number(process.env.TICK_MS ?? 700);
const LOG_FILE = process.env.LOG_FILE ?? "./order-api.log";
const PORT = Number(process.env.PORT ?? 0);

const leakBuffer = [];
const startedAt = Date.now();

function writeLog(level, message, extra = {}) {
  const line = JSON.stringify({
    "@timestamp": new Date().toISOString(),
    service: "order-api",
    level,
    message,
    pid: process.pid,
    uptime_ms: Date.now() - startedAt,
    ...extra,
  });
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // ignore
  }
}

writeLog("INFO", "order-api started", { oom_threshold_mb: OOM_THRESHOLD_MB, leak_rate_mb: LEAK_RATE_MB });

const server = http.createServer((_req, res) => {
  const mem = process.memoryUsage();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", rss_mb: Math.round(mem.rss / 1024 / 1024) }));
});
server.listen(PORT);

let tickCount = 0;
const interval = setInterval(() => {
  tickCount += 1;
  leakBuffer.push(Buffer.alloc(LEAK_RATE_MB * 1024 * 1024, 1));

  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);

  if (tickCount % 3 === 0) {
    writeLog("INFO", "handled request batch", {
      rss_mb: rssMb,
      requests_processed: tickCount * 17,
      p99_latency_ms: 40 + Math.round(rssMb / 2),
    });
  }

  if (rssMb > OOM_THRESHOLD_MB * 0.7 && rssMb <= OOM_THRESHOLD_MB * 0.85) {
    writeLog("WARN", "memory usage approaching limit", {
      rss_mb: rssMb, limit_mb: OOM_THRESHOLD_MB, gc_pressure: "high",
    });
  }

  if (rssMb >= OOM_THRESHOLD_MB) {
    writeLog("ERROR", "OutOfMemoryError: heap allocation failed, container will be killed", {
      rss_mb: rssMb, limit_mb: OOM_THRESHOLD_MB, exit_code: 137, reason: "OOMKilled",
    });
    clearInterval(interval);
    server.close();
    process.exitCode = 137;
    process.exit(137);
  }
}, TICK_MS);

process.on("SIGTERM", () => {
  writeLog("INFO", "received SIGTERM, graceful shutdown", {});
  clearInterval(interval);
  server.close(() => process.exit(0));
});
