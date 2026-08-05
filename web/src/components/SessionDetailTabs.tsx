import { useEffect, useState } from "react";
import { fetchSessionAudit } from "../lib/api.js";
import type { AgentSession, Evidence, Remediation, ExecutedToolCall } from "../lib/types.js";

export type DetailTab = "evidence" | "plan" | "remediation" | "audit";

const tabs: { key: DetailTab; label: string; count?: (s: AgentSession) => number | undefined }[] = [
  { key: "evidence", label: "证据链", count: (s) => s.evidence.length },
  { key: "plan", label: "诊断计划", count: (s) => s.plan.length },
  { key: "remediation", label: "修复方案", count: (s) => s.remediation?.steps.length },
  { key: "audit", label: "审计日志" },
];

export function SessionDetailTabs({ session }: { session: AgentSession }) {
  const [active, setActive] = useState<DetailTab>("evidence");
  const [audit, setAudit] = useState<any[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    if (active === "audit") {
      setAuditLoading(true);
      fetchSessionAudit(session.id).then((rows) => {
        setAudit(rows ?? []);
        setAuditLoading(false);
      });
    }
  }, [active, session.id]);

  return (
    <div className="detail-tabs">
      <div className="detail-tabs__nav">
        {tabs.map((t) => {
          const c = t.count?.(session);
          return (
            <button
              key={t.key}
              className={`detail-tabs__tab ${active === t.key ? "active" : ""}`}
              onClick={() => setActive(t.key)}
            >
              {t.label}
              {c !== undefined ? <span className="detail-tabs__count">{c}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="detail-tabs__body">
        {active === "evidence" && <EvidenceTab evidence={session.evidence} />}
        {active === "plan" && <PlanTab plan={session.plan} />}
        {active === "remediation" && <RemediationTab remediation={session.remediation} />}
        {active === "audit" && <AuditTab audit={audit} loading={auditLoading} executed={session.executedToolCalls} />}
      </div>
    </div>
  );
}

function EvidenceTab({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) {
    return <EmptyState icon="🔍" message="暂无证据，等待 Agent 收集诊断证据" />;
  }
  return (
    <div className="evidence-list">
      {evidence.map((e) => (
        <div key={e.id} className="evidence-card">
          <div className="evidence-card__header">
            <span className="evidence-card__type">{e.sourceSkill ?? e.type}</span>
            <span className="evidence-card__confidence">置信度 {(e.confidence * 100).toFixed(0)}%</span>
          </div>
          <div className="evidence-card__summary">{e.summary}</div>
          {e.content && (
            <pre className="evidence-card__content">
              {typeof e.content === "string" ? e.content : JSON.stringify(e.content, null, 2)}
            </pre>
          )}
          <div className="evidence-card__time">{new Date(e.collectedAt).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function PlanTab({ plan }: { plan: string[] }) {
  if (plan.length === 0) {
    return <EmptyState icon="📋" message="诊断计划尚未生成" />;
  }
  return (
    <ol className="plan-list">
      {plan.map((step, idx) => (
        <li key={idx} className="plan-item">
          <span className="plan-item__idx">{idx + 1}</span>
          <span className="plan-item__text">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function RemediationTab({ remediation }: { remediation?: Remediation }) {
  if (!remediation || remediation.steps.length === 0) {
    return <EmptyState icon="🛠️" message="暂无修复方案" />;
  }
  return (
    <div className="remediation-panel">
      <div className="remediation-summary">{remediation.summary}</div>
      <div className="remediation-steps">
        {remediation.steps.map((step, idx) => (
          <div key={idx} className="remediation-step">
            <div className="remediation-step__header">
              <span className="remediation-step__idx">{idx + 1}</span>
              <span className="remediation-step__title">{step.description}</span>
              {step.risk ? (
                <span className={`risk-badge risk-badge--${step.risk}`}>{step.risk}</span>
              ) : null}
            </div>
            {step.skill && step.tool ? (
              <div className="remediation-step__tool">{step.skill}.{step.tool}()</div>
            ) : null}
            {step.args && Object.keys(step.args).length > 0 && (
              <pre className="remediation-step__args">{JSON.stringify(step.args, null, 2)}</pre>
            )}
            {step.rollback && <div className="remediation-step__rollback">回滚: {step.rollback}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditTab({ audit, loading, executed }: { audit: any[] | null; loading: boolean; executed: ExecutedToolCall[] }) {
  if (loading) return <div className="skeleton-list">加载审计日志...</div>;
  const rows = audit ?? executed.map((t) => ({
    started_at: t.startedAt,
    finished_at: t.finishedAt,
    skill: t.skill,
    tool: t.tool,
    args: JSON.stringify(t.args),
    risk_level: "readonly",
    success: t.result.success ? 1 : 0,
    approved_by: undefined,
  }));
  if (rows.length === 0) {
    return <EmptyState icon="📜" message="暂无审计记录" />;
  }
  return (
    <div className="audit-table-wrapper">
      <table className="audit-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>Skill</th>
            <th>Tool</th>
            <th>风险</th>
            <th>结果</th>
            <th>审批人</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row: any, idx: number) => (
            <tr key={idx}>
              <td>{new Date(row.started_at ?? row.startedAt).toLocaleString()}</td>
              <td>{row.skill}</td>
              <td>{row.tool}</td>
              <td>
                <span className={`risk-badge risk-badge--${row.risk_level}`}>{row.risk_level}</span>
              </td>
              <td>
                <span className={`status-dot ${row.success ? "status-dot--success" : "status-dot--error"}`}>
                  {row.success ? "成功" : "失败"}
                </span>
              </td>
              <td>{row.approved_by ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <div className="empty-state__message">{message}</div>
    </div>
  );
}
