// ============================================================================
// Agent Runner — 可恢复的执行循环
//
// 对应 langgraph-checkpoint-session-recovery-plan.md：
// - 从 AgentCheckpoint 恢复状态（history、iteration、pendingToolCall）
// - 执行一次 LLM 调用并处理 tool_calls
// - 如遇审批，保存 checkpoint 并退出；审批到达后由 resumeAgentTurn 再次调用
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { openai, REASONING_MODEL } from "../llm/client.js";
import { buildSystemPrompt } from "./prompts.js";
import { ALL_TOOLS, classifyRisk, renderDiffPreview } from "../gateway/policy.js";
import { buildRegistry, recallTools } from "../skills/registry/skillRegistry.js";
import { searchKnowledgeCases, addKnowledgeCase } from "../skills/knowledge/store.js";
import { executeToolCall } from "../gateway/commandGateway.js";
import { computeArgsHash } from "../gateway/argsHash.js";
import { emitEvent, getSession, updateSession } from "./sessionStore.js";
import { insertApproval, decideApproval as dbDecideApproval, getApproval } from "../db/db.js";
import { saveCheckpoint, loadCheckpoint, deleteCheckpoint } from "./checkpoint.js";
import {
  AgentCheckpoint,
  AgentSession,
  Evidence,
  ExecutedToolCall,
  PendingToolCall,
  RiskDecision,
  SkillName,
  ToolDef,
  ToolExecutionResult,
} from "../types.js";

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAiTools(tools: ToolDef[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: `${t.skill}__${t.name}`,
      description: `[${t.skill}][risk=${t.risk}] ${t.description}`,
      parameters: t.parameters as any,
    },
  }));
}

function buildToolListMarkdown(tools: ToolDef[]): string {
  return tools.map((t) => `- ${t.skill}.${t.name}: ${t.description}`).join("\n");
}

async function fetchSimilarCases(query: string): Promise<string> {
  try {
    const cases = await searchKnowledgeCases({ query, limit: 3 });
    if (cases.length === 0) return "";
    const lines = cases.map(
      (c) =>
        `- case_id=${c.id} [相似度 ${c.score.toFixed(3)}] ${c.title}\n  摘要: ${c.summary}\n  根因: ${c.rootCauses.join(
          "; "
        )}\n  方案: ${c.solutions.join("; ")}`
    );
    return `\n# 历史相似案例参考\n${lines.join("\n")}\n`;
  } catch {
    return "";
  }
}

function parseFnName(fnName: string): { skill: SkillName; tool: string } {
  const idx = fnName.indexOf("__");
  return { skill: fnName.slice(0, idx) as SkillName, tool: fnName.slice(idx + 2) };
}

function evidenceFromResult(skill: SkillName, tool: string, args: Record<string, unknown>, resultData: unknown): Evidence {
  return {
    id: uuidv4(),
    sourceAgent: `${skill}-skill`,
    sourceSkill: skill,
    type: `${skill}.${tool}`,
    content: resultData,
    confidence: 0.7,
    collectedAt: new Date().toISOString(),
    summary: `${skill}.${tool}(${JSON.stringify(args).slice(0, 120)})`,
  };
}

function extractConfidence(text: string): number {
  const m = text.match(/置信度[:：]?\s*([0-9.]+)/);
  if (m) {
    const v = parseFloat(m[1]);
    return v > 1 ? v / 100 : v;
  }
  return 0.75;
}

async function persistRootCauseAsCase(sessionId: string, session: AgentSession, rcaText: string) {
  try {
    if (!session.incidentSummary || !session.rootCause) return;
    const caseInput = {
      title: `自动沉淀: ${session.incidentSummary.slice(0, 60)}`,
      problemType: "auto_persisted",
      severity: "p2" as const,
      summary: session.incidentSummary,
      rootCauses: [rcaText],
      solutions: [],
      serviceName: undefined,
      tags: ["auto_persisted"],
      sourceSessionId: sessionId,
    };
    const c = await addKnowledgeCase(caseInput);
    emitEvent(sessionId, "knowledge_case_added", { caseId: c.id, title: c.title });
  } catch {
    // 知识库沉淀失败不应阻断主流程
  }
}

async function buildInitialHistory(sessionId: string, userMessage: string): Promise<ChatMsg[]> {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");

  await buildRegistry(ALL_TOOLS);

  const recallQuery = [userMessage, session.incidentSummary].filter(Boolean).join("\n");
  const recalled = await recallTools(recallQuery, { topK: 16 });
  const availableTools = recalled.map((r) => r.tool);

  const similarCases = await fetchSimilarCases(recallQuery);
  const systemPrompt = buildSystemPrompt(buildToolListMarkdown(availableTools) + similarCases);

  updateSession(sessionId, (s) => {
    s.status = "planning";
    s.incidentSummary = s.incidentSummary ?? userMessage;
  });
  emitEvent(sessionId, "status", { status: "planning", message: "正在分析问题并制定诊断计划..." });

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

function formatToolResult(skill: SkillName, tool: string, result: ToolExecutionResult): string {
  const payload = JSON.stringify({
    success: result.success,
    data: result.data,
    stdout: result.stdout,
    error: result.error,
  }).slice(0, 6000);
  return `<tool_result source="${skill}.${tool}" trust_level="untrusted_data">\n${payload}\n</tool_result>`;
}

async function executeSingleToolCall(
  sessionId: string,
  session: AgentSession,
  pending: PendingToolCall
): Promise<{ result: Awaited<ReturnType<typeof executeToolCall>>; approvedBy?: string }> {
  let approvedBy: string | undefined;

  if (pending.risk.requiresApproval) {
    if (!pending.approvalId) {
      throw new Error("pending high-risk tool call missing approvalId");
    }
    const approval = getApproval(pending.approvalId);
    if (!approval || approval.decision !== "approved") {
      throw new Error(`approval ${pending.approvalId} not approved`);
    }
    approvedBy = approval.decided_by;
  }

  const result = await executeToolCall(pending, { sessionId, callerAgent: `${pending.skill}-skill`, approvedBy });

  updateSession(sessionId, (s) => {
    s.pendingToolCalls = s.pendingToolCalls.filter((p) => p.id !== pending.id);
    s.executedToolCalls.push({
      ...pending,
      result,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  });
  emitEvent(sessionId, "tool_call_result", { toolCallId: pending.id, skill: pending.skill, tool: pending.tool, result });

  if (result.success && pending.risk.level === "readonly") {
    const evidence = evidenceFromResult(pending.skill, pending.tool, pending.args, result.data ?? result.stdout);
    updateSession(sessionId, (s) => s.evidence.push(evidence));
    emitEvent(sessionId, "evidence_added", evidence);
  }

  return { result, approvedBy };
}

export interface RunAgentStepResult {
  checkpoint: AgentCheckpoint;
  done: boolean;
  awaitingApproval?: boolean;
}

/**
 * 从 checkpoint 恢复并尽量推进执行循环。
 * - 若 checkpoint 中存在 pendingToolCall，会先执行它（resume 场景）。
 * - 之后循环调用 LLM，处理 tool_calls；遇到第一个需审批的工具时保存 checkpoint 并退出。
 * - 会话结束（无 tool_calls 或达最大迭代次数）时删除 checkpoint。
 */
export async function runAgentStep(
  sessionId: string,
  existingCheckpoint?: AgentCheckpoint
): Promise<RunAgentStepResult> {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");

  let checkpoint = existingCheckpoint ?? loadCheckpoint(sessionId);
  if (!checkpoint) throw new Error(`no checkpoint for session ${sessionId}`);

  // resume 场景：先执行已批准的 pendingToolCall
  if (checkpoint.pendingToolCall) {
    const { result } = await executeSingleToolCall(sessionId, session, checkpoint.pendingToolCall);

    // 将结果写回 history
    checkpoint.history.push({
      role: "tool",
      tool_call_id: checkpoint.pendingToolCall.id,
      content: formatToolResult(checkpoint.pendingToolCall.skill, checkpoint.pendingToolCall.tool, result),
    } as ChatMsg);

    checkpoint.pendingToolCall = undefined;
    checkpoint.status = "executing";
    updateSession(sessionId, (s) => (s.status = "executing"));
    saveCheckpoint(checkpoint);
    emitEvent(sessionId, "checkpoint_saved", { checkpoint });
  }

  const maxIterations = session.maxIterations ?? 10;

  while (checkpoint.iteration < maxIterations) {
    checkpoint.iteration += 1;
    updateSession(sessionId, (s) => (s.iteration = checkpoint.iteration));

    const availableTools = await recallAvailableTools(checkpoint);
    const tools = toOpenAiTools(availableTools);

    const completion = await openai.chat.completions.create({
      model: REASONING_MODEL,
      messages: checkpoint.history,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
    });

    const choice = completion.choices[0];
    const msg = choice.message;
    checkpoint.history.push(msg as ChatMsg);

    if (msg.content) {
      emitEvent(sessionId, "assistant_message", { content: msg.content });
      const rcaMatch = msg.content.match(/【根因分析结论】([\s\S]*)/);
      if (rcaMatch) {
        updateSession(sessionId, (s) => {
          s.status = "concluded";
          s.rootCause = {
            summary: rcaMatch[1].trim(),
            confidence: extractConfidence(rcaMatch[1]),
            evidenceChain: s.evidence.map((e) => ({ evidenceId: e.id, role: "supporting" as const })),
            alternativeHypotheses: [],
          };
        });
        emitEvent(sessionId, "rca_conclusion", { content: rcaMatch[1].trim() });
        await persistRootCauseAsCase(sessionId, session, rcaMatch[1].trim());
      }
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      updateSession(sessionId, (s) => {
        if (s.status !== "concluded") s.status = "closed";
      });
      emitEvent(sessionId, "done", {});
      deleteCheckpoint(sessionId);
      return { checkpoint, done: true };
    }

    updateSession(sessionId, (s) => (s.status = "executing"));

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const { skill, tool } = parseFnName(tc.function.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      const risk = classifyRisk(skill, tool, args);
      const pending: PendingToolCall = {
        id: tc.id,
        skill,
        tool,
        args,
        risk,
        diffPreview: risk.requiresApproval ? renderDiffPreview(skill, tool, args) : undefined,
      };

      updateSession(sessionId, (s) => s.pendingToolCalls.push(pending));
      emitEvent(sessionId, "tool_call_start", { toolCallId: tc.id, skill, tool, args, risk });

      if (risk.requiresApproval) {
        const approvalId = uuidv4();
        const argsHash = computeArgsHash(skill, tool, args);
        pending.approvalId = approvalId;
        pending.argsHash = argsHash;
        insertApproval({
          id: approvalId,
          sessionId,
          skill,
          tool,
          args: JSON.stringify(args),
          argsHash,
          riskLevel: risk.level,
          diffPreview: pending.diffPreview ?? "",
        });

        updateSession(sessionId, (s) => (s.status = "awaiting_approval"));
        emitEvent(sessionId, "approval_request", {
          approvalId,
          toolCallId: tc.id,
          skill,
          tool,
          args,
          risk,
          diffPreview: pending.diffPreview,
        });

        checkpoint.status = "awaiting_approval";
        checkpoint.pendingToolCall = pending;
        saveCheckpoint(checkpoint);
        emitEvent(sessionId, "checkpoint_saved", { checkpoint });
        return { checkpoint, done: false, awaitingApproval: true };
      }

      const { result } = await executeSingleToolCall(sessionId, session, pending);
      checkpoint.history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: formatToolResult(pending.skill, pending.tool, result),
      } as ChatMsg);

      saveCheckpoint(checkpoint);
      emitEvent(sessionId, "checkpoint_saved", { checkpoint });
    }
  }

  emitEvent(sessionId, "status", { status: "max_iterations_reached", message: "已达最大迭代次数,请查看当前证据或补充说明" });
  emitEvent(sessionId, "done", {});
  deleteCheckpoint(sessionId);
  return { checkpoint, done: true };
}

async function recallAvailableTools(checkpoint: AgentCheckpoint): Promise<ToolDef[]> {
  await buildRegistry(ALL_TOOLS);
  // 使用最后一条 user/assistant 消息作为召回 query
  const lastUserOrAssistant = [...checkpoint.history]
    .reverse()
    .find((m) => m.role === "user" || m.role === "assistant");
  const query = typeof lastUserOrAssistant?.content === "string" ? lastUserOrAssistant.content : "";
  const recalled = await recallTools(query, { topK: 16 });
  return recalled.map((r) => r.tool);
}

/**
 * 创建新的 AgentCheckpoint（供 startAgentTurn 使用）。
 */
export async function createInitialCheckpoint(sessionId: string, userMessage: string): Promise<AgentCheckpoint> {
  const history = await buildInitialHistory(sessionId, userMessage);
  const checkpoint: AgentCheckpoint = {
    sessionId,
    history,
    iteration: 0,
    status: "planning",
    createdAt: new Date().toISOString(),
  };
  saveCheckpoint(checkpoint);
  emitEvent(sessionId, "checkpoint_saved", { checkpoint });
  return checkpoint;
}

/**
 * 标记审批决策已通过数据库持久化， runner 侧只需校验并执行。
 */
export async function markApprovalDecided(
  approvalId: string,
  decision: { approved: boolean; approvedBy: string }
): Promise<void> {
  dbDecideApproval(approvalId, decision.approved ? "approved" : "rejected", decision.approvedBy);
}
