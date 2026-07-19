// ============================================================================
// InfraPilot Agent — 共享类型定义
// 对应设计文档 3.3 State 数据结构 / 5.3 MCP 消息结构 / 8.2 风险分级
// ============================================================================

export type RiskLevel = "readonly" | "low" | "medium" | "high" | "critical";

export type SkillName = "linux" | "k8s" | "elk" | "clickhouse" | "openstack";

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
  skill: SkillName;
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
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
  | "done";

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
