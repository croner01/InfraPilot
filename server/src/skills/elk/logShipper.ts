// ============================================================================
// 日志采集管道 —— 真实 K8s Pod 日志 -> 真实 OpenSearch 索引
//
// 数据源: containerd CRI 落盘到 /var/log/pods/<namespace>_<pod>_<uid>/<container>/*.log
// 的真实容器标准输出日志(格式: "<RFC3339时间戳> <stream> <F|P> <内容>")。
// order-api 演示工作负载已部署为真实 K8s Deployment(见 server/k8s-manifests/),
// 其日志由本模块 tail 后解析并批量写入 OpenSearch order-api-logs-* 索引,
// 供 ELK Skill 的检索/聚合/聚类工具查询 —— 全链路无编造数据。
//
// 采用轻量 polling tail(而非 inotify), 因为 sandbox 场景数据量很小,
// 简化实现更可靠。生产环境可替换为 Filebeat/Fluent Bit + Beats 输出插件。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { Client } from "@opensearch-project/opensearch";

const OPENSEARCH_NODE = process.env.OPENSEARCH_NODE ?? "http://127.0.0.1:9200";
const INDEX_PREFIX = "order-api-logs";
const PODS_LOG_ROOT = "/var/log/pods";

export const osClient = new Client({ node: OPENSEARCH_NODE });

function todayIndex(): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${INDEX_PREFIX}-${d}`;
}

export async function ensureIndexTemplate(): Promise<void> {
  try {
    await osClient.indices.putIndexTemplate({
      name: "order-api-logs-template",
      body: {
        index_patterns: [`${INDEX_PREFIX}-*`],
        template: {
          settings: { number_of_shards: 1, number_of_replicas: 0 },
          mappings: {
            properties: {
              "@timestamp": { type: "date" },
              service: { type: "keyword" },
              level: { type: "keyword" },
              message: { type: "text" },
              pid: { type: "integer" },
              uptime_ms: { type: "long" },
              rss_mb: { type: "integer" },
              requests_processed: { type: "long" },
              p99_latency_ms: { type: "integer" },
              pod_name: { type: "keyword" },
              namespace: { type: "keyword" },
              container: { type: "keyword" },
              stream: { type: "keyword" },
            },
          },
        },
      },
    });
  } catch (err: any) {
    console.warn("[logShipper] 创建索引模板失败(可能已存在,忽略):", err?.message ?? err);
  }
}

interface ShipperState {
  filePath: string;
  offset: number;
}

/** 找到指定 namespace/pod 下所有容器日志文件的当前路径(k8s重启后uid/文件名会变化, 每次都重新扫描) */
function findPodLogFiles(namespace: string, podNamePrefix: string): string[] {
  if (!fs.existsSync(PODS_LOG_ROOT)) return [];
  const dirs = fs.readdirSync(PODS_LOG_ROOT).filter((d) => d.startsWith(`${namespace}_${podNamePrefix}`));
  const files: string[] = [];
  for (const dir of dirs) {
    const full = path.join(PODS_LOG_ROOT, dir);
    let containerDirs: string[] = [];
    try {
      containerDirs = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const c of containerDirs) {
      const cDir = path.join(full, c);
      try {
        const logFiles = fs.readdirSync(cDir).filter((f) => f.endsWith(".log"));
        for (const f of logFiles) files.push(path.join(cDir, f));
      } catch {
        // 权限或竞态问题, 跳过
      }
    }
  }
  return files;
}

function parseCriLogLine(line: string): { time: string; stream: string; content: string } | null {
  // CRI 日志格式: 2026-07-17T05:33:11.53346851Z stdout F {"level":...}
  const m = line.match(/^(\S+)\s+(stdout|stderr)\s+[FP]\s+(.*)$/);
  if (!m) return null;
  return { time: m[1], stream: m[2], content: m[3] };
}

const shipperStates = new Map<string, ShipperState>();

/**
 * 扫描并采集 order-api 全部日志文件的增量内容, 解析后批量写入 OpenSearch。
 * 每次调用只处理自上次以来新增的字节(基于文件路径+offset), 幂等安全。
 */
export async function shipOnce(namespace = "order-service", podNamePrefix = "order-api"): Promise<{ shipped: number }> {
  const files = findPodLogFiles(namespace, podNamePrefix);
  const bulkBody: unknown[] = [];
  let shipped = 0;

  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const state = shipperStates.get(filePath) ?? { filePath, offset: 0 };
    if (stat.size < state.offset) {
      // 文件被截断/轮转, 从头重读
      state.offset = 0;
    }
    if (stat.size === state.offset) {
      continue; // 无新增内容
    }

    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - state.offset);
    fs.readSync(fd, buf, 0, buf.length, state.offset);
    fs.closeSync(fd);
    state.offset = stat.size;
    shipperStates.set(filePath, state);

    const containerName = path.basename(path.dirname(filePath));
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = parseCriLogLine(line);
      if (!parsed) continue;
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(parsed.content);
      } catch {
        // 非 JSON 行(如启动banner等), 仍以纯文本形式索引, 保证不丢日志
        doc = { message: parsed.content, level: "INFO" };
      }
      doc["@timestamp"] = doc["@timestamp"] ?? parsed.time;
      doc.pod_name = podNamePrefix;
      doc.namespace = namespace;
      doc.container = containerName;
      doc.stream = parsed.stream;

      bulkBody.push({ index: { _index: todayIndex() } });
      bulkBody.push(doc);
      shipped += 1;
    }
  }

  if (bulkBody.length > 0) {
    await osClient.bulk({ body: bulkBody as Record<string, unknown>[] });
  }
  return { shipped };
}

let shipperTimer: NodeJS.Timeout | undefined;

export function startLogShipper(intervalMs = 2000): void {
  if (shipperTimer) return;
  ensureIndexTemplate().catch((e) => console.warn("[logShipper] index template init 失败:", e?.message ?? e));
  shipperTimer = setInterval(() => {
    shipOnce().catch((e) => console.warn("[logShipper] 采集失败:", e?.message ?? e));
  }, intervalMs);
}

export function stopLogShipper(): void {
  if (shipperTimer) {
    clearInterval(shipperTimer);
    shipperTimer = undefined;
  }
}
