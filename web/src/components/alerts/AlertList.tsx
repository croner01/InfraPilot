import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { formatTime } from '../../lib/format.js'
import './alert-list.css'

export type AlertSeverity = 'p0' | 'p1' | 'p2'
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged'

export interface AlertItem {
  id: string
  severity: AlertSeverity
  title: string
  source: string
  startedAt: string
  status: AlertStatus
}

interface AlertListProps {
  alerts: AlertItem[]
  onInvestigate: (id: string) => void
}

const severityMeta: Record<AlertSeverity, { label: string; tone: 'danger' | 'warn' | 'info' }> = {
  p0: { label: 'P0 严重', tone: 'danger' },
  p1: { label: 'P1 警告', tone: 'warn' },
  p2: { label: 'P2 提示', tone: 'info' },
}

const statusLabel: Record<AlertStatus, string> = {
  firing: '处理中',
  resolved: '已解决',
  acknowledged: '已确认',
}

export function AlertList({ alerts, onInvestigate }: AlertListProps) {
  return (
    <div className="alert-list">
      {alerts.map((alert) => {
        const severity = severityMeta[alert.severity]
        return (
          <div key={alert.id} className="alert-row">
            <Badge label={severity.label} tone={severity.tone} />
            <div className="alert-row__main">
              <div className="alert-row__title">{alert.title}</div>
              <div className="alert-row__source">{alert.source}</div>
            </div>
            <span className="alert-row__time">{formatTime(alert.startedAt)}</span>
            <Badge label={statusLabel[alert.status]} tone={alert.status === 'firing' ? severity.tone : 'neutral'} />
            <Button size="sm" onClick={() => onInvestigate(alert.id)}>
              一键开查
            </Button>
          </div>
        )
      })}
    </div>
  )
}
