import type { Evidence } from '../../lib/types.js'
import './evidence-list.css'

interface EvidenceListProps {
  evidence: Evidence[]
  highlightId?: string | null
}

export function EvidenceList({ evidence, highlightId }: EvidenceListProps) {
  if (evidence.length === 0) {
    return <p className="evidence-list__empty">暂无证据，等待 Agent 收集诊断证据</p>
  }
  return (
    <div className="evidence-list">
      {evidence.map((item) => (
        <div
          key={item.id}
          id={`evidence-${item.id}`}
          className={`ev-card${highlightId === item.id ? ' ev-card--highlight' : ''}`}
        >
          <div className="ev-card__head">
            <span className="ev-card__type">{item.sourceSkill ?? item.type}</span>
            <span className="ev-card__confidence">置信度 {Math.round(item.confidence * 100)}%</span>
          </div>
          <div className="ev-card__summary">{item.summary}</div>
          {item.content && (
            <pre className="ev-card__content">
              {typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2)}
            </pre>
          )}
          <div className="ev-card__time">{new Date(item.collectedAt).toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}
