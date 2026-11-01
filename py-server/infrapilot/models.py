"""共享数据模型 — 与 `server/src/types.ts` 一一对应。

字段刻意使用 camelCase：这些对象会被直接序列化后推送给前端 / 写入
state_json，保持与 Node 版完全相同的线上格式，避免前端改造。
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

RiskLevel = Literal["readonly", "low", "medium", "high", "critical"]

SessionStatus = Literal[
    "intake",
    "planning",
    "executing",
    "awaiting_approval",
    "reflecting",
    "concluded",
    "remediating",
    "closed",
]

HypothesisStatus = Literal["active", "confirmed", "ruled_out"]

TimelineEventType = Literal[
    "session_created",
    "user_message",
    "plan_update",
    "tool_call_start",
    "tool_call_result",
    "approval_request",
    "approval_decision",
    "evidence_added",
    "rca_conclusion",
    "remediation_plan",
    "assistant_message",
    "status",
    "error",
    "done",
    "knowledge_case_added",
    "checkpoint_saved",
    "runner_resumed",
    "skills_activated",
    "hypothesis_update",
    "assistant_delta",
    "context_compressed",
    "evidence_gap_probe",
]

AlertSeverity = Literal["p0", "p1", "p2"]
AlertStatus = Literal["firing", "resolved", "acknowledged", "diagnosing"]


class Base(BaseModel):
    model_config = ConfigDict(extra="allow", protected_namespaces=())


class ToolDef(Base):
    name: str
    skill: str
    description: str
    risk: RiskLevel
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class ToolExecutionResult(Base):
    success: bool
    data: Any = None
    error: Optional[str] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    durationMs: int = 0
    dryRun: Optional[bool] = None
    redacted: Optional[bool] = None


class RiskDecision(Base):
    level: RiskLevel
    reason: str
    requiresApproval: bool
    requiresTwoPerson: bool
    blastRadius: Optional[str] = None


class PendingToolCall(Base):
    id: str
    skill: str
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    risk: RiskDecision
    diffPreview: Optional[str] = None
    approvalId: Optional[str] = None
    approved: Optional[bool] = None
    rejected: Optional[bool] = None
    argsHash: Optional[str] = None


class ExecutedToolCall(PendingToolCall):
    result: ToolExecutionResult
    startedAt: str
    finishedAt: str


class Evidence(Base):
    id: str
    sourceAgent: str
    sourceSkill: Optional[str] = None
    type: str
    content: Any = None
    confidence: float
    collectedAt: str
    summary: str


class EvidenceChainItem(Base):
    evidenceId: str
    role: Literal["primary", "supporting", "ruled_out"]
    # 这条证据「支撑/反驳了哪句话」：只给 ID 列表时读者无法验证，等于把证据链退化成索引
    claim: Optional[str] = None


class RootCause(Base):
    summary: str
    # 解析不出结论正文里的置信度时保持 None（宁可不显示，也不用默认值掩盖分歧）
    confidence: Optional[float] = None
    evidenceChain: list[EvidenceChainItem] = Field(default_factory=list)
    alternativeHypotheses: list[str] = Field(default_factory=list)


class RemediationStep(Base):
    description: str
    skill: Optional[str] = None
    tool: Optional[str] = None
    args: Optional[dict[str, Any]] = None
    risk: Optional[RiskLevel] = None
    rollback: Optional[str] = None


class Remediation(Base):
    summary: str
    steps: list[RemediationStep] = Field(default_factory=list)


class Hypothesis(Base):
    id: str
    statement: str
    status: HypothesisStatus = "active"
    evidenceIds: list[str] = Field(default_factory=list)
    toolCallIds: list[str] = Field(default_factory=list)
    updatedAt: str


class AgentSession(Base):
    id: str
    title: str
    status: SessionStatus
    createdAt: str
    updatedAt: str
    incidentSummary: Optional[str] = None
    # 被诊断的对象（告警服务名 / 拓扑 ns/name），右栏「对象」元信息行使用
    subject: Optional[str] = None
    plan: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    pendingToolCalls: list[PendingToolCall] = Field(default_factory=list)
    executedToolCalls: list[ExecutedToolCall] = Field(default_factory=list)
    rootCause: Optional[RootCause] = None
    remediation: Optional[Remediation] = None
    iteration: int = 0
    maxIterations: int = 20
    activeSkills: list[str] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)


class AgentCheckpoint(Base):
    sessionId: str
    history: list[dict[str, Any]] = Field(default_factory=list)
    iteration: int = 0
    status: SessionStatus = "planning"
    pendingToolCall: Optional[PendingToolCall] = None
    lastToolResults: Optional[list[ExecutedToolCall]] = None
    createdAt: str = ""


class TimelineEvent(Base):
    id: str
    sessionId: str
    type: str
    timestamp: str
    payload: Any = None


class Alert(Base):
    id: str
    severity: AlertSeverity
    title: str
    source: str
    service: str
    status: AlertStatus
    startedAt: str
    sessionId: Optional[str] = None


class KnowledgeCaseInput(Base):
    title: str
    problemType: str = ""
    severity: Literal["p0", "p1", "p2", "p3"] = "p3"
    summary: str
    rootCauses: list[str] = Field(default_factory=list)
    solutions: list[str] = Field(default_factory=list)
    serviceName: Optional[str] = None
    tags: Optional[list[str]] = None
    sourceSessionId: Optional[str] = None


class KnowledgeCase(KnowledgeCaseInput):
    id: str
    createdAt: str
    resolved: bool = True
