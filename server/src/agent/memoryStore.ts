// ============================================================================
// Cross-Session Memory — 会话摘要的沉淀与召回
//
// 职责：
// 1. 从 AgentSession 提取脱敏摘要并持久化到 session_memories
// 2. 按用户 query 向量召回相关历史会话摘要
// 3. 为 Agent Runner 提供 buildMemoryContext，将相关记忆注入 system prompt
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { AgentSession, SessionMemory, SessionMemoryInput } from "../types.js";
import {
  insertMemory,
  getMemory as dbGetMemory,
  getMemoryBySessionId,
  listMemories as dbListMemories,
  deleteMemory as dbDeleteMemory,
  type MemoryRow,
} from "../db/db.js";
import { createEmbedder, type Embedder, type EmbeddingVector } from "../skills/registry/embedder.js";
import { InMemoryEmbeddingStore } from "../skills/registry/store.js";
import { getSession } from "./sessionStore.js";
import { getMemoryConfig } from "../config/store.js";
import { redact } from "../gateway/redact.js";

function memoryToText(m: SessionMemory): string {
  return [
    `title: ${m.title}`,
    `summary: ${m.summary}`,
    m.tags ? `tags: ${m.tags.join(",")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function rowToMemory(row: MemoryRow): SessionMemory {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memoryToRow(m: SessionMemory, embedding?: EmbeddingVector): MemoryRow {
  return {
    id: m.id,
    session_id: m.sessionId,
    title: m.title,
    summary: m.summary,
    tags: m.tags ? JSON.stringify(m.tags) : undefined,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    embedding: embedding ? JSON.stringify(embedding) : undefined,
  };
}

class MemoryStore {
  private embedder: Embedder = createEmbedder();
  private index = new InMemoryEmbeddingStore<SessionMemory>();
  private initialized = false;

  async init(embedder?: Embedder): Promise<void> {
    if (this.initialized) return;
    this.embedder = embedder ?? createEmbedder();
    this.index.clear();

    const rows = dbListMemories();
    const memories = rows.map(rowToMemory);

    if ("fit" in this.embedder && typeof this.embedder.fit === "function") {
      this.embedder.fit(memories.map(memoryToText));
    }

    for (const m of memories) {
      const vector = await this.embedder.embed(memoryToText(m));
      this.index.add(m.id, m, vector);
    }

    this.initialized = true;
  }

  async add(input: SessionMemoryInput, embedder?: Embedder): Promise<SessionMemory> {
    await this.init(embedder);

    const now = new Date().toISOString();
    const m: SessionMemory = {
      ...input,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const text = memoryToText(m);
    const vector = await this.embedder.embed(text);
    insertMemory(memoryToRow(m, vector));
    this.index.add(m.id, m, vector);
    return m;
  }

  async search(query: string, options: { limit?: number; minScore?: number } = {}): Promise<Array<SessionMemory & { score: number }>> {
    await this.init();

    const { limit = 5, minScore = 0.01 } = options;
    const queryVector = await this.embedder.embed(query);
    const results = this.index.search(queryVector, limit, minScore);
    return results.map((r) => ({ ...r.item, score: r.score }));
  }

  list(): SessionMemory[] {
    return dbListMemories().map(rowToMemory);
  }

  get(id: string): SessionMemory | undefined {
    const row = dbGetMemory(id);
    return row ? rowToMemory(row) : undefined;
  }

  getBySessionId(sessionId: string): SessionMemory | undefined {
    const row = getMemoryBySessionId(sessionId);
    return row ? rowToMemory(row) : undefined;
  }

  delete(id: string): void {
    dbDeleteMemory(id);
    this.index.remove(id);
  }

  reset(): void {
    this.index.clear();
    this.initialized = false;
  }
}

const globalStore = new MemoryStore();

export async function initMemoryStore(embedder?: Embedder): Promise<void> {
  await globalStore.init(embedder);
}

export async function addMemory(input: SessionMemoryInput, embedder?: Embedder): Promise<SessionMemory> {
  return globalStore.add(input, embedder);
}

export async function searchMemories(
  query: string,
  options?: { limit?: number; minScore?: number }
): Promise<Array<SessionMemory & { score: number }>> {
  return globalStore.search(query, options);
}

export function listMemories(): SessionMemory[] {
  return globalStore.list();
}

export function getMemory(id: string): SessionMemory | undefined {
  return globalStore.get(id);
}

export function deleteMemory(id: string): void {
  globalStore.delete(id);
}

export function resetMemoryStore(): void {
  globalStore.reset();
}

/** 从会话状态提取一段供长期记忆的脱敏摘要 */
export function extractMemorySummary(session: AgentSession): string {
  const toolNames = session.executedToolCalls
    .map((t) => `${t.skill}.${t.tool}`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  const parts = [
    `主题: ${session.title}`,
    session.incidentSummary ? `现象: ${session.incidentSummary}` : "",
    session.rootCause?.summary ? `根因: ${session.rootCause.summary}` : "",
    session.remediation?.summary ? `方案: ${session.remediation.summary}` : "",
    toolNames ? `使用工具: ${toolNames}` : "",
  ].filter(Boolean);

  return redact(parts.join("\n"));
}

/** 会话结束时调用：按配置决定是否沉淀记忆 */
export async function extractAndStoreSessionMemory(sessionId: string): Promise<void> {
  const cfg = getMemoryConfig();
  if (!cfg.enabled) return;

  const existing = globalStore.getBySessionId(sessionId);
  if (existing) return;

  const session = getSession(sessionId);
  if (!session) return;
  if (!session.incidentSummary && !session.rootCause && session.executedToolCalls.length === 0) {
    return;
  }

  await addMemory({
    sessionId,
    title: session.title,
    summary: extractMemorySummary(session),
    tags: ["auto_extracted"],
  });
}

/** 为新会话构建跨会话记忆上下文片段 */
export async function buildMemoryContext(query: string): Promise<string> {
  const cfg = getMemoryConfig();
  if (!cfg.enabled || cfg.recallTopK <= 0) return "";

  const memories = await searchMemories(query, { limit: cfg.recallTopK });
  if (memories.length === 0) return "";

  const lines = memories.map(
    (m) => `- memory_id=${m.id} [相似度 ${m.score.toFixed(3)}] ${m.title}\n  摘要: ${m.summary}`
  );
  return `\n# 相关历史会话记忆\n${lines.join("\n")}\n`;
}
