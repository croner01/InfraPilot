import { useMemo, useState } from 'react'
import { HealthGrid } from './HealthGrid.js'
import { AlertList, type AlertItem } from './AlertList.js'
import type { AlertSourceType, AlertStatus, ServiceHealth } from '../../lib/types.js'
import './alert-center.css'

/** 告警来源通道筛选（Alertmanager webhook / 日志规则 / 主动巡检 / 手动） */
const SOURCE_TYPE_OPTIONS: Array<{ value: AlertSourceType | 'all'; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'alertmanager', label: 'Alertmanager' },
  { value: 'log_rule', label: '日志规则' },
  { value: 'health_check', label: '主动巡检' },
  { value: 'manual', label: '手动' },
]

/** 从 source 字符串推断来源通道（与 AlertList 的兜底逻辑一致） */
function inferSourceType(alert: AlertItem): AlertSourceType {
  if (alert.sourceType) return alert.sourceType
  const s = alert.source.toLowerCase()
  if (s.includes('prometheus') || s.includes('alertmanager') || s.includes('node_exporter')) return 'alertmanager'
  if (s.includes('elk') || s.includes('opensearch') || s.includes('日志')) return 'log_rule'
  if (s.includes('巡检') || s.includes('health')) return 'health_check'
  return 'manual'
}

const STATUS_FILTERS: Array<{ value: AlertStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'firing', label: '待处理' },
  { value: 'diagnosing', label: '诊断中' },
  { value: 'acknowledged', label: '已确认' },
  { value: 'resolved', label: '已解决' },
]

interface AlertCenterProps {
  alerts: AlertItem[]
  loading: boolean
  error?: string | null
  /** 服务健康（GET /api/health/services，真实 Prometheus 聚合） */
  services?: ServiceHealth[]
  servicesLoading?: boolean
  servicesError?: string | null
  servicesSource?: string
  onInvestigate: (id: string) => void
  /** 点击服务健康卡片 → 直接发起该 Deployment 的诊断会话 */
  onDiagnoseService?: (service: ServiceHealth) => void
  onAcknowledge?: (id: string) => void
  onResolve?: (id: string) => void
  onOpenSession?: (sessionId: string) => void
}

export function AlertCenter({
  alerts,
  loading,
  error,
  services = [],
  servicesLoading = false,
  servicesError = null,
  servicesSource = 'none',
  onInvestigate,
  onDiagnoseService,
  onAcknowledge,
  onResolve,
  onOpenSession,
}: AlertCenterProps) {
  const [statusFilter, setStatusFilter] = useState<AlertStatus | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<AlertSourceType | 'all'>('all')
  const [severityFilter, setSeverityFilter] = useState<AlertItem['severity'] | 'all'>('all')
  const [search, setSearch] = useState('')

  const stats = useMemo(
    () => ({
      firingP0: alerts.filter((a) => a.status === 'firing' && a.severity === 'p0').length,
      firing: alerts.filter((a) => a.status === 'firing').length,
      diagnosing: alerts.filter((a) => a.status === 'diagnosing').length,
      acknowledged: alerts.filter((a) => a.status === 'acknowledged').length,
      resolved: alerts.filter((a) => a.status === 'resolved').length,
      total: alerts.length,
    }),
    [alerts],
  )

  const filteredAlerts = alerts.filter((a) => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false
    if (severityFilter !== 'all' && a.severity !== severityFilter) return false
    if (sourceFilter !== 'all' && inferSourceType(a) !== sourceFilter) return false
    if (search && !`${a.title} ${a.source} ${a.service}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div className="alert-center">
      <header className="alert-center__head">
        <h1>告警中心</h1>
        <p>服务健康总览与待处理告警 · 支持 Alertmanager / 日志规则 / 主动巡检多通道接入</p>
      </header>

      <div className="alert-center__stats">
        <div className="alert-stat alert-stat--danger">
          <div className="alert-stat__label">P0 待处理</div>
          <div className="alert-stat__value">{stats.firingP0}</div>
        </div>
        <div className="alert-stat">
          <div className="alert-stat__label">待处理</div>
          <div className="alert-stat__value">{stats.firing}</div>
        </div>
        <div className="alert-stat alert-stat--accent">
          <div className="alert-stat__label">诊断中</div>
          <div className="alert-stat__value">{stats.diagnosing}</div>
        </div>
        <div className="alert-stat alert-stat--warn">
          <div className="alert-stat__label">已确认</div>
          <div className="alert-stat__value">{stats.acknowledged}</div>
        </div>
        <div className="alert-stat alert-stat--success">
          <div className="alert-stat__label">已解决</div>
          <div className="alert-stat__value">{stats.resolved}</div>
        </div>
        <div className="alert-stat">
          <div className="alert-stat__label">累计告警</div>
          <div className="alert-stat__value">{stats.total}</div>
        </div>
      </div>

      <section className="alert-center__section">
        <h2>服务健康</h2>
        {servicesLoading ? (
          <p className="alert-center__state">加载中…</p>
        ) : services.length === 0 ? (
          <p className="alert-center__state">
            {servicesError ? `数据源异常：${servicesError}` : '暂无服务数据（请检查 Prometheus 数据源配置）'}
          </p>
        ) : (
          <>
            <HealthGrid services={services} onDiagnose={onDiagnoseService} />
            <p className="alert-center__hint">
              数据来源：{servicesSource === 'prometheus' ? 'Prometheus kube-state-metrics' : servicesSource}
              {onDiagnoseService ? ' · 点击卡片可直接发起诊断' : ''}
            </p>
          </>
        )}
      </section>

      <section className="alert-center__section">
        <h2>告警列表</h2>
        <div className="alert-toolbar">
          <div className="alert-toolbar__tabs">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                className={`alert-toolbar__tab${statusFilter === f.value ? ' alert-toolbar__tab--active' : ''}`}
                onClick={() => setStatusFilter(f.value)}
              >
                {f.label}
                {f.value !== 'all' && (
                  <span className="alert-toolbar__tab-count">
                    {alerts.filter((a) => a.status === f.value).length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="alert-toolbar__filters">
            <select
              className="alert-toolbar__select"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as AlertSourceType | 'all')}
            >
              {SOURCE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="alert-toolbar__select"
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value as AlertItem['severity'] | 'all')}
            >
              <option value="all">全部级别</option>
              <option value="p0">P0 严重</option>
              <option value="p1">P1 警告</option>
              <option value="p2">P2 提示</option>
            </select>
            <input
              className="alert-toolbar__search"
              placeholder="搜索标题 / 服务 / 来源…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {loading ? (
          <p className="alert-center__state">加载中…</p>
        ) : error ? (
          <p className="alert-center__state alert-center__state--error">{error}</p>
        ) : filteredAlerts.length === 0 ? (
          <p className="alert-center__state">{alerts.length === 0 ? '暂无告警' : '当前筛选条件下无匹配告警'}</p>
        ) : (
          <AlertList
            alerts={filteredAlerts}
            onInvestigate={onInvestigate}
            onAcknowledge={onAcknowledge}
            onResolve={onResolve}
            onOpenSession={onOpenSession}
          />
        )}
      </section>

      <section className="alert-center__section">
        <h2>快捷入口</h2>
        <div className="quick-row">
          <div className="quick-card"><b>排查 Pod 异常</b><span>输入故障现象，Agent 自动诊断</span></div>
          <div className="quick-card"><b>查询日志</b><span>按服务/关键字检索 ELK 日志</span></div>
          <div className="quick-card"><b>查看告警</b><span>进入告警中心处理待办</span></div>
        </div>
      </section>
    </div>
  )
}
