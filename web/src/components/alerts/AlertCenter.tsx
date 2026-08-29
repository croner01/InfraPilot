import { HealthGrid } from './HealthGrid.js'
import { AlertList, type AlertItem } from './AlertList.js'
import './alert-center.css'

const demoServices = [
  { name: 'order-api', meta: 'order-service · 3 副本', status: 'err' as const, metricLabel: '内存占用', metricValue: '98%', chart: [10, 12, 15, 22, 30] },
  { name: 'gateway', meta: 'edge · 2 副本', status: 'ok' as const, metricLabel: '请求延迟 p99', metricValue: '42ms', chart: [20, 18, 21, 19, 20] },
  { name: 'payment-service', meta: 'pay · 2 副本', status: 'warn' as const, metricLabel: '5xx 比例', metricValue: '1.8%', chart: [12, 14, 16, 20, 24] },
  { name: 'auth-service', meta: 'iam · 2 副本', status: 'ok' as const, metricLabel: 'QPS', metricValue: '1.2k', chart: [15, 16, 15, 17, 16] },
]

interface AlertCenterProps {
  alerts: AlertItem[]
  loading: boolean
  error?: string | null
  onInvestigate: (id: string) => void
}

export function AlertCenter({ alerts, loading, error, onInvestigate }: AlertCenterProps) {
  return (
    <div className="alert-center">
      <header className="alert-center__head">
        <h1>告警中心</h1>
        <p>服务健康总览与待处理告警</p>
      </header>
      <section className="alert-center__section">
        <h2>服务健康</h2>
        <HealthGrid services={demoServices} />
      </section>
      <section className="alert-center__section">
        <h2>最近告警</h2>
        {loading ? (
          <p className="alert-center__state">加载中…</p>
        ) : error ? (
          <p className="alert-center__state alert-center__state--error">{error}</p>
        ) : alerts.length === 0 ? (
          <p className="alert-center__state">暂无告警</p>
        ) : (
          <AlertList alerts={alerts} onInvestigate={onInvestigate} />
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
