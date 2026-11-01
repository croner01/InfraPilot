import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { Markdown } from '../ui/Markdown.js'
import { EvidenceCitation } from './EvidenceCitation.js'
import type { RootCause, Remediation, RiskLevel } from '../../lib/types.js'
import './conclusion-card.css'

const roleLabel: Record<string, string> = {
  primary: '主要',
  supporting: '支撑',
  ruled_out: '已排除',
}

const riskTone: Record<RiskLevel, 'info' | 'success' | 'warn' | 'orange' | 'danger'> = {
  readonly: 'info',
  low: 'success',
  medium: 'warn',
  high: 'orange',
  critical: 'danger',
}

const statusMeta: Record<string, { label: string; tone: 'success' | 'warn' | 'accent' | 'info' }> = {
  concluded: { label: '已修复 · 待观察', tone: 'success' },
  remediating: { label: '修复执行中', tone: 'warn' },
  closed: { label: '已归档', tone: 'info' },
  awaiting_approval: { label: '待审批', tone: 'warn' },
}

interface ConclusionCardProps {
  rootCause: RootCause
  remediation?: Remediation | null
  /** 会话状态：用于展示「已修复 · 待观察」等结论态徽标 */
  sessionStatus?: string
  onCitationClick: (evidenceId: string) => void
  onApproveRemediation?: () => void
}

export function ConclusionCard({
  rootCause,
  remediation,
  sessionStatus,
  onCitationClick,
  onApproveRemediation,
}: ConclusionCardProps) {
  // 结论未给出置信度时不显示 0%：0% 会被误读成「完全不可信」
  const confidence =
    typeof rootCause.confidence === 'number' ? Math.round(rootCause.confidence * 100) : null
  const status = sessionStatus ? statusMeta[sessionStatus] : undefined

  return (
    <section className="conclusion-card">
      <div className="conclusion-card__head">
        <h2 className="conclusion-card__title">根因分析结论</h2>
        <Badge label={confidence === null ? '置信度 未给出' : `置信度 ${confidence}%`} tone="accent" />
        {status && <Badge label={status.label} tone={status.tone} />}
      </div>
      {confidence !== null && (
        <div className="conclusion-card__confidence" title={`综合置信度 ${confidence}%`}>
          <span className="conclusion-card__confidence-track">
            <span className="conclusion-card__confidence-fill" style={{ width: `${Math.max(4, Math.min(100, confidence))}%` }} />
          </span>
          <span className="conclusion-card__confidence-value">{confidence}%</span>
        </div>
      )}
      <div className="conclusion-card__summary">
        <Markdown>{rootCause.summary}</Markdown>
      </div>
      {rootCause.evidenceChain.length > 0 && (
        <div className="conclusion-card__chain">
          {rootCause.evidenceChain.map((ref, index) => (
            <EvidenceCitation
              key={ref.evidenceId}
              label={`证据#${index + 1}${roleLabel[ref.role] ? ` · ${roleLabel[ref.role]}` : ''}`}
              title={ref.claim}
              onClick={() => onCitationClick(ref.evidenceId)}
            />
          ))}
        </div>
      )}
      {rootCause.alternativeHypotheses.length > 0 && (
        <div className="conclusion-card__alt">
          <span className="conclusion-card__alt-label">已排除假设</span>
          <ul>
            {rootCause.alternativeHypotheses.map((hypothesis) => (
              <li key={hypothesis}>{hypothesis}</li>
            ))}
          </ul>
        </div>
      )}
      {remediation && remediation.steps.length > 0 && (
        <div className="conclusion-card__remediation">
          <div className="conclusion-card__remediation-title">修复建议</div>
          {remediation.steps.map((step, index) => (
            <div key={index} className="remediation-row">
              <span className="remediation-row__idx">{index + 1}</span>
              <span className="remediation-row__desc">{step.description}</span>
              {step.skill && step.tool && <code className="remediation-row__cmd">{step.skill}.{step.tool}()</code>}
              {step.risk && <Badge label={step.risk} tone={riskTone[step.risk]} />}
            </div>
          ))}
        </div>
      )}
      {onApproveRemediation && (
        <div className="conclusion-card__actions">
          <Button variant="primary" onClick={onApproveRemediation}>
            批准执行修复
          </Button>
          <Button variant="secondary">拒绝</Button>
        </div>
      )}
    </section>
  )
}
