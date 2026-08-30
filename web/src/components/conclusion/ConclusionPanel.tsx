import { ConclusionCard } from './ConclusionCard.js'
import type { RootCause, Remediation } from '../../lib/types.js'
import type { InvestigationProgress } from '../../lib/progress.js'
import './conclusion-panel.css'

interface ConclusionPanelProps {
  running: boolean
  statusMessage?: string
  progress: InvestigationProgress | null
  rootCause?: RootCause
  remediation?: Remediation
  onCitationClick: (evidenceId: string) => void
  dismissed: boolean
  onDismiss: () => void
  onReopen: () => void
}

export function ConclusionPanel({
  running,
  statusMessage,
  progress,
  rootCause,
  remediation,
  onCitationClick,
  dismissed,
  onDismiss,
  onReopen,
}: ConclusionPanelProps) {
  if (dismissed) {
    return rootCause ? (
      <div className="conclusion-panel__reopen-row">
        <button type="button" className="conclusion-panel__reopen" onClick={onReopen}>
          🎯 查看根因结论
        </button>
      </div>
    ) : null
  }

  if (rootCause) {
    return (
      <div className="conclusion-panel conclusion-panel--card">
        <button
          type="button"
          className="conclusion-panel__close"
          onClick={onDismiss}
          title="关闭结论"
          aria-label="关闭结论"
        >
          ✕
        </button>
        <ConclusionCard
          rootCause={rootCause}
          remediation={remediation}
          onCitationClick={onCitationClick}
        />
      </div>
    )
  }

  if (running && progress) {
    return (
      <div className="conclusion-panel conclusion-panel--progress">
        <button
          type="button"
          className="conclusion-panel__close"
          onClick={onDismiss}
          title="隐藏进度"
          aria-label="隐藏进度"
        >
          ✕
        </button>
        <span className="conclusion-panel__status">{statusMessage ?? progress.label}</span>
        <div className="conclusion-panel__bar">
          <div className="conclusion-panel__bar-fill" style={{ width: `${progress.percent}%` }} />
        </div>
        <span className="conclusion-panel__step">
          阶段 {progress.step}/{progress.total}
        </span>
      </div>
    )
  }

  return null
}
