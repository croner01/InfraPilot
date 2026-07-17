// ============================================================================
// Agent Orchestrator — 核心推理循环
// 对应设计文档 §3(Agent状态机) 的简化落地: intake -> planning -> tool_selection
// -> risk_check -> (auto_exec | await_approval) -> observation -> reflection
// -> (loop | rca_conclusion) -> report
//
// Demo实现说明: 用一个显式的 while 循环 + OpenAI function calling 实现状态机,
// 语义与 LangGraph 版本(文档§3.5代码骨架)完全对应, 只是不引入 LangGraph 依赖
// 以降低本次落地复杂度。审批中断使用 Promise 阻塞当前循环等待前端决策,
// 对应 LangGraph 的 interrupt()/Command(resume=...) 机制。
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { openai, REASONING_MODEL } from "../llm/client.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { ALL_TOOLS, classifyRisk, renderDiffPreview } from "../gateway/policy.js";
import { executeToolCall } from "../gateway/commandGateway.js";
import { emitEvent, getSession, updateSession, waitForApprovalDecision } from "./sessionStore.js";
import { insertApproval, decideApproval as dbDecideApproval } from "../db/db.js";
import { Evidence, PendingToolCall, SkillName } from "../types.js";

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const conversations = new Map<string, ChatMsg[]>();

function toOpenAiTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return ALL_TOOLS.map((t) => ({
    type: "function",
    function: {
      name: `${t.skill}__${t.name}`,
      description: `[${t.skill}][risk=${t.risk}] ${t.description}`,
      parameters: t.parameters as any,
    },
  }));
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

export async function runAgentTurn(sessionId: string, userMessage: string) {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");

  let history = conversations.get(sessionId);
  if (!history) {
    history = [{ role: "system", content: SYSTEM_PROMPT }];
    conversations.set(sessionId, history);
  }
  history.push({ role: "user", content: userMessage });

  updateSession(sessionId, (s) => {
    s.status = "planning";
    s.incidentSummary = s.incidentSummary ?? userMessage;
  });
  emitEvent(sessionId, "status", { status: "planning", message: "正在分析问题并制定诊断计划..." });

  const tools = toOpenAiTools();
  let iteration = 0;
  const maxIterations = 10;

  while (iteration < maxIterations) {
    iteration += 1;
    updateSession(sessionId, (s) => (s.iteration = iteration));

    const completion = await openai.chat.completions.create({
      model: REASONING_MODEL,
      messages: history,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
    });

    const choice = completion.choices[0];
    const msg = choice.message;
    history.push(msg as ChatMsg);

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
      }
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      updateSession(sessionId, (s) => {
        if (s.status !== "concluded") s.status = "closed";
      });
      emitEvent(sessionId, "done", {});
      return;
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

      let approvedBy: string | undefined;

      if (risk.requiresApproval) {
        const approvalId = uuidv4();
        pending.approvalId = approvalId;
        insertApproval({
          id: approvalId,
          sessionId,
          skill,
          tool,
          args: JSON.stringify(args),
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

        const decision = await waitForApprovalDecision(approvalId);
        dbDecideApproval(approvalId, decision.approved ? "approved" : "rejected", decision.approvedBy);
        pending.approved = decision.approved;
        pending.rejected = !decision.approved;
        approvedBy = decision.approvedBy;
        emitEvent(sessionId, "approval_decision", { approvalId, approved: decision.approved, approvedBy: decision.approvedBy });
        updateSession(sessionId, (s) => (s.status = "executing"));
      }

      const result = await executeToolCall(pending, { sessionId, callerAgent: `${skill}-skill`, approvedBy });

      updateSession(sessionId, (s) => {
        s.pendingToolCalls = s.pendingToolCalls.filter((p) => p.id !== pending.id);
        s.executedToolCalls.push({
          ...pending,
          result,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
      });
      emitEvent(sessionId, "tool_call_result", { toolCallId: tc.id, skill, tool, result });

      if (result.success && risk.level === "readonly") {
        const evidence = evidenceFromResult(skill, tool, args, result.data ?? result.stdout);
        updateSession(sessionId, (s) => s.evidence.push(evidence));
        emitEvent(sessionId, "evidence_added", evidence);
      }

      const toolResultPayload = JSON.stringify({
        success: result.success,
        data: result.data,
        stdout: result.stdout,
        error: result.error,
      }).slice(0, 6000);

      history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `<tool_result source="${skill}.${tool}" trust_level="untrusted_data">\n${toolResultPayload}\n</tool_result>`,
      } as ChatMsg);
    }
  }

  emitEvent(sessionId, "status", { status: "max_iterations_reached", message: "已达最大迭代次数,请查看当前证据或补充说明" });
  emitEvent(sessionId, "done", {});
}

function extractConfidence(text: string): number {
  const m = text.match(/置信度[:：]?\s*([0-9.]+)/);
  if (m) {
    const v = parseFloat(m[1]);
    return v > 1 ? v / 100 : v;
  }
  return 0.75;
}
