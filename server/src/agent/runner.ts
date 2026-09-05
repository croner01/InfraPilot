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
import { openai, getReasoningModel } from "../llm/client.js";
import { buildSystemPrompt, buildSkillContext } from "./prompts.js";
import { ALL_TOOLS, classifyRisk, renderDiffPreview } from "../gateway/policy.js";
import { buildRegistry, recallTools } from "../skills/registry/skillRegistry.js";
import { selectSkillsForTurn, toSkillDoc } from "../skills/packages/select.js";
import { searchKnowledgeCases, addKnowledgeCase } from "../skills/knowledge/store.js";
import { executeToolCall } from "../gateway/commandGateway.js";
import { computeArgsHash } from "../gateway/argsHash.js";
import { emitEvent, emitEventLive, getSession, updateSession } from "./sessionStore.js";
import { insertApproval, decideApproval as dbDecideApproval, getApproval } from "../db/db.js";
import { saveCheckpoint, loadCheckpoint } from "./checkpoint.js";
import { buildMemoryContext, extractAndStoreSessionMemory } from "./memoryStore.js";
import { extractPlan, extractRemediation, extractHypotheses, extractRca, extractCounterEvidence } from "./plan.js";
import { mergeHypotheses, linkHypothesesToEvidence } from "./hypotheses.js";
import { collectStreamedCompletion } from "../llm/stream.js";
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
  const memoryContext = await buildMemoryContext(recallQuery);
  const selectedSkills = await selectSkillsForTurn(recallQuery, []);
  const skillContext = buildSkillContext(selectedSkills.map(toSkillDoc));
  updateSession(sessionId, (s) => {
    s.activeSkills = selectedSkills.map((p) => p.name);
  });
  emitEvent(sessionId, "skills_activated", {
    skills: selectedSkills.map((p) => p.name),
    turn: "initial",
  });
  // P2: 即使 checkpoint 丢失（如历史被清、异常重启），也把会话已有状态注入上下文，避免彻底失忆
  const recoveredContext = buildRecoveredContext(session);
  const systemPrompt =
    buildSystemPrompt(buildToolListMarkdown(availableTools) + similarCases + memoryContext) +
    (skillContext ? `\n\n${skillContext}` : "") +
    (recoveredContext
      ? `\n\n# 会话历史上下文(自动恢复)\n${recoveredContext}\n以上为历史会话已确认的状态与证据，仅作上下文参考，结论仍需结合实时证据交叉验证。`
      : "");

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

/** P2: 从 session 状态中恢复一段历史上下文摘要，供 checkpoint 丢失后兜底 */
function buildRecoveredContext(session: AgentSession): string {
  const parts: string[] = [];
  if (session.incidentSummary) parts.push(`- 原始问题: ${session.incidentSummary}`);
  if (session.plan && session.plan.length > 0) parts.push(`- 诊断计划: ${session.plan.join(" -> ")}`);
  if (session.evidence && session.evidence.length > 0) {
    const recent = session.evidence
      .slice(-5)
      .map((e) => `  - ${e.sourceSkill ?? e.type}: ${e.summary}`)
      .join("\n");
    parts.push(`- 已收集证据(最近 ${Math.min(5, session.evidence.length)} 条):\n${recent}`);
  }
  if (session.executedToolCalls && session.executedToolCalls.length > 0) {
    const tools = Array.from(new Set(session.executedToolCalls.map((t) => `${t.skill}.${t.tool}`))).join(", ");
    parts.push(`- 已执行工具(${session.executedToolCalls.length} 次): ${tools}`);
  }
  if (session.rootCause) parts.push(`- 已有根因结论: ${session.rootCause.summary}`);
  if (session.remediation) parts.push(`- 修复方案: ${session.remediation.summary}`);
  return parts.join("\n");
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
  emitEvent(sessionId, "tool_call_result", { toolCallId: pending.id, skill: pending.skill, tool: pending.tool, args: pending.args, result });

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
 * - 会话结束（无 tool_calls 或达最大迭代次数）时保留 checkpoint，供追问延续上下文。
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

  const maxIterations = session.maxIterations ?? 20;

  while (checkpoint.iteration < maxIterations) {
    checkpoint.iteration += 1;
    updateSession(sessionId, (s) => (s.iteration = checkpoint.iteration));

    const availableTools = await recallAvailableTools(checkpoint);
    const tools = toOpenAiTools(availableTools);

    const completion = await openai.chat.completions.create({
      model: getReasoningModel(),
      messages: checkpoint.history,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: true,
    });

    // 流式收集：增量推送 assistant_delta（仅广播不落库），结束时整体落库
    let deltaCount = 0;
    const { content, toolCalls } = await collectStreamedCompletion(completion, (piece) => {
      deltaCount++;
      if (deltaCount % 4 === 0) {
        emitEventLive(sessionId, "assistant_delta", { content: piece });
      }
    });
    const msg: ChatMsg = {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    checkpoint.history.push(msg as ChatMsg);

    if (content) {
      await processAssistantContent(sessionId, session, content);
    }

    if (toolCalls.length === 0) {
      updateSession(sessionId, (s) => {
        if (s.status !== "concluded") s.status = "closed";
      });
      emitEvent(sessionId, "done", {});
      // 保留 checkpoint 而不是删除，以便后续用户追问时能够延续上下文。
      // startAgentTurn 会在下一条消息到达时复用该 checkpoint。
      saveCheckpoint(checkpoint);
      extractAndStoreSessionMemory(sessionId).catch(() => {});
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

  // P1: 已达迭代上限时，基于现有证据生成尽力而为的最终结论（禁止再调用工具）
  await concludeFromExistingEvidence(sessionId, session, checkpoint);

  emitEvent(sessionId, "status", { status: "max_iterations_reached", message: "已达最大迭代次数,已基于现有证据生成阶段性结论" });
  emitEvent(sessionId, "done", {});
  // P0: 保留 checkpoint，保证后续追问能延续完整上下文
  saveCheckpoint(checkpoint);
  extractAndStoreSessionMemory(sessionId).catch(() => {});
  return { checkpoint, done: true };
}

/**
 * 处理一条 assistant 文本：广播消息、提取诊断计划/修复方案、解析根因结论。
 * 供正常循环与"超限兜底结论"两条路径复用。
 */
async function processAssistantContent(sessionId: string, session: AgentSession, content: string): Promise<void> {
  emitEvent(sessionId, "assistant_message", { content });

  const plan = extractPlan(content);
  if (plan.length > 0) {
    updateSession(sessionId, (s) => {
      s.plan = plan;
    });
    emitEvent(sessionId, "plan_update", { plan });
  }

  const hypotheses = extractHypotheses(content);
  if (hypotheses.length > 0) {
    updateSession(sessionId, (s) => {
      s.hypotheses = linkHypothesesToEvidence(mergeHypotheses(s.hypotheses ?? [], hypotheses), s.evidence);
    });
    const updated = getSession(sessionId);
    emitEvent(sessionId, "hypothesis_update", { hypotheses: updated?.hypotheses ?? [] });
  }

  const remediation = extractRemediation(content);
  if (remediation) {
    updateSession(sessionId, (s) => {
      s.remediation = remediation;
    });
    emitEvent(sessionId, "remediation_plan", { summary: remediation.summary, steps: remediation.steps });
  }

  const rcaText = extractRca(content);
  if (rcaText) {
    updateSession(sessionId, (s) => {
      s.status = "concluded";
      s.rootCause = {
        summary: rcaText,
        confidence: extractConfidence(rcaText),
        evidenceChain: s.evidence.map((e) => ({ evidenceId: e.id, role: "supporting" as const })),
        alternativeHypotheses: extractCounterEvidence(content),
      };
    });
    emitEvent(sessionId, "rca_conclusion", { content: rcaText });
    await persistRootCauseAsCase(sessionId, session, rcaText);
  }
}

/** P1: 迭代超限后的兜底结论——只允许基于已有证据总结，禁止调用工具 */
async function concludeFromExistingEvidence(sessionId: string, session: AgentSession, checkpoint: AgentCheckpoint): Promise<void> {
  try {
    const completion = await openai.chat.completions.create({
      model: getReasoningModel(),
      messages: [
        ...checkpoint.history,
        {
          role: "user",
          content:
            "已达最大迭代次数。请基于以上全部证据直接输出最终结论，以【根因分析结论】开头，包含根因摘要、置信度(0-1)、支撑证据要点和修复建议；禁止调用任何工具。",
        },
      ],
      tools: [],
      tool_choice: "none",
    });
    const content = completion.choices[0]?.message?.content;
    if (content) {
      checkpoint.history.push({ role: "assistant", content });
      await processAssistantContent(sessionId, session, content);
    }
  } catch (err: any) {
    console.error("[runner] 最终结论生成失败:", err?.message ?? String(err));
  }
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
