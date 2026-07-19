// ============================================================================
// 日志采集管道 —— 真实 K8s Pod 日志 -> 真实 OpenSearch 索引
//
// 数据源: containerd CRI 落盘到 /var/log/pods/<namespace>_<pod>_<uid>/<container>/*.log
// 的真实容器标准输出日志(格式: "<RFC3339时间戳> <stream> <F|P> <内容>")。
// order-api 演示工作负载已部署为真实 K8s Deployment(见 server/k8s-manifests/),
// 其日志由本模块 tail 后解析并批量写入 OpenSearch 索引,
// 供 ELK Skill 的检索/聚合/聚类工具查询 —— 全链路无编造数据。
//
// 采用轻量 polling tail(而非 inotify), 因为 sandbox 场景数据量很小,
// 简化实现更可靠。生产环境可替换为 Filebeat/Fluent Bit + Beats 输出插件。
//
// 支持多命名空间/多 Pod 前缀配置,通过环境变量 LOG_SHIP_TARGETS 注入 JSON 数组:
//   LOG_SHIP_TARGETS='[{"namespace":"order-service","podNamePrefix":"order-api","indexPrefix":"order-api-logs"}]'
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { Client } from "@opensearch-project/opensearch";

const OPENSEARCH_NODE = process.env.OPENSEARCH_NODE ?? "http://127.0.0.1:9200";
const PODS_LOG_ROOT = "/var/log/pods";

export const osClient = new Client({ node: OPENSEARCH_NODE });

export interface ShipTarget {
  namespace: string;
  podNamePrefix: string;
  indexPrefix: string;
}

/** 从环境变量读取采集目标,未配置时默认只采集 order-service/order-api */
function parseShipTargets(): ShipTarget[] {
  const env = process.env.LOG_SHIP_TARGETS;
  if (env) {
    try {
      const parsed = JSON.parse(env) as ShipTarget[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const t of parsed) {
          if (!t.namespace || !t.podNamePrefix || !t.indexPrefix) {
            throw new Error(`采集目标格式错误: ${JSON.stringify(t)}`);
          }
        }
        return parsed;
      }
    } catch (e: any) {
      console.warn("[logShipper] LOG_SHIP_TARGETS 解析失败,使用默认目标:", e?.message ?? e);
    }
  }
  return [{ namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" }];
}

export const SHIP_TARGETS = parseShipTargets();

function todayIndex(prefix: string): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${prefix}-${d}`;
}

export async function ensureIndexTemplate(prefix: string): Promise<void> {
  const templateName = `${prefix}-template`;
  try {
    await osClient.indices.putIndexTemplate({
      name: templateName,
      body: {
        index_patterns: [`${prefix}-*`],
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
    console.warn(`[logShipper] 创建索引模板 ${templateName} 失败(可能已存在,忽略):`, err?.message ?? err);
  }
}

interface ShipperState {
  filePath: string;
  offset: number;
}

/** 从 /var/log/pods/<namespace>_<pod>_<uid> 目录名中提取真实 pod 名 */
function extractPodName(dirName: string, namespace: string): string {
  // dirName 形如: order-service_order-api-6fd4898b94-dbzbn_746b16e6-d3b5-...
  const prefix = `${namespace}_`;
  if (!dirName.startsWith(prefix)) return dirName;
  const rest = dirName.slice(prefix.length);
  // 去掉尾部 _<uid>
  const lastUnderscore = rest.lastIndexOf("_");
  return lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
}

/** 找到指定 namespace/pod 下所有容器日志文件的当前路径(k8s重启后uid/文件名会变化, 每次都重新扫描) */
function findPodLogFiles(namespace: string, podNamePrefix: string): Array<{ filePath: string; podName: string; container: string }> {
  if (!fs.existsSync(PODS_LOG_ROOT)) return [];
  const dirs = fs.readdirSync(PODS_LOG_ROOT).filter((d) => d.startsWith(`${namespace}_${podNamePrefix}`));
  const files: Array<{ filePath: string; podName: string; container: string }> = [];
  for (const dir of dirs) {
    const full = path.join(PODS_LOG_ROOT, dir);
    const podName = extractPodName(dir, namespace);
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
        for (const f of logFiles) {
          files.push({ filePath: path.join(cDir, f), podName, container: c });
        }
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

function parseDockerJsonLogLine(line: string): { time: string; stream: string; content: string } | null {
  // Docker JSON 日志格式: {"log":"...\\n","stream":"stdout","time":"2026-07-18T..."}
  // 常见于 /var/lib/docker/containers/<id>/<id>-json.log 或 k3s 通过 docker shim 落盘场景
  try {
    const obj = JSON.parse(line);
    if (typeof obj.log !== "string" || typeof obj.time !== "string") return null;
    return { time: obj.time, stream: obj.stream ?? "stdout", content: obj.log.replace(/\n$/, "") };
  } catch {
    return null;
  }
}

function parseLogLine(line: string): { time: string; stream: string; content: string } | null {
  return parseCriLogLine(line) ?? parseDockerJsonLogLine(line);
}

const shipperStates = new Map<string, ShipperState>();

/**
 * 扫描并采集指定目标日志文件的增量内容, 解析后批量写入 OpenSearch。
 * 每次调用只处理自上次以来新增的字节(基于文件路径+offset), 幂等安全。
 */
export async function shipOnce(target: ShipTarget): Promise<{ target: ShipTarget; shipped: number }> {
  const files = findPodLogFiles(target.namespace, target.podNamePrefix);
  const bulkBody: unknown[] = [];
  let shipped = 0;

  for (const { filePath, podName, container } of files) {
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

    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (!parsed) continue;
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(parsed.content);
      } catch {
        // 非 JSON 行(如启动banner等), 仍以纯文本形式索引, 保证不丢日志
        doc = { message: parsed.content, level: "INFO" };
      }
      doc["@timestamp"] = doc["@timestamp"] ?? parsed.time;
      doc.pod_name = podName;
      doc.namespace = target.namespace;
      doc.container = container;
      doc.stream = parsed.stream;

      bulkBody.push({ index: { _index: todayIndex(target.indexPrefix) } });
      bulkBody.push(doc);
      shipped += 1;
    }
  }

  if (bulkBody.length > 0) {
    await osClient.bulk({ body: bulkBody as Record<string, unknown>[] });
  }
  return { target, shipped };
}

/** 顺序采集所有目标,避免并发导致 shipperStates 读写冲突 */
export async function shipAllTargets(): Promise<Array<{ target: ShipTarget; shipped: number }>> {
  const results: Array<{ target: ShipTarget; shipped: number }> = [];
  for (const target of SHIP_TARGETS) {
    try {
      const r = await shipOnce(target);
      results.push(r);
    } catch (e: any) {
      console.warn(`[logShipper] 采集 ${target.namespace}/${target.podNamePrefix} 失败:`, e?.message ?? e);
      results.push({ target, shipped: 0 });
    }
  }
  return results;
}

let shipperTimer: NodeJS.Timeout | undefined;

export function startLogShipper(intervalMs = 2000): void {
  if (shipperTimer) return;
  console.log(`[logShipper] 已配置 ${SHIP_TARGETS.length} 个采集目标:`);
  for (const t of SHIP_TARGETS) {
    console.log(`  - namespace=${t.namespace}, podPrefix=${t.podNamePrefix}, indexPrefix=${t.indexPrefix}`);
  }
  for (const t of SHIP_TARGETS) {
    ensureIndexTemplate(t.indexPrefix).catch((e) => console.warn(`[logShipper] index template ${t.indexPrefix} init 失败:`, e?.message ?? e));
  }
  shipperTimer = setInterval(() => {
    shipAllTargets().catch((e) => console.warn("[logShipper] 采集失败:", e?.message ?? e));
  }, intervalMs);
}

export function stopLogShipper(): void {
  if (shipperTimer) {
    clearInterval(shipperTimer);
    shipperTimer = undefined;
  }
}
