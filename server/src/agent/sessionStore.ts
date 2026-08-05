// ============================================================================
// Session Store — 会话状态管理 + 时间线事件广播
// 对应设计文档 §3.3 AgentState / §13.4 Checkpoint持久化(demo简化为内存+SQLite)
//
// 审批状态已完全持久化到 SQLite approvals 表，不再使用内存 Promise resolver。
// 审批到达后由 /approve 接口写入数据库并触发 resumeAgentTurn。
// ============================================================================

import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import { AgentSession, TimelineEvent, TimelineEventType } from "../types.js";
import { upsertSession, getSession as dbGetSession, listSessions as dbListSessions, insertTimelineEvent } from "../db/db.js";

const sessions = new Map<string, AgentSession>();
export const bus = new EventEmitter();
bus.setMaxListeners(200);

export function createSession(title: string): AgentSession {
  const session: AgentSession = {
    id: uuidv4(),
    title,
    status: "intake",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: [],
    evidence: [],
    pendingToolCalls: [],
    executedToolCalls: [],
    iteration: 0,
    maxIterations: 12,
  };
  sessions.set(session.id, session);
  persist(session);
  emitEvent(session.id, "session_created", { title });
  return session;
}

export function getSession(id: string): AgentSession | undefined {
  if (sessions.has(id)) return sessions.get(id);
  const row = dbGetSession(id);
  if (row) {
    const parsed = JSON.parse(row.state_json) as AgentSession;
    sessions.set(id, parsed);
    return parsed;
  }
  return undefined;
}

export function listSessionSummaries() {
  return dbListSessions();
}

export function updateSession(id: string, mutator: (s: AgentSession) => void) {
  const session = getSession(id);
  if (!session) throw new Error(`session ${id} not found`);
  mutator(session);
  session.updatedAt = new Date().toISOString();
  persist(session);
  return session;
}

export function terminateSession(id: string): AgentSession | undefined {
  const session = getSession(id);
  if (!session) return undefined;
  session.status = "closed";
  session.updatedAt = new Date().toISOString();
  persist(session);
  return session;
}

export function updateSessionTitle(id: string, title: string): AgentSession | undefined {
  const session = getSession(id);
  if (!session) return undefined;
  session.title = title || session.title;
  session.updatedAt = new Date().toISOString();
  persist(session);
  return session;
}

function persist(session: AgentSession) {
  upsertSession(session.id, session.title, session.status, JSON.stringify(session));
}

export function emitEvent(sessionId: string, type: TimelineEventType, payload: unknown) {
  const event: TimelineEvent = {
    id: uuidv4(),
    sessionId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
  try {
    insertTimelineEvent({
      id: event.id,
      session_id: sessionId,
      type,
      payload: JSON.stringify(payload),
      timestamp: event.timestamp,
    });
  } catch (err) {
    // 事件持久化失败不应阻断实时推送
    console.error("[emitEvent] failed to persist timeline event", err);
  }
  bus.emit("event", event);
  return event;
}
