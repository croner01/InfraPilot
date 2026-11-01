import { useState } from 'react'
import { Badge, type BadgeTone } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { formatTime } from '../../lib/format.js'
import type { Alert, AlertSourceType, AlertStatus } from '../../lib/types.js'
import './alert-list.css'

export type { Alert, AlertSeverity, AlertStatus } from '../../lib/types.js'

interface AlertListProps {
  alerts: AlertItem[]
  onInvestigate: (id: string) => void
  /** 标记已确认（PATCH /api/alerts/:id） */
  onAcknowledge?: (id: string) => void
  /** 标记已解决（PATCH /api/alerts/:id） */
  onResolve?: (id: string) => void
  /** 打开关联的诊断会话 */
  onOpenSession?: (sessionId: string) => void
}

export type AlertItem = Alert

const severityMeta: Record<Alert['severity'], { label: string; tone: 'danger' | 'warn' | 'info' }> = {
  p0: { label: 'P0 严重', tone: 'danger' },
  p1: { label: 'P1 警告', tone: 'warn' },
  p2: { label: 'P2 提示', tone: 'info' },
}

const statusMeta: Record<AlertStatus, { label: string; tone: 'danger' | 'warn' | 'info' | 'success' | 'accent' }> = {
  firing: { label: '待处理', tone: 'danger' },
  acknowledged: { label: '已确认', tone: 'warn' },
  diagnosing: { label: '诊断中', tone: 'accent' },
  resolved: { label: '已解决', tone: 'success' },
}

const sourceTypeMeta: Record<AlertSourceType, { label: string; tone: BadgeTone }> = {
  alertmanager: { label: 'Alertmanager', tone: 'orange' },
  log_rule: { label: '日志规则', tone: 'info' },
  health_check: { label: '主动巡检', tone: 'accent' },
  manual: { label: '手动', tone: 'neutral' },
}

/** 从 source 字符串推断来源通道（后端未返回 sourceType 时的兜底展示） */
function inferSourceType(alert: AlertItem): AlertSourceType {
  if (alert.sourceType) return alert.sourceType
  const s = alert.source.toLowerCase()
  if (s.includes('prometheus') || s.includes('alertmanager') || s.includes('node_exporter')) return 'alertmanager'
  if (s.includes('elk') || s.includes('opensearch') || s.includes('日志')) return 'log_rule'
  if (s.includes('巡检') || s.includes('health')) return 'health_check'
  return 'manual'
}

export function AlertList({ alerts, onInvestigate, onAcknowledge, onResolve, onOpenSession }: AlertListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="alert-list">
      {alerts.map((alert) => {
        const severity = severityMeta[alert.severity]
        const status = statusMeta[alert.status]
        const sourceType = sourceTypeMeta[inferSourceType(alert)]
        const expanded = expandedId === alert.id
        const hasDetail = Boolean(alert.labels || alert.annotations || alert.count || alert.sessionId)
        return (
          <div key={alert.id} className={`alert-row-wrap${expanded ? ' alert-row-wrap--open' : ''}`}>
            <div
              className="alert-row"
              onClick={() => hasDetail && setExpandedId(expanded ? null : alert.id)}
              role={hasDetail ? 'button' : undefined}
            >
              <div className="alert-row__badges">
                <Badge label={severity.label} tone={severity.tone} />
                <Badge label={sourceType.label} tone={sourceType.tone} />
              </div>
              <div className="alert-row__main">
                <div className="alert-row__title">
                  {alert.title}
                  {alert.count && alert.count > 1 && (
                    <span className="alert-row__count" title={`同一指纹累计触发 ${alert.count} 次（防抖合并）`}>
                      ×{alert.count}
                    </span>
                  )}
                </div>
                <div className="alert-row__source">{alert.source}</div>
              </div>
              <span className="alert-row__time">{formatTime(alert.startedAt)}</span>
              <Badge label={status.label} tone={status.tone} />
              <div className="alert-row__actions" onClick={(e) => e.stopPropagation()}>
                {alert.status === 'diagnosing' && alert.sessionId && onOpenSession && (
                  <Button size="sm" variant="ghost" onClick={() => onOpenSession(alert.sessionId!)}>
                    查看会话
                  </Button>
                )}
                {(alert.status === 'firing' || alert.status === 'diagnosing') && onAcknowledge && (
                  <Button size="sm" variant="ghost" onClick={() => onAcknowledge(alert.id)}>
                    确认
                  </Button>
                )}
                {alert.status !== 'resolved' && onResolve && (
                  <Button size="sm" variant="ghost" onClick={() => onResolve(alert.id)}>
                    解决
                  </Button>
                )}
                {alert.status !== 'resolved' && (
                  <Button size="sm" onClick={() => onInvestigate(alert.id)}>
                    一键开查
                  </Button>
                )}
                {hasDetail && <span className={`alert-row__caret${expanded ? ' alert-row__caret--open' : ''}`}>▾</span>}
              </div>
            </div>
            {expanded && (
              <div className="alert-row__detail">
                {alert.annotations && (
                  <div className="alert-detail__block">
                    <div className="alert-detail__label">描述 / Runbook</div>
                    {Object.entries(alert.annotations).map(([k, v]) => (
                      <div key={k} className="alert-detail__line">
                        <b>{k}</b>
                        <span>{k === 'runbook_url' ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : v}</span>
                      </div>
                    ))}
                  </div>
                )}
                {alert.labels && (
                  <div className="alert-detail__block">
                    <div className="alert-detail__label">原始标签</div>
                    <div className="alert-detail__tags">
                      {Object.entries(alert.labels).map(([k, v]) => (
                        <code key={k} className="alert-detail__tag">
                          {k}={v}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
                <div className="alert-detail__block alert-detail__block--meta">
                  <div className="alert-detail__line">
                    <b>触发时间</b>
                    <span>{formatTime(alert.startedAt)}</span>
                  </div>
                  {alert.ackAt && (
                    <div className="alert-detail__line">
                      <b>确认时间</b>
                      <span>{formatTime(alert.ackAt)}</span>
                    </div>
                  )}
                  {alert.resolvedAt && (
                    <div className="alert-detail__line">
                      <b>解决时间</b>
                      <span>{formatTime(alert.resolvedAt)}</span>
                    </div>
                  )}
                  {alert.fingerprint && (
                    <div className="alert-detail__line">
                      <b>fingerprint</b>
                      <span className="alert-detail__mono">{alert.fingerprint}</span>
                    </div>
                  )}
                  {alert.sessionId && (
                    <div className="alert-detail__line">
                      <b>诊断会话</b>
                      <span className="alert-detail__mono">{alert.sessionId}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
