// ============================================================================
// LLM Client — 对应设计文档 §12 OpenAI 大模型接入设计
//
// 支持运行时从 RuntimeConfig 读取 LLM Provider 配置并热更新。
// 分级模型路由: 核心推理用 reasoning model, 简单意图分类可用 fast model。
// 默认 Provider 从 config store 读取；无配置时回退到环境变量。
// ============================================================================

import OpenAI from "openai";
import { getDefaultLlmProvider } from "../config/store.js";

function loadEnvConfig() {
  const apiKey = process.env.GSK_API_KEY || process.env.OPENAI_API_KEY || "sk-test";
  const baseURL = process.env.OPENAI_BASE_URL || "https://www.genspark.ai/api/llm_proxy/v1";
  const reasoningModel = process.env.REASONING_MODEL || "deepseek-v4-pro";
  const fastModel = process.env.FAST_MODEL || "deepseek-v4-flash";
  return { apiKey, baseURL, reasoningModel, fastModel };
}

function createClient(): OpenAI {
  const provider = getDefaultLlmProvider();
  if (provider) {
    const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv ?? ""] ?? loadEnvConfig().apiKey;
    return new OpenAI({ apiKey, baseURL: provider.baseURL });
  }
  const { apiKey, baseURL } = loadEnvConfig();
  return new OpenAI({ apiKey, baseURL });
}

/**
 * 保持向后兼容：每次访问 openai 时，根据当前默认 Provider 创建 Client。
 * 这样 RuntimeConfig 更新后，下次 LLM 调用会自动使用新配置。
 */
export const openai = new Proxy({} as OpenAI, {
  get(_, prop: string | symbol) {
    const client = createClient();
    return (client as any)[prop];
  },
});

export function getReasoningModel(): string {
  const provider = getDefaultLlmProvider();
  if (provider?.recommendedModel) return provider.recommendedModel;
  return loadEnvConfig().reasoningModel;
}

export function getFastModel(): string {
  const provider = getDefaultLlmProvider();
  if (provider?.recommendedModel) return provider.recommendedModel;
  return loadEnvConfig().fastModel;
}

// 兼容旧代码中直接导入的常量写法
export const REASONING_MODEL = getReasoningModel();
export const FAST_MODEL = getFastModel();
