import { useState } from 'react'
import './process-section.css'

export type ProcessItem = {
  key: string
  icon: 'tool' | 'result' | 'evidence' | 'plan' | 'status'
  status?: 'ok' | 'fail' | 'running'
  title: string
  detail?: string
  time?: string
}

interface ProcessSectionProps {
  items: ProcessItem[]
  autoOpen?: boolean
  runningLabel?: string
}

export function ProcessSection({ items, autoOpen = false, runningLabel }: ProcessSectionProps) {
  const [open, setOpen] = useState(autoOpen)
  const toolCount = items.filter((item) => item.icon === 'result').length
  const evidenceCount = items.filter((item) => item.icon === 'evidence').length

  return (
    <div className={`ui-process-group${open ? ' ui-process-group--open' : ''}`}>
      <button
        type="button"
        className="ui-process-group__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ui-process-group__title">诊断过程</span>
        <span className="ui-process-group__meta">
          {runningLabel ? (
            <>
              <span className="ui-process-group__running">正在执行 {runningLabel}</span>
              <span className="ui-process-group__counts">
                已执行 {toolCount} 个工具 · 收集 {evidenceCount} 条证据
              </span>
            </>
          ) : (
            <>已执行 {toolCount} 个工具 · 收集 {evidenceCount} 条证据</>
          )}
        </span>
        <span className="ui-process-group__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ui-process-group__body">
          {items.map((item) => (
            <div key={item.key} className="ui-process-row">
              <ProcessIcon item={item} />
              <span className="ui-process-row__title">{item.title}</span>
              {item.detail && <span className="ui-process-row__detail">{item.detail}</span>}
              {item.time && <span className="ui-process-row__time">{item.time}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProcessIcon({ item }: { item: ProcessItem }) {
  if (item.icon === 'result') {
    return <span className={`ui-process-row__icon ui-process-row__icon--${item.status}`}>{item.status === 'ok' ? '✓' : '✗'}</span>
  }
  if (item.icon === 'tool') {
    return <span className="ui-process-row__icon ui-process-row__icon--running">●</span>
  }
  if (item.icon === 'evidence') {
    return (
      <span className="ui-process-row__icon">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      </span>
    )
  }
  if (item.icon === 'plan') {
    return (
      <span className="ui-process-row__icon">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      </span>
    )
  }
  return (
    <span className="ui-process-row__icon">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    </span>
  )
}
