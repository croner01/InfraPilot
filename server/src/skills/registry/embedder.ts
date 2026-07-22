// ============================================================================
// Embedder — 文本向量化
//
// 提供本地 TF-IDF 与可插拔 LLM embedding 两种策略：
// - 默认 local：无需网络，基于词频的稀疏向量，适合工具描述这种短文本
// - openai：通过 OpenAI embeddings API 生成稠密向量（需配置 API key）
//
// 后续 Knowledge Skill 可直接复用此模块。
// ============================================================================

import { openai } from "../../llm/client.js";

export type EmbeddingProvider = "local" | "openai";

export interface EmbeddingVector {
  type: "sparse" | "dense";
  // sparse: key -> weight；dense: 数组索引 -> weight
  weights: Record<string, number>;
}

export interface Embedder {
  embed(text: string): Promise<EmbeddingVector> | EmbeddingVector;
}

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "等", "及", "对", "为", "有", "从", "到", "中", "可",
  "请", "需", "要", "会", "能", "将", "并", "被", "把", "给", "向", "上", "下", "之", "后", "前",
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
  "does", "did", "will", "would", "could", "should", "may", "might", "can", "to", "of", "in", "for",
  "on", "at", "by", "with", "from", "as", "and", "or", "not", "this", "that", "these", "those",
]);

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  // 英文/数字/下划线连续片段
  const asciiTokens = normalized.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...asciiTokens);

  // 中文字符：逐字 + 相邻两字组合（简单 bigram）
  const chineseChars = normalized.match(/[\u4e00-\u9fa5]/g) ?? [];
  tokens.push(...chineseChars);
  for (let i = 0; i < chineseChars.length - 1; i++) {
    tokens.push(chineseChars[i] + chineseChars[i + 1]);
  }

  return tokens.filter((t) => t.length > 1 || /[\u4e00-\u9fa5]/.test(t)).filter(
    (t) => !STOPWORDS.has(t)
  );
}

export class TfidfEmbedder implements Embedder {
  private documentCount = 0;
  private termDocumentCount: Map<string, number> = new Map();
  private documents: string[][] = [];

  fit(corpus: string[]): void {
    this.documentCount = corpus.length;
    this.termDocumentCount.clear();
    this.documents = corpus.map(tokenize);

    for (const doc of this.documents) {
      const seen = new Set(doc);
      for (const term of seen) {
        this.termDocumentCount.set(term, (this.termDocumentCount.get(term) ?? 0) + 1);
      }
    }
  }

  embed(text: string): EmbeddingVector {
    const tokens = tokenize(text);
    const tf: Record<string, number> = {};
    for (const t of tokens) {
      tf[t] = (tf[t] ?? 0) + 1;
    }

    const weights: Record<string, number> = {};
    for (const [term, count] of Object.entries(tf)) {
      const idf = Math.log(
        (this.documentCount + 1) / ((this.termDocumentCount.get(term) ?? 0) + 1)
      ) + 1;
      weights[term] = count * idf;
    }

    return { type: "sparse", weights };
  }
}

export class OpenAIEmbedder implements Embedder {
  private model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

  async embed(text: string): Promise<EmbeddingVector> {
    const res = await openai.embeddings.create({
      model: this.model,
      input: text.slice(0, 8000),
    });
    const vector = res.data[0].embedding;
    const weights: Record<string, number> = {};
    vector.forEach((v, i) => {
      weights[String(i)] = v;
    });
    return { type: "dense", weights };
  }
}

export function createEmbedder(provider?: EmbeddingProvider): Embedder {
  const p = provider ?? (process.env.EMBEDDING_PROVIDER as EmbeddingProvider) ?? "local";
  if (p === "openai") return new OpenAIEmbedder();
  return new TfidfEmbedder();
}
