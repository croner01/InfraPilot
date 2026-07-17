// ============================================================================
// LLM Client — 对应设计文档 §12 OpenAI 大模型接入设计
// 分级模型路由: 核心推理用 gpt-5, 简单意图分类可用 gpt-5-mini(demo中统一用
// gpt-5以保证效果稳定,生产环境可按 §12.1 表格拆分)。
// ============================================================================

import OpenAI from "openai";

function loadConfig() {
  // 优先使用 GSK_API_KEY(sandbox内验证有效的凭据), 其次才是 OPENAI_API_KEY,
  // 因为 ~/.genspark_llm.yaml 中声明的 ${GENSPARK_TOKEN} 变量在当前sandbox里
  // 对应的 token 已失效, 而 GSK_API_KEY 是实际可用的代理凭据。
  const apiKey = process.env.GSK_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL || "https://www.genspark.ai/api/llm_proxy/v1";
  return { apiKey, baseURL };
}

const { apiKey, baseURL } = loadConfig();

export const openai = new OpenAI({ apiKey, baseURL });

export const REASONING_MODEL = "gpt-5";
export const FAST_MODEL = "gpt-5-mini";
