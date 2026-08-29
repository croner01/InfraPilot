import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
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

interface ConclusionCardProps {
  rootCause: RootCause
  remediation?: Remediation
  onCitationClick: (evidenceId: string) => void
  onApproveRemediation?: () => void
}

export function ConclusionCard({
  rootCause,
  remediation,
  onCitationClick,
  onApproveRemediation,
}: ConclusionCardProps) {
  const confidence = Math.round((rootCause.confidence ?? 0) * 100)

  return (
    <section className="conclusion-card">
      <div className="conclusion-card__head">
        <h2 className="conclusion-card__title">根因分析结论</h2>
        <Badge label={`置信度 ${confidence}%`} tone="accent" />
      </div>
      <p className="conclusion-card__summary">{rootCause.summary}</p>
      {rootCause.evidenceChain.length > 0 && (
        <div className="conclusion-card__chain">
          {rootCause.evidenceChain.map((ref, index) => (
            <EvidenceCitation
              key={ref.evidenceId}
              label={`证据#${index + 1}${roleLabel[ref.role] ? ` · ${roleLabel[ref.role]}` : ''}`}
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
