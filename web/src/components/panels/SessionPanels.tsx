import { useEffect, useState } from 'react'
import { artifactDownloadUrl, deleteArtifact, fetchSessionAudit, listArtifacts, type Artifact } from '../../lib/api.js'
import type { AgentSession, Remediation, TimelineEvent } from '../../lib/types.js'
import { HypothesisTree } from './HypothesisTree.js'
import { AuditCallList } from '../conversation/ExecutionTrackPanel.js'
import './session-panels.css'

/**
 * 右栏扩展面板：诊断计划（含假设） / 修复方案 / 审计 / 会话产物。
 * 原「会话页 Tab 行」下线后，这些内容统一收进右栏，随 Tab 激活时才挂载请求数据。
 */

function Empty({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="ui-panel-empty">
      <span className="ui-panel-empty__icon">{icon}</span>
      <span className="ui-panel-empty__text">{message}</span>
    </div>
  )
}

/** 诊断计划 + 假设树 */
export function PlanPanel({ session, onCitationClick }: { session: AgentSession; onCitationClick?: (evidenceId: string) => void }) {
  const hypotheses = session.hypotheses ?? []
  return (
    <div className="ui-panel">
      <div className="ui-panel__section-title">诊断计划（{session.plan.length}）</div>
      {session.plan.length === 0 ? (
        <Empty icon="📋" message="诊断计划尚未生成" />
      ) : (
        <ol className="ui-plan-list">
          {session.plan.map((step, idx) => (
            <li key={idx} className="ui-plan-item">
              <span className="ui-plan-item__idx">{idx + 1}</span>
              <span className="ui-plan-item__text">{step}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="ui-panel__section-title">假设（{hypotheses.length}）</div>
      <HypothesisTree hypotheses={hypotheses} onCitationClick={onCitationClick ?? (() => {})} />
    </div>
  )
}

/** 修复方案 */
export function RemediationPanel({ remediation, status }: { remediation?: Remediation; status?: string }) {
  if (!remediation || remediation.steps.length === 0) {
    return (
      <div className="ui-panel">
        <div className="ui-panel__section-title">修复方案</div>
        <Empty icon="🛠️" message="暂无修复方案" />
      </div>
    )
  }
  const pending = status === 'awaiting_approval'
  return (
    <div className="ui-panel">
      <div className="ui-panel__section-title">
        修复方案（{remediation.steps.length}）
        {pending && <span className="ui-panel__flag">待审批</span>}
      </div>
      {remediation.summary && <div className="ui-remediation__summary">{remediation.summary}</div>}
      <div className="ui-remediation__steps">
        {remediation.steps.map((step, idx) => (
          <div key={idx} className="ui-remediation__step">
            <div className="ui-remediation__head">
              <span className="ui-remediation__idx">{idx + 1}</span>
              <span className="ui-remediation__title">{step.description}</span>
              {step.risk && <span className={`risk-badge risk-badge--${step.risk}`}>{step.risk}</span>}
            </div>
            {step.skill && step.tool && <code className="ui-remediation__tool">{step.skill}.{step.tool}()</code>}
            {step.args && Object.keys(step.args).length > 0 && (
              <pre className="ui-remediation__args">{JSON.stringify(step.args, null, 2)}</pre>
            )}
            {step.rollback && <div className="ui-remediation__rollback">回滚：{step.rollback}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 审计：优先服务端审计表（含审批人/哈希），为空时回退到事件流调用记录 */
export function AuditPanel({ session, events }: { session: AgentSession; events: TimelineEvent[] }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetchSessionAudit(session.id)
      .then((data) => {
        if (active) setRows(data ?? [])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [session.id])

  if (loading) return <div className="ui-panel"><div className="ui-panel__loading">加载审计记录…</div></div>

  if (!rows || rows.length === 0) {
    return (
      <div className="ui-panel">
        <div className="ui-panel__section-title">事件流调用记录</div>
        <AuditCallList events={events} session={session} />
      </div>
    )
  }

  return (
    <div className="ui-panel">
      <div className="ui-panel__section-title">审计记录（{rows.length}）</div>
      <ul className="ui-audit">
        {rows.map((row: any, idx: number) => {
          const ok = Number(row.success) === 1 || row.success === true
          return (
            <li key={idx} className="ui-audit__row">
              <span className={`ui-audit__dot${ok ? ' ui-audit__dot--ok' : ' ui-audit__dot--fail'}`} />
              <div className="ui-audit__body">
                <div className="ui-audit__name">{row.skill}.{row.tool}</div>
                <div className="ui-audit__meta">
                  <span>{new Date(row.started_at ?? row.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                  <span className={`risk-badge risk-badge--${row.risk_level ?? 'readonly'}`}>{row.risk_level ?? 'readonly'}</span>
                  <span>{ok ? '成功' : '失败'}</span>
                  {row.approved_by && <span>审批 {row.approved_by}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="ui-panel__hint">审计表由 Command Gateway 落库，含审批哈希与脱敏输出。</div>
    </div>
  )
}

/** 会话产物 */
export function ArtifactsPanel({ sessionId }: { sessionId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    listArtifacts(sessionId)
      .then((res) => {
        if (active) setArtifacts(res?.artifacts ?? [])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [sessionId])

  const handleDelete = async (id: string) => {
    await deleteArtifact(id)
    setArtifacts((prev) => (prev ? prev.filter((a) => a.id !== id) : prev))
  }

  if (loading) return <div className="ui-panel"><div className="ui-panel__loading">加载会话产物…</div></div>
  const items = artifacts ?? []
  if (items.length === 0) {
    return (
      <div className="ui-panel">
        <div className="ui-panel__section-title">会话产物</div>
        <Empty icon="📦" message="暂无产物，技能执行生成的文件会出现在这里" />
      </div>
    )
  }

  return (
    <div className="ui-panel">
      <div className="ui-panel__section-title">会话产物（{items.length}）</div>
      <ul className="ui-artifacts">
        {items.map((a) => (
          <li key={a.id} className="ui-artifacts__item">
            <span className="ui-artifacts__icon">{a.kind === 'diagram' ? '📐' : '📄'}</span>
            <span className="ui-artifacts__name" title={a.name}>{a.name}</span>
            <span className="ui-artifacts__meta">{new Date(a.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <a className="ui-artifacts__action" href={artifactDownloadUrl(a.id)} target="_blank" rel="noreferrer" title="下载">
              下载
            </a>
            <button type="button" className="ui-artifacts__action ui-artifacts__action--danger" onClick={() => void handleDelete(a.id)} title="删除">
              删除
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
