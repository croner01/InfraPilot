export type RiskLevel = "readonly" | "low" | "medium" | "high" | "critical";

export interface TimelineEvent {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  payload: any;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ElkTarget {
  namespace: string;
  podNamePrefix: string;
  indexPrefix: string;
}

export interface ElkConfig {
  node: string;
  targets: ElkTarget[];
}

export interface HostAuth {
  type: "password" | "privateKey" | "agent";
  password?: string;
  passwordEnv?: string;
  privateKeyPath?: string;
  privateKeyEnv?: string;
  passphrase?: string;
  passphraseEnv?: string;
}

export interface HostEntry {
  name: string;
  hostname: string;
  port?: number;
  username: string;
  auth: HostAuth;
  labels?: Record<string, string>;
  tags?: string[];
}

export interface HostRegistry {
  hosts: HostEntry[];
}

export interface Evidence {
  id: string;
  sourceSkill?: string;
  type: string;
  content: any;
  confidence: number;
  collectedAt: string;
  summary: string;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

export interface ExecutedToolCall {
  id: string;
  skill: string;
  tool: string;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
  startedAt: string;
  finishedAt: string;
}

export interface RemediationStep {
  description: string;
  skill?: string;
  tool?: string;
  args?: Record<string, unknown>;
  risk?: RiskLevel;
  rollback?: string;
}

export interface Remediation {
  summary: string;
  steps: RemediationStep[];
}

export interface RootCause {
  summary: string;
  /** 结论正文未给出可解析的置信度时为 null/undefined（不看数时不假装有数） */
  confidence?: number | null;
  evidenceChain: { evidenceId: string; role: string; claim?: string | null }[];
  alternativeHypotheses: string[];
}

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
  /** 被诊断的对象（告警服务名 / 拓扑 类型 ns/name），右栏「对象」元信息行显示 */
  subject?: string;
  plan: string[];
  evidence: Evidence[];
  pendingToolCalls: any[];
  executedToolCalls: ExecutedToolCall[];
  rootCause?: RootCause;
  remediation?: Remediation;
  iteration: number;
  maxIterations: number;
  hypotheses?: Hypothesis[];
  /** 本轮激活的技能（后端 AgentSession.activeSkills） */
  activeSkills?: string[];
}

export type HypothesisStatus = 'active' | 'confirmed' | 'ruled_out';

export interface Hypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  evidenceIds: string[];
  toolCallIds: string[];
  updatedAt: string;
}

export type ServiceStatus = 'ok' | 'warn' | 'err'

/** 服务健康卡片（GET /api/health/services，来源：Prometheus kube-state-metrics） */
export interface ServiceHealth {
  name: string;
  /** 所属命名空间（后端 /api/health/services 聚合自 kube-state-metrics） */
  namespace?: string;
  meta: string;
  status: ServiceStatus;
  metricLabel: string;
  metricValue: string;
  chart: number[];
}

export type AlertSeverity = 'p0' | 'p1' | 'p2';
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged' | 'diagnosing';

/** 告警来源通道（后端 alerts/ingest 模块规划值，前端先行支持展示） */
export type AlertSourceType = 'alertmanager' | 'log_rule' | 'health_check' | 'manual';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  source: string;
  service: string;
  status: AlertStatus;
  startedAt: string;
  sessionId?: string;
  /** ---- 以下为告警中心设计扩展字段，后端接入 webhook 后返回，前端均可选渲染 ---- */
  sourceType?: AlertSourceType;
  /** 去重指纹（Alertmanager fingerprint） */
  fingerprint?: string;
  /** 原始标签，如 { namespace, pod, cloud_name } */
  labels?: Record<string, string>;
  /** 附加信息，如 { description, runbook_url, expression } */
  annotations?: Record<string, string>;
  /** 同一 fingerprint 累计触发次数（防抖合并） */
  count?: number;
  ackAt?: string;
  resolvedAt?: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}
