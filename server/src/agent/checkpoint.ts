// ============================================================================
// Agent Checkpoint 持久化
//
// 将运行时的 AgentCheckpoint 写入 SQLite，支持 Server 重启后恢复执行循环。
// 对应 langgraph-checkpoint-session-recovery-plan.md § 数据模型。
// ============================================================================

import type { AgentCheckpoint } from "../types.js";
import { saveCheckpoint as dbSaveCheckpoint, loadCheckpoint as dbLoadCheckpoint, deleteCheckpoint as dbDeleteCheckpoint } from "../db/db.js";

export function saveCheckpoint(checkpoint: AgentCheckpoint): void {
  dbSaveCheckpoint(checkpoint.sessionId, JSON.stringify(checkpoint));
}

export function loadCheckpoint(sessionId: string): AgentCheckpoint | undefined {
  const row = dbLoadCheckpoint(sessionId);
  if (!row) return undefined;
  try {
    return JSON.parse(row.checkpoint_json) as AgentCheckpoint;
  } catch {
    return undefined;
  }
}

export function deleteCheckpoint(sessionId: string): void {
  dbDeleteCheckpoint(sessionId);
}
