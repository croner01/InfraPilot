// ============================================================================
// Skill Registry — 工具注册与 RAG 检索式路由
//
// 职责：
// 1. 为所有 ToolDef 建立可嵌入文本
// 2. 构建索引（默认本地 TF-IDF，可切换 OpenAI embedding）
// 3. 按用户 query 动态召回 Top-K 工具
// 4. 提供兜底通用发现类工具，避免召回遗漏
// ============================================================================

import type { ToolDef } from "../../types.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { InMemoryEmbeddingStore, type SearchResult } from "./store.js";

export interface ToolRecallResult {
  tool: ToolDef;
  score: number;
}

const ALWAYS_AVAILABLE_TOOLS = new Set([
  // 通用发现类：任何诊断都需要先定位目标
  "linux__get_cpu_usage",
  "linux__get_memory_info",
  "linux__get_process_info",
  "k8s__list_pods",
  "k8s__describe_pod",
  "k8s__get_events",
  "elk__search_logs",
  "clickhouse__search_logs",
]);

function toolToText(tool: ToolDef): string {
  const params = Object.keys(tool.parameters.properties ?? {}).join(", ");
  return [
    `Skill: ${tool.skill}`,
    `Tool: ${tool.name}`,
    `Risk: ${tool.risk}`,
    `Description: ${tool.description}`,
    `Parameters: { ${params} }`,
  ].join("\n");
}

function toolKey(tool: ToolDef): string {
  return `${tool.skill}__${tool.name}`;
}

class SkillRegistry {
  private tools: ToolDef[] = [];
  private embedder: Embedder = createEmbedder();
  private store = new InMemoryEmbeddingStore<ToolDef>();
  private built = false;

  async build(tools: ToolDef[], embedder?: Embedder): Promise<void> {
    this.tools = tools;
    this.embedder = embedder ?? createEmbedder();
    this.store.clear();

    // TF-IDF 需要先 fit 整个语料
    if ("fit" in this.embedder && typeof this.embedder.fit === "function") {
      const corpus = tools.map(toolToText);
      this.embedder.fit(corpus);
    }

    // 等待所有 embedding 完成后再标记 built，保证 recall 立即可用
    await Promise.all(
      tools.map(async (tool) => {
        const text = toolToText(tool);
        const vector = await this.embedder.embed(text);
        this.store.add(toolKey(tool), tool, vector);
      })
    );

    this.built = true;
  }

  async recall(query: string, options: { topK?: number; minScore?: number } = {}): Promise<ToolRecallResult[]> {
    if (!this.built) {
      throw new Error("Skill Registry 尚未构建，请先调用 build()");
    }

    const { topK = 12, minScore = 0 } = options;
    const queryVector = await this.embedder.embed(query);
    const results = this.store.search(queryVector, topK, minScore);

    // 合并兜底通用工具（去重）
    const recalledKeys = new Set(results.map((r) => toolKey(r.item)));
    const alwaysAvailable: SearchResult<ToolDef>[] = [];
    for (const tool of this.tools) {
      const key = toolKey(tool);
      if (ALWAYS_AVAILABLE_TOOLS.has(key) && !recalledKeys.has(key)) {
        alwaysAvailable.push({ item: tool, score: 0 });
        recalledKeys.add(key);
      }
    }

    return [...results, ...alwaysAvailable].map((r) => ({ tool: r.item, score: r.score }));
  }

  all(): ToolDef[] {
    return this.tools;
  }

  isBuilt(): boolean {
    return this.built;
  }
}

const globalRegistry = new SkillRegistry();

export async function buildRegistry(tools: ToolDef[], embedder?: Embedder): Promise<void> {
  await globalRegistry.build(tools, embedder);
}

export async function recallTools(
  query: string,
  options?: { topK?: number; minScore?: number }
): Promise<ToolRecallResult[]> {
  return globalRegistry.recall(query, options);
}

export function getAllRegisteredTools(): ToolDef[] {
  return globalRegistry.all();
}

export function isRegistryBuilt(): boolean {
  return globalRegistry.isBuilt();
}

// 测试用：暴露内部 registry 实例
export function getRegistryForTest(): SkillRegistry {
  return globalRegistry;
}

export function resetRegistry(): void {
  globalRegistry["built"] = false;
}
