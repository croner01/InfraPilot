// ============================================================================
// Knowledge Skill — 历史案例库 / SOP 检索与沉淀
//
// 提供：
// - search_similar_cases: 按故障描述语义检索相似历史案例
// - get_case: 获取指定案例详情
// - add_case: 将当前故障沉淀为知识库案例
// ============================================================================

import type { ToolDef, ToolExecutionResult, KnowledgeCaseInput } from "../../types.js";
import { initKnowledgeStore, addKnowledgeCase, searchKnowledgeCases, getKnowledgeCase } from "./store.js";

export const knowledgeTools: ToolDef[] = [
  {
    name: "search_similar_cases",
    skill: "knowledge",
    risk: "readonly",
    description:
      "根据故障描述语义检索历史相似 incident 案例，返回案例的标题、根因、解决方案和相似度分数。用于在诊断前或诊断中参考历史经验。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "故障描述、日志片段或用户问题，用于语义检索",
        },
        problem_type: {
          type: "string",
          description: "可选，按问题类型过滤，例如 OOMKilled / NoValidHost / 网络不通",
        },
        service_name: {
          type: "string",
          description: "可选，按关联服务/组件过滤",
        },
        limit: {
          type: "number",
          description: "返回案例数量，默认 5",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_case",
    skill: "knowledge",
    risk: "readonly",
    description: "根据 case_id 获取知识库中某个历史案例的完整信息。",
    parameters: {
      type: "object",
      properties: {
        case_id: { type: "string", description: "知识库案例 UUID" },
      },
      required: ["case_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_case",
    skill: "knowledge",
    risk: "medium",
    description:
      "将当前故障及其根因、解决方案沉淀到知识库，供未来相似故障检索参考。写入操作，影响可控。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "案例标题" },
        problem_type: { type: "string", description: "问题类型，例如 OOMKilled / NoValidHost" },
        severity: {
          type: "string",
          enum: ["p0", "p1", "p2", "p3"],
          description: "严重级别",
        },
        summary: { type: "string", description: "问题现象摘要" },
        root_causes: {
          type: "array",
          items: { type: "string" },
          description: "根因列表",
        },
        solutions: {
          type: "array",
          items: { type: "string" },
          description: "解决方案/SOP 步骤列表",
        },
        service_name: { type: "string", description: "关联服务/组件" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签列表",
        },
      },
      required: ["title", "problem_type", "severity", "summary", "root_causes", "solutions"],
      additionalProperties: false,
    },
  },
];

function okResult(data: unknown, durationMs: number): ToolExecutionResult {
  return { success: true, data, durationMs };
}

function errResult(error: string, durationMs: number): ToolExecutionResult {
  return { success: false, error, durationMs };
}

async function executeSearchSimilarCases(args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    await initKnowledgeStore();
    const results = await searchKnowledgeCases({
      query: String(args.query),
      problemType: args.problem_type ? String(args.problem_type) : undefined,
      serviceName: args.service_name ? String(args.service_name) : undefined,
      limit: typeof args.limit === "number" ? args.limit : 5,
    });
    return okResult(
      results.map((r) => ({
        case_id: r.id,
        title: r.title,
        problem_type: r.problemType,
        severity: r.severity,
        summary: r.summary,
        root_causes: r.rootCauses,
        solutions: r.solutions,
        service_name: r.serviceName,
        tags: r.tags,
        similarity: r.score,
      })),
      Date.now() - start
    );
  } catch (e) {
    return errResult(e instanceof Error ? e.message : String(e), Date.now() - start);
  }
}

async function executeGetCase(args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    await initKnowledgeStore();
    const c = getKnowledgeCase(String(args.case_id));
    if (!c) return errResult(`未找到案例: ${args.case_id}`, Date.now() - start);
    return okResult(c, Date.now() - start);
  } catch (e) {
    return errResult(e instanceof Error ? e.message : String(e), Date.now() - start);
  }
}

async function executeAddCase(args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  try {
    const input: KnowledgeCaseInput = {
      title: String(args.title),
      problemType: String(args.problem_type),
      severity: args.severity as KnowledgeCaseInput["severity"],
      summary: String(args.summary),
      rootCauses: Array.isArray(args.root_causes) ? args.root_causes.map(String) : [],
      solutions: Array.isArray(args.solutions) ? args.solutions.map(String) : [],
      serviceName: args.service_name ? String(args.service_name) : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
    };
    const c = await addKnowledgeCase(input);
    return okResult({ case_id: c.id, title: c.title, created_at: c.createdAt }, Date.now() - start);
  } catch (e) {
    return errResult(e instanceof Error ? e.message : String(e), Date.now() - start);
  }
}

export async function executeKnowledgeTool(
  tool: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  switch (tool) {
    case "search_similar_cases":
      return executeSearchSimilarCases(args);
    case "get_case":
      return executeGetCase(args);
    case "add_case":
      return executeAddCase(args);
    default:
      return errResult(`未知 Knowledge 工具: ${tool}`, 0);
  }
}
