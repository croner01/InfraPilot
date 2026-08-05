// ============================================================================
// InfraPilot Agent — 共享类型定义
// 对应设计文档 3.3 State 数据结构 / 5.3 MCP 消息结构 / 8.2 风险分级
// ============================================================================

import type OpenAI from "openai";

export type RiskLevel = "readonly" | "low" | "medium" | "high" | "critical";

export type SkillName = "linux" | "k8s" | "elk" | "clickhouse" | "openstack"
  | "trace" | "knowledge" | "topology" | "drawio";

export interface ToolDef {
  name: string;
  skill: SkillName;
  description: string;
  risk: RiskLevel;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolCallRequest {
  id: string;
  skill: SkillName;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  dryRun?: boolean;
  redacted?: boolean;
}

export interface RiskDecision {
  level: RiskLevel;
  reason: string;
  requiresApproval: boolean;
  requiresTwoPerson: boolean;
  blastRadius?: string;
}

export interface PendingToolCall {
  id: string;
  skill: SkillName;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskDecision;
  diffPreview?: string;
  approvalId?: string;
  approved?: boolean;
  rejected?: boolean;
  argsHash?: string;
}

export interface ExecutedToolCall extends PendingToolCall {
  result: ToolExecutionResult;
  startedAt: string;
  finishedAt: string;
}

export interface Evidence {
  id: string;
  sourceAgent: string;
  sourceSkill?: SkillName;
  type: string; // 'log_cluster' | 'metric' | 'k8s_event' | 'process_info' ...
  content: unknown;
  confidence: number;
  collectedAt: string;
  summary: string;
}

export interface RcaHypothesis {
  hypothesis: string;
  confidence: number;
  evidenceIds: string[];
}

export interface RootCause {
  summary: string;
  confidence: number;
  evidenceChain: { evidenceId: string; role: "primary" | "supporting" | "ruled_out" }[];
  alternativeHypotheses: string[];
}

export interface RemediationStep {
  description: string;
  /** 可选：LLM 输出中检测到的工具名（如 k8s.patch_resource_limits） */
  skill?: SkillName;
  tool?: string;
  args?: Record<string, unknown>;
  risk?: RiskLevel;
  rollback?: string;
}

export interface Remediation {
  summary: string;
  steps: RemediationStep[];
}

// -------------------- 时间线事件（推送给前端） --------------------

export type TimelineEventType =
  | "session_created"
  | "user_message"
  | "plan_update"
  | "tool_call_start"
  | "tool_call_result"
  | "approval_request"
  | "approval_decision"
  | "evidence_added"
  | "rca_conclusion"
  | "remediation_plan"
  | "assistant_message"
  | "status"
  | "error"
  | "done"
  | "knowledge_case_added"
  | "checkpoint_saved"
  | "runner_resumed";

export interface TimelineEvent {
  id: string;
  sessionId: string;
  type: TimelineEventType;
  timestamp: string;
  payload: unknown;
}

// -------------------- 会话状态 --------------------

export type SessionStatus =
  | "intake"
  | "planning"
  | "executing"
  | "awaiting_approval"
  | "reflecting"
  | "concluded"
  | "remediating"
  | "closed";

export interface AgentSession {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  incidentSummary?: string;
  plan: string[];
  evidence: Evidence[];
  pendingToolCalls: PendingToolCall[];
  executedToolCalls: ExecutedToolCall[];
  rootCause?: RootCause;
  remediation?: Remediation;
  iteration: number;
  maxIterations: number;
}

// -------------------- Agent Checkpoint（LangGraph Checkpoint 语义） --------------------

export interface AgentCheckpoint {
  sessionId: string;
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  iteration: number;
  status: SessionStatus;
  pendingToolCall?: PendingToolCall;
  lastToolResults?: ExecutedToolCall[];
  createdAt: string;
}

// ── Logoscope 集成类型 ──

export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  serviceName: string;
  operationName: string;
  startTime: string;
  durationMs: number;
  status: 'OK' | 'ERROR';
  attributes?: Record<string, string>;
}

export interface TraceAnalysis {
  traceId: string;
  totalDurationMs: number;
  spans: TraceSpan[];
  errorSpans: TraceSpan[];
  slowSpans: TraceSpan[];
  serviceMap: Record<string, string[]>;  // service → dependent services
}

export interface KnowledgeCaseInput {
  title: string;
  problemType: string; // e.g. "OOMKilled", "NoValidHost", "网络不通"
  severity: "p0" | "p1" | "p2" | "p3";
  summary: string; // 问题现象
  rootCauses: string[]; // 根因列表
  solutions: string[]; // 解决方案/SOP 步骤
  serviceName?: string; // 关联服务/组件
  tags?: string[]; // 人工标签
  sourceSessionId?: string; // 来源会话
}

export interface KnowledgeCase extends KnowledgeCaseInput {
  id: string;
  createdAt: string;
  resolved: boolean;
}

// -------------------- 跨会话记忆 --------------------

export interface SessionMemoryInput {
  sessionId: string;
  title: string;
  summary: string;
  tags?: string[];
}

export interface SessionMemory extends SessionMemoryInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}



export interface TopologyNode {
  id: string;
  name: string;
  type: string;
  namespace?: string;
}

export interface TopologyEdge {
  source: string;
  target: string;
  type: string;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}
