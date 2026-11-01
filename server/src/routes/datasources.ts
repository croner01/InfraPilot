// ============================================================================
// Data Sources API — 指标（Prometheus）与数据库（只读）的运行时查询入口
//
// 前端数据源工作台通过本路由:
// - POST /api/data-sources/prom/:id/query        PromQL 瞬时查询
// - POST /api/data-sources/prom/:id/query-range  PromQL 区间查询（供图表渲染）
// - GET  /api/data-sources/prom/:id/labels/:label label 取值
// - POST /api/data-sources/db/:id/query          只读 SQL 查询（sqlite 直接执行；
//            mysql/postgres 需部署对应驱动，未安装时返回明确错误）
// ============================================================================

import { Router } from "express";
import net from "node:net";
import fs from "node:fs";
import {
  getDatabaseSystems,
  getMetricSystems,
} from "../config/store.js";
import type { DatabaseBackend, PrometheusBackend } from "../config/types.js";
import {
  promHealthCheck,
  promInstantQuery,
  promLabelValues,
  promRangeQuery,
  matrixToSeries,
} from "../skills/prometheus/client.js";

export const dataSourcesRouter = Router();

// -------------------- Prometheus --------------------

function findProm(id: string): PrometheusBackend | undefined {
  return getMetricSystems().find((b) => b.id === id && b.type === "prometheus");
}

dataSourcesRouter.get("/prom", (_req, res) => {
  res.json({ systems: getMetricSystems() });
});

dataSourcesRouter.post("/prom/:id/test", async (req, res) => {
  const backend = findProm(req.params.id);
  if (!backend) return res.status(404).json({ error: "prometheus backend not found" });
  try {
    const info = await promHealthCheck(backend);
    res.json({ ok: true, reachable: true, version: info.version ?? "unknown" });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err?.message ?? String(err) });
  }
});

dataSourcesRouter.post("/prom/:id/query", async (req, res) => {
  const backend = findProm(req.params.id);
  if (!backend) return res.status(404).json({ error: "prometheus backend not found" });
  const { query, time } = req.body ?? {};
  if (!query) return res.status(400).json({ error: "query is required" });
  try {
    const result = await promInstantQuery(backend, String(query), time ? String(time) : undefined);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message ?? String(err) });
  }
});

dataSourcesRouter.post("/prom/:id/query-range", async (req, res) => {
  const backend = findProm(req.params.id);
  if (!backend) return res.status(404).json({ error: "prometheus backend not found" });
  const { query, start, end, step } = req.body ?? {};
  if (!query) return res.status(400).json({ error: "query is required" });
  try {
    const endSec = end ? String(Math.floor(new Date(end).getTime() / 1000)) : String(Math.floor(Date.now() / 1000));
    const startSec = start
      ? String(Math.floor(new Date(start).getTime() / 1000))
      : String(Number(endSec) - 3600);
    const result = await promRangeQuery(backend, String(query), startSec, endSec, String(step ?? "1m"));
    res.json({ ok: true, result, series: matrixToSeries(result) });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message ?? String(err) });
  }
});

dataSourcesRouter.get("/prom/:id/labels/:label", async (req, res) => {
  const backend = findProm(req.params.id);
  if (!backend) return res.status(404).json({ error: "prometheus backend not found" });
  try {
    const values = await promLabelValues(backend, req.params.label);
    res.json({ ok: true, values });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message ?? String(err) });
  }
});

// -------------------- Database (只读查询) --------------------

const READONLY_SQL_PREFIX = /^(select|explain|show|describe|desc|pragma|with)\b/i;

function findDb(id: string): DatabaseBackend | undefined {
  return getDatabaseSystems().find((b) => b.id === id && b.type === "database");
}

dataSourcesRouter.get("/db", (_req, res) => {
  res.json({ systems: getDatabaseSystems() });
});

/** mysql/postgres 无驱动时的可达性探测：纯 TCP 握手 */
function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接超时 (${host}:${port})`));
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

dataSourcesRouter.post("/db/:id/test", async (req, res) => {
  const db = findDb(req.params.id);
  if (!db) return res.status(404).json({ error: "database backend not found" });
  try {
    if (db.dialect === "sqlite") {
      if (!fs.existsSync(db.host)) {
        return res.json({ ok: true, reachable: false, error: `sqlite 文件不存在: ${db.host}` });
      }
      return res.json({ ok: true, reachable: true });
    }
    await tcpProbe(db.host, db.port ?? (db.dialect === "mysql" ? 3306 : 5432));
    return res.json({ ok: true, reachable: true });
  } catch (err: any) {
    return res.json({ ok: true, reachable: false, error: err?.message ?? String(err) });
  }
});

dataSourcesRouter.post("/db/:id/query", async (req, res) => {
  const db = findDb(req.params.id);
  if (!db) return res.status(404).json({ error: "database backend not found" });
  const sql = String(req.body?.sql ?? "").trim();
  if (!sql) return res.status(400).json({ error: "sql is required" });
  if ((db.readonly ?? true) && !READONLY_SQL_PREFIX.test(sql)) {
    return res.status(403).json({ error: "只读模式：仅允许 SELECT / EXPLAIN / SHOW / DESCRIBE / PRAGMA / WITH 查询" });
  }
  const maxRows = Math.min(Math.max(db.maxRows ?? 200, 1), 1000);

  try {
    if (db.dialect === "sqlite") {
      const { default: Database } = await import("better-sqlite3");
      if (!fs.existsSync(db.host)) {
        return res.json({ ok: false, error: `sqlite 文件不存在: ${db.host}` });
      }
      const conn = new Database(db.host, { readonly: true, fileMustExist: true });
      try {
        const isSelect = READONLY_SQL_PREFIX.test(sql);
        if (!isSelect) {
          return res.status(403).json({ error: "只读连接：仅允许查询语句" });
        }
        const stmt = conn.prepare(sql);
        const rows = stmt.all();
        const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
        return res.json({ ok: true, columns, rows: rows.slice(0, maxRows), total: rows.length, truncated: rows.length > maxRows });
      } finally {
        conn.close();
      }
    }

    // mysql / postgres：本项目未内置驱动，探测可达性后给出明确接入指引
    await tcpProbe(db.host, db.port ?? (db.dialect === "mysql" ? 3306 : 5432));
    res.json({
      ok: false,
      reachable: true,
      error: `服务端未安装 ${db.dialect} 驱动。请在 server 目录安装依赖后重启：npm install ${db.dialect === "mysql" ? "mysql2" : "pg"}`,
    });
  } catch (err: any) {
    res.json({ ok: false, error: err?.message ?? String(err) });
  }
});
