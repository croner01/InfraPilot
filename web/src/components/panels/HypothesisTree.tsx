import { EvidenceCitation } from '../conclusion/EvidenceCitation.js'
import type { Hypothesis } from '../../lib/types.js'
import './hypothesis-tree.css'

interface HypothesisTreeProps {
  hypotheses: Hypothesis[]
  onCitationClick?: (evidenceId: string) => void
}

const statusMeta = {
  active: { label: '待验证', tone: 'active' },
  confirmed: { label: '已确认', tone: 'confirmed' },
  ruled_out: { label: '已排除', tone: 'ruled' },
} as const

export function HypothesisTree({ hypotheses, onCitationClick }: HypothesisTreeProps) {
  if (hypotheses.length === 0) {
    return <p className="hypothesis-tree__empty">暂无假设，Agent 分析后将在此展示推理过程</p>
  }
  return (
    <div className="hypothesis-tree">
      {hypotheses.map((hypothesis, index) => {
        const meta = statusMeta[hypothesis.status] ?? statusMeta.active
        return (
          <div key={hypothesis.id} className={`hypothesis-card hypothesis-card--${meta.tone}`}>
            <div className="hypothesis-card__head">
              <span className={`hypothesis-card__status hypothesis-card__status--${meta.tone}`}>{meta.label}</span>
              <span className="hypothesis-card__idx">H{index + 1}</span>
            </div>
            <p className="hypothesis-card__text">{hypothesis.statement}</p>
            {hypothesis.evidenceIds.length > 0 && onCitationClick && (
              <div className="hypothesis-card__refs">
                {hypothesis.evidenceIds.map((id) => (
                  <EvidenceCitation key={id} label={`证据 ${id}`} onClick={() => onCitationClick(id)} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
