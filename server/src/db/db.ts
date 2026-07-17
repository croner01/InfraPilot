// ============================================================================
// 数据库层 — 对应设计文档 §10.2 PostgreSQL 表设计(简化)
// Demo环境用 SQLite 替代 PostgreSQL(免部署,表结构与语义保持一致,生产环境
// 可直接迁移到 Postgres,只需替换driver)。
// ============================================================================

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "infrapilot.sqlite");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  caller_agent TEXT NOT NULL,
  skill TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_id TEXT,
  approved_by TEXT,
  success INTEGER NOT NULL,
  result_summary TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  diff_preview TEXT,
  decision TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS incident_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  root_cause_summary TEXT NOT NULL,
  root_cause_category TEXT,
  resolution_steps TEXT,
  created_at TEXT NOT NULL
);
`);

export interface AuditRow {
  id: string;
  sessionId: string;
  callerAgent: string;
  skill: string;
  tool: string;
  args: string;
  riskLevel: string;
  approvalId: string | null;
  approvedBy: string | null;
  success: number;
  resultSummary: string;
  startedAt: string;
  finishedAt: string;
}

const insertAuditStmt = db.prepare(`
  INSERT INTO audit_log (id, session_id, caller_agent, skill, tool, args, risk_level, approval_id, approved_by, success, result_summary, started_at, finished_at)
  VALUES (@id, @sessionId, @callerAgent, @skill, @tool, @args, @riskLevel, @approvalId, @approvedBy, @success, @resultSummary, @startedAt, @finishedAt)
`);

export function insertAudit(row: AuditRow) {
  insertAuditStmt.run(row);
}

export function listAuditBySession(sessionId: string) {
  return db.prepare(`SELECT * FROM audit_log WHERE session_id = ? ORDER BY started_at ASC`).all(sessionId);
}

export function upsertSession(id: string, title: string, status: string, stateJson: string) {
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(id);
  if (existing) {
    db.prepare(`UPDATE sessions SET title=?, status=?, state_json=?, updated_at=? WHERE id=?`).run(title, status, stateJson, now, id);
  } else {
    db.prepare(`INSERT INTO sessions (id, title, status, state_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run(
      id, title, status, stateJson, now, now
    );
  }
}

export function getSession(id: string): { state_json: string } | undefined {
  return db.prepare(`SELECT state_json FROM sessions WHERE id = ?`).get(id) as any;
}

export function listSessions() {
  return db.prepare(`SELECT id, title, status, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50`).all();
}

export function insertApproval(row: {
  id: string; sessionId: string; skill: string; tool: string; args: string; riskLevel: string; diffPreview: string;
}) {
  db.prepare(`
    INSERT INTO approvals (id, session_id, skill, tool, args, risk_level, diff_preview, decision, requested_at)
    VALUES (?,?,?,?,?,?,?, 'pending', ?)
  `).run(row.id, row.sessionId, row.skill, row.tool, row.args, row.riskLevel, row.diffPreview, new Date().toISOString());
}

export function decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string) {
  db.prepare(`UPDATE approvals SET decision=?, decided_at=?, decided_by=? WHERE id=?`).run(
    decision, new Date().toISOString(), decidedBy, id
  );
}

export function getApproval(id: string) {
  return db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any;
}

export function insertCase(row: { id: string; title: string; rootCauseSummary: string; rootCauseCategory: string; resolutionSteps: string }) {
  db.prepare(`
    INSERT INTO incident_cases (id, title, root_cause_summary, root_cause_category, resolution_steps, created_at)
    VALUES (?,?,?,?,?,?)
  `).run(row.id, row.title, row.rootCauseSummary, row.rootCauseCategory, row.resolutionSteps, new Date().toISOString());
}

export function listCases() {
  return db.prepare(`SELECT * FROM incident_cases ORDER BY created_at DESC LIMIT 20`).all();
}
