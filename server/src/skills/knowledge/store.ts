// ============================================================================
// Knowledge Store — 案例持久化与 RAG 向量索引
//
// 职责：
// 1. 从 SQLite 加载历史 incident 案例
// 2. 复用 embedder/store 抽象建立语义索引
// 3. 提供 add/search/get 接口供 Knowledge Skill 使用
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import type { KnowledgeCase, KnowledgeCaseInput } from "../../types.js";
import { listCases, insertCase, getCase, deleteCase, type CaseRow } from "../../db/db.js";
import { createEmbedder, type Embedder, type EmbeddingVector } from "../registry/embedder.js";
import { InMemoryEmbeddingStore } from "../registry/store.js";

function caseToText(c: KnowledgeCase): string {
  return [
    `title: ${c.title}`,
    `problem_type: ${c.problemType}`,
    `severity: ${c.severity}`,
    `summary: ${c.summary}`,
    `root_causes: ${c.rootCauses.join("\n")}`,
    `solutions: ${c.solutions.join("\n")}`,
    c.serviceName ? `service: ${c.serviceName}` : "",
    c.tags ? `tags: ${c.tags.join(",")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function rowToCase(row: CaseRow): KnowledgeCase {
  return {
    id: row.id,
    title: row.title,
    problemType: row.problem_type ?? "",
    severity: (row.severity as KnowledgeCase["severity"]) ?? "p3",
    summary: row.root_cause_summary,
    rootCauses: row.root_cause_category ? JSON.parse(row.root_cause_category) : [],
    solutions: row.resolution_steps ? JSON.parse(row.resolution_steps) : [],
    tags: row.tags ? JSON.parse(row.tags) : [],
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    resolved: true,
  };
}

function caseToRow(c: KnowledgeCase, embedding?: EmbeddingVector): CaseRow {
  return {
    id: c.id,
    title: c.title,
    root_cause_summary: c.summary,
    root_cause_category: JSON.stringify(c.rootCauses),
    resolution_steps: JSON.stringify(c.solutions),
    created_at: c.createdAt,
    problem_type: c.problemType,
    severity: c.severity,
    solutions: JSON.stringify(c.solutions),
    tags: JSON.stringify(c.tags ?? []),
    source_session_id: c.sourceSessionId,
    embedding: embedding ? JSON.stringify(embedding) : undefined,
  };
}

class KnowledgeStore {
  private embedder: Embedder = createEmbedder();
  private index = new InMemoryEmbeddingStore<KnowledgeCase>();
  private initialized = false;

  async init(embedder?: Embedder): Promise<void> {
    if (this.initialized) return;
    this.embedder = embedder ?? createEmbedder();
    this.index.clear();

    const rows = listCases();
    const cases = rows.map(rowToCase);

    // TF-IDF 需要先 fit 整个语料
    if ("fit" in this.embedder && typeof this.embedder.fit === "function") {
      this.embedder.fit(cases.map(caseToText));
    }

    for (const c of cases) {
      const vector = await this.embedder.embed(caseToText(c));
      this.index.add(c.id, c, vector);
    }

    this.initialized = true;
  }

  async add(input: KnowledgeCaseInput, embedder?: Embedder): Promise<KnowledgeCase> {
    await this.init(embedder);

    const c: KnowledgeCase = {
      ...input,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      resolved: true,
    };

    const text = caseToText(c);
    const vector = await this.embedder.embed(text);
    insertCase(caseToRow(c, vector));
    this.index.add(c.id, c, vector);
    return c;
  }

  async search(options: {
    query: string;
    problemType?: string;
    serviceName?: string;
    limit?: number;
    minScore?: number;
  }): Promise<Array<KnowledgeCase & { score: number }>> {
    await this.init();

    const { query, problemType, serviceName, limit = 5, minScore = 0.01 } = options;
    const queryVector = await this.embedder.embed(query);
    const results = this.index.search(queryVector, limit * 4, minScore);

    const filtered = results.filter((r) => {
      const c = r.item;
      if (problemType && c.problemType !== problemType) return false;
      if (serviceName && c.serviceName !== serviceName) return false;
      return true;
    });

    return filtered.slice(0, limit).map((r) => ({ ...r.item, score: r.score }));
  }

  get(id: string): KnowledgeCase | undefined {
    const row = getCase(id);
    return row ? rowToCase(row) : undefined;
  }

  all(): KnowledgeCase[] {
    return listCases().map(rowToCase);
  }

  /** 删除案例：先删库，再从向量索引摘掉，避免搜索结果里留下已删案例 */
  remove(id: string): boolean {
    if (!deleteCase(id)) return false;
    this.index.remove(id);
    return true;
  }

  reset(): void {
    this.index.clear();
    this.initialized = false;
  }
}

const globalStore = new KnowledgeStore();

export async function initKnowledgeStore(embedder?: Embedder): Promise<void> {
  await globalStore.init(embedder);
}

export async function addKnowledgeCase(
  input: KnowledgeCaseInput,
  embedder?: Embedder
): Promise<KnowledgeCase> {
  return globalStore.add(input, embedder);
}

export async function searchKnowledgeCases(options: {
  query: string;
  problemType?: string;
  serviceName?: string;
  limit?: number;
  minScore?: number;
}): Promise<Array<KnowledgeCase & { score: number }>> {
  return globalStore.search(options);
}

export function getKnowledgeCase(id: string): KnowledgeCase | undefined {
  return globalStore.get(id);
}

export function listKnowledgeCases(): KnowledgeCase[] {
  return globalStore.all();
}

export function deleteKnowledgeCase(id: string): boolean {
  return globalStore.remove(id);
}

// 测试用
export function resetKnowledgeStore(): void {
  globalStore.reset();
}
