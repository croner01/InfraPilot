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
  confidence: number;
  evidenceChain: { evidenceId: string; role: string }[];
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
  plan: string[];
  evidence: Evidence[];
  pendingToolCalls: any[];
  executedToolCalls: ExecutedToolCall[];
  rootCause?: RootCause;
  remediation?: Remediation;
  iteration: number;
  maxIterations: number;
}

export type AlertSeverity = 'p0' | 'p1' | 'p2';
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  source: string;
  service: string;
  status: AlertStatus;
  startedAt: string;
  sessionId?: string;
}
