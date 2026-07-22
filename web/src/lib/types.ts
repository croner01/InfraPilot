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
