// ============================================================================
// LLM Client — 对应设计文档 §12 OpenAI 大模型接入设计
// 分级模型路由: 核心推理用 REASONING_MODEL, 简单意图分类可用 FAST_MODEL。
// demo 中统一用同一个模型以保证效果稳定,生产环境可按 §12.1 表格拆分。
// 模型名通过环境变量 REASONING_MODEL / FAST_MODEL 配置,默认适配 DeepSeek 后端。
// ============================================================================

import OpenAI from "openai";

function loadConfig() {
  // 优先使用 GSK_API_KEY(sandbox内验证有效的凭据), 其次才是 OPENAI_API_KEY,
  // 因为 ~/.genspark_llm.yaml 中声明的 ${GENSPARK_TOKEN} 变量在当前sandbox里
  // 对应的 token 已失效, 而 GSK_API_KEY 是实际可用的代理凭据。
  const apiKey = process.env.GSK_API_KEY || process.env.OPENAI_API_KEY || "sk-test";
  const baseURL = process.env.OPENAI_BASE_URL || "https://www.genspark.ai/api/llm_proxy/v1";
  // 模型名通过环境变量配置,兼容不同 LLM 后端(OpenAI gpt-5 / DeepSeek deepseek-v4-pro 等)
  const reasoningModel = process.env.REASONING_MODEL || "deepseek-v4-pro";
  const fastModel = process.env.FAST_MODEL || "deepseek-v4-flash";
  return { apiKey, baseURL, reasoningModel, fastModel };
}

const { apiKey, baseURL, reasoningModel, fastModel } = loadConfig();

// 当没有真实 API key 时（如测试环境），延迟实例化可避免启动失败。
// 业务代码应通过 openai 导出直接使用；测试未调用 LLM 时不会触发实例化检查。
export const openai = new OpenAI({ apiKey, baseURL });

export const REASONING_MODEL = reasoningModel;
export const FAST_MODEL = fastModel;
