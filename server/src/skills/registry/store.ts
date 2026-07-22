// ============================================================================
// Embedding Store — 向量存储与相似度搜索
//
// 通用接口，当前为内存实现；后续可替换为 SQLite/Vector DB/Redis。
// Knowledge Skill 可直接复用此接口存储 KnowledgeCase。
// ============================================================================

import type { EmbeddingVector } from "./embedder.js";

export interface SearchResult<T> {
  item: T;
  score: number;
}

export interface EmbeddingStore<T> {
  add(id: string, item: T, vector: EmbeddingVector): void;
  search(query: EmbeddingVector, topK: number, minScore?: number): SearchResult<T>[];
  clear(): void;
}

function normalizeSparse(weights: Record<string, number>): Record<string, number> {
  const norm = Math.sqrt(Object.values(weights).reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return weights;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    out[k] = v / norm;
  }
  return out;
}

function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const na = normalizeSparse(a.weights);
  const nb = normalizeSparse(b.weights);

  let dot = 0;
  for (const [term, weight] of Object.entries(na)) {
    if (term in nb) {
      dot += weight * nb[term];
    }
  }

  return dot;
}

export class InMemoryEmbeddingStore<T> implements EmbeddingStore<T> {
  private entries: Array<{ id: string; item: T; vector: EmbeddingVector }> = [];

  add(id: string, item: T, vector: EmbeddingVector): void {
    this.entries.push({ id, item, vector });
  }

  search(query: EmbeddingVector, topK: number, minScore = 0): SearchResult<T>[] {
    const scored = this.entries.map((e) => ({
      item: e.item,
      score: cosineSimilarity(query, e.vector),
    }));

    return scored
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  clear(): void {
    this.entries = [];
  }
}
