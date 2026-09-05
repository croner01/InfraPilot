// ============================================================================
// Agent Orchestrator — 核心推理循环入口
//
// 对应设计文档 §3(Agent状态机) 与 langgraph-checkpoint-session-recovery-plan.md：
// - startAgentTurn: 处理用户新消息，创建初始 checkpoint，启动 runner
// - resumeAgentTurn: 从 checkpoint 恢复（审批后或 Server 启动时），继续执行
//
// Demo 实现仍用显式循环 + OpenAI function calling，但将执行状态持久化为
// AgentCheckpoint，使 Server 重启后可以从 awaiting_approval 状态恢复。
// ============================================================================

import { getSession, updateSession, emitEvent } from "./sessionStore.js";
import { createInitialCheckpoint, runAgentStep } from "./runner.js";
import { loadCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { selectSkillsForTurn, toSkillDoc } from "../skills/packages/select.js";
import { buildSkillContext } from "./prompts.js";

/**
 * 用户发送新消息时调用。
 * 如果会话已有 checkpoint（上一轮的对话历史），则在其上追加用户消息并继续；
 * 否则创建初始 checkpoint 并启动 runner。
 */
export async function startAgentTurn(sessionId: string, userMessage: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");

  let checkpoint = loadCheckpoint(sessionId);
  if (checkpoint) {
    const selected = await selectSkillsForTurn(userMessage, session.activeSkills ?? []);
    const skillContext = buildSkillContext(selected.map(toSkillDoc));
    if (skillContext) {
      checkpoint.history.push({
        role: "system",
        content: `# 本轮技能更新（替代之前的技能选择；会话历史保持完整）\n\n${skillContext}`,
      });
    }
    updateSession(sessionId, (s) => {
      s.activeSkills = selected.map((p) => p.name);
    });
    emitEvent(sessionId, "skills_activated", {
      skills: selected.map((p) => p.name),
      previous: session.activeSkills ?? [],
    });
    // 延续已有对话：保留历史上下文，追加当前消息，重置本轮迭代计数
    checkpoint.history.push({ role: "user", content: userMessage });
    checkpoint.iteration = 0;
    checkpoint.status = "planning";
    saveCheckpoint(checkpoint);
    updateSession(sessionId, (s) => {
      s.status = "planning";
      s.iteration = 0;
      if (!s.incidentSummary) s.incidentSummary = userMessage;
    });
  } else {
    checkpoint = await createInitialCheckpoint(sessionId, userMessage);
  }

  try {
    const { done } = await runAgentStep(sessionId, checkpoint);

    // 若 runner 因遇到审批而退出，orchestrator 不再阻塞；
    // 审批到达后由 /approve 接口触发 resumeAgentTurn。
    if (!done) {
      // 已在 runner 内保存 checkpoint 并发出 approval_request 事件
    }
  } catch (err) {
    // 致命错误（如 LLM 网络中断）：收尾会话避免永久卡在执行中
    const message = err instanceof Error ? err.message : String(err);
    updateSession(sessionId, (s) => {
      s.status = "closed";
    });
    emitEvent(sessionId, "error", { message });
    emitEvent(sessionId, "done", {});
    throw err;
  }
}

/**
 * 审批决策写入数据库后调用，或在 Server 启动时扫描 awaiting_approval 会话后调用。
 * 加载 checkpoint 并继续执行循环。
 */
export async function resumeAgentTurn(sessionId: string, _approvalId?: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");

  const checkpoint = loadCheckpoint(sessionId);
  if (!checkpoint) {
    // 无 checkpoint 说明会话不处于可恢复状态，直接返回
    return;
  }

  const { done } = await runAgentStep(sessionId, checkpoint);

  // 同样，runner 内部会处理后续的审批中断
  if (!done) {
    // 已保存 checkpoint 并发出 approval_request 事件
  }
}

/**
 * 向后兼容：旧的 runAgentTurn 等价于 startAgentTurn。
 * 新代码应优先使用 startAgentTurn / resumeAgentTurn。
 */
export async function runAgentTurn(sessionId: string, userMessage: string): Promise<void> {
  return startAgentTurn(sessionId, userMessage);
}
