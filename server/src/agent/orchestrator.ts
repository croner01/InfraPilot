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

import { getSession } from "./sessionStore.js";
import { createInitialCheckpoint, runAgentStep } from "./runner.js";
import { loadCheckpoint } from "./checkpoint.js";

/**
 * 用户发送新消息时调用。
 * 创建初始 checkpoint 并启动 runner。
 */
export async function startAgentTurn(sessionId: string, userMessage: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");

  const checkpoint = await createInitialCheckpoint(sessionId, userMessage);
  const { done } = await runAgentStep(sessionId, checkpoint);

  // 若 runner 因遇到审批而退出，orchestrator 不再阻塞；
  // 审批到达后由 /approve 接口触发 resumeAgentTurn。
  if (!done) {
    // 已在 runner 内保存 checkpoint 并发出 approval_request 事件
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
