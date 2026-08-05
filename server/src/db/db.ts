// ============================================================================
// 数据库层 — 对应设计文档 §10.2 PostgreSQL 表设计(简化)
// Demo环境用 SQLite 替代 PostgreSQL(免部署,表结构与语义保持一致,生产环境
// 可直接迁移到 Postgres,只需替换driver)。
// ============================================================================

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// 允许通过环境变量隔离测试数据库，避免测试误删开发数据
const DATA_DIR = process.env.INFRAPILOT_DATA_DIR
  ? path.resolve(process.env.INFRAPILOT_DATA_DIR)
  : path.join(process.cwd(), "data");
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
  args_hash TEXT NOT NULL,
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
  created_at TEXT NOT NULL,
  problem_type TEXT,
  severity TEXT,
  solutions TEXT,
  tags TEXT,
  source_session_id TEXT,
  embedding TEXT
);

CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding TEXT
);
`);

function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// 迁移：为旧版 incident_cases 表补充 Knowledge Skill 所需字段
addColumnIfMissing("incident_cases", "problem_type", "TEXT");
addColumnIfMissing("incident_cases", "severity", "TEXT");
addColumnIfMissing("incident_cases", "solutions", "TEXT");
addColumnIfMissing("incident_cases", "tags", "TEXT");
addColumnIfMissing("incident_cases", "source_session_id", "TEXT");
addColumnIfMissing("incident_cases", "embedding", "TEXT");

// 迁移：为旧版 approvals 表补充 args_hash 列（任务二引入的 TOCTOU 防护）
const approvalColumns = db.pragma("table_info(approvals)") as Array<{ name: string }>;
if (!approvalColumns.some((c) => c.name === "args_hash")) {
  db.exec(`ALTER TABLE approvals ADD COLUMN args_hash TEXT NOT NULL DEFAULT ''`);
}

// 迁移：为旧版 session_memories 表补充列
addColumnIfMissing("session_memories", "tags", "TEXT");
addColumnIfMissing("session_memories", "embedding", "TEXT");

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
  id: string; sessionId: string; skill: string; tool: string; args: string; argsHash: string; riskLevel: string; diffPreview: string;
}) {
  db.prepare(`
    INSERT INTO approvals (id, session_id, skill, tool, args, args_hash, risk_level, diff_preview, decision, requested_at)
    VALUES (?,?,?,?,?,?,?,?, 'pending', ?)
  `).run(row.id, row.sessionId, row.skill, row.tool, row.args, row.argsHash, row.riskLevel, row.diffPreview, new Date().toISOString());
}

export function decideApproval(id: string, decision: "approved" | "rejected", decidedBy: string) {
  db.prepare(`UPDATE approvals SET decision=?, decided_at=?, decided_by=? WHERE id=?`).run(
    decision, new Date().toISOString(), decidedBy, id
  );
}

export interface ApprovalRow {
  id: string;
  session_id: string;
  skill: string;
  tool: string;
  args: string;
  args_hash: string;
  risk_level: string;
  diff_preview: string;
  decision: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_at?: string;
  decided_by?: string;
}

export function getApproval(id: string): ApprovalRow | undefined {
  return db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;
}

export interface CaseRow {
  id: string;
  title: string;
  root_cause_summary: string;
  root_cause_category?: string;
  resolution_steps?: string;
  created_at: string;
  problem_type?: string;
  severity?: string;
  solutions?: string;
  tags?: string;
  source_session_id?: string;
  embedding?: string;
}

export function insertCase(row: CaseRow) {
  db.prepare(`
    INSERT INTO incident_cases (
      id, title, root_cause_summary, root_cause_category, resolution_steps, created_at,
      problem_type, severity, solutions, tags, source_session_id, embedding
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.id,
    row.title,
    row.root_cause_summary,
    row.root_cause_category ?? null,
    row.resolution_steps ?? null,
    row.created_at,
    row.problem_type ?? null,
    row.severity ?? null,
    row.solutions ?? null,
    row.tags ?? null,
    row.source_session_id ?? null,
    row.embedding ?? null
  );
}

export function getCase(id: string): CaseRow | undefined {
  return db.prepare(`SELECT * FROM incident_cases WHERE id = ?`).get(id) as CaseRow | undefined;
}

export function listCases(): CaseRow[] {
  return db.prepare(`SELECT * FROM incident_cases ORDER BY created_at DESC LIMIT 200`).all() as CaseRow[];
}

// -------------------- timeline_events（会话时间线事件持久化） --------------------

export interface TimelineEventRow {
  id: string;
  session_id: string;
  type: string;
  payload: string;
  timestamp: string;
}

export function insertTimelineEvent(row: TimelineEventRow) {
  db.prepare(`
    INSERT INTO timeline_events (id, session_id, type, payload, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.session_id, row.type, row.payload, row.timestamp);
}

export function listTimelineEvents(sessionId: string): TimelineEventRow[] {
  return db.prepare(`
    SELECT * FROM timeline_events WHERE session_id = ? ORDER BY timestamp ASC
  `).all(sessionId) as TimelineEventRow[];
}

// -------------------- session_checkpoints（LangGraph Checkpoint 持久化） --------------------

export function saveCheckpoint(sessionId: string, checkpointJson: string) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO session_checkpoints (session_id, checkpoint_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at
  `).run(sessionId, checkpointJson, now);
}

export function loadCheckpoint(sessionId: string): { checkpoint_json: string } | undefined {
  return db.prepare(`SELECT checkpoint_json FROM session_checkpoints WHERE session_id = ?`).get(sessionId) as
    | { checkpoint_json: string }
    | undefined;
}

export function deleteCheckpoint(sessionId: string) {
  db.prepare(`DELETE FROM session_checkpoints WHERE session_id = ?`).run(sessionId);
}

// -------------------- session_memories（跨会话记忆） --------------------

export interface MemoryRow {
  id: string;
  session_id: string;
  title: string;
  summary: string;
  tags?: string;
  created_at: string;
  updated_at: string;
  embedding?: string;
}

export function insertMemory(row: MemoryRow) {
  db.prepare(`
    INSERT INTO session_memories (id, session_id, title, summary, tags, created_at, updated_at, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      title=excluded.title,
      summary=excluded.summary,
      tags=excluded.tags,
      updated_at=excluded.updated_at,
      embedding=excluded.embedding
  `).run(
    row.id,
    row.session_id,
    row.title,
    row.summary,
    row.tags ?? null,
    row.created_at,
    row.updated_at,
    row.embedding ?? null
  );
}

export function getMemory(id: string): MemoryRow | undefined {
  return db.prepare(`SELECT * FROM session_memories WHERE id = ?`).get(id) as MemoryRow | undefined;
}

export function getMemoryBySessionId(sessionId: string): MemoryRow | undefined {
  return db.prepare(`SELECT * FROM session_memories WHERE session_id = ?`).get(sessionId) as
    | MemoryRow
    | undefined;
}

export function listMemories(): MemoryRow[] {
  return db.prepare(`SELECT * FROM session_memories ORDER BY updated_at DESC`).all() as MemoryRow[];
}

export function deleteMemory(id: string) {
  db.prepare(`DELETE FROM session_memories WHERE id = ?`).run(id);
}

export function listAwaitingApprovalSessions(): { id: string; title: string; status: string; created_at: string; updated_at: string }[] {
  return db.prepare(`SELECT id, title, status, created_at, updated_at FROM sessions WHERE status = 'awaiting_approval' ORDER BY updated_at DESC`).all() as {
    id: string;
    title: string;
    status: string;
    created_at: string;
    updated_at: string;
  }[];
}
