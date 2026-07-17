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
