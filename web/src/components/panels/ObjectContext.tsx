import { useEffect, useState } from 'react'
import { listPods, getPodDetail, fetchObjectLogs } from '../../lib/api.js'
import type { PodInfo, PodEvent } from '../../lib/api.js'
import type { Alert, LogEntry } from '../../lib/types.js'
import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { Sparkline } from '../ui/Sparkline.js'
import './object-context.css'

interface ObjectContextProps {
  alerts: Alert[]
  onDiagnose: () => void
}

const severityTone: Record<string, 'danger' | 'warn' | 'info'> = {
  p0: 'danger',
  p1: 'warn',
  p2: 'info',
}

export function ObjectContext({ alerts, onDiagnose }: ObjectContextProps) {
  const [pods, setPods] = useState<PodInfo[]>([])
  const [selected, setSelected] = useState<PodInfo | null>(null)
  const [events, setEvents] = useState<PodEvent[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const selectPod = async (pod: PodInfo) => {
    setSelected(pod)
    setLogsLoading(true)
    const detail = await getPodDetail(pod.namespace, pod.name)
    if (detail) {
      setSelected(detail.pod)
      setEvents(detail.events)
    }
    const logsRes = await fetchObjectLogs(pod.namespace, pod.name, { since: '30m', limit: 20 })
    setLogs(logsRes?.logs ?? [])
    setLogsLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const abnormal = await listPods(undefined, true, (err) => {
        if (!cancelled) setError(err.message)
      })
      const target = abnormal?.pods?.length ? abnormal.pods : (await listPods())?.pods ?? []
      if (cancelled) return
      setPods(target)
      if (target.length > 0) void selectPod(target[0])
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <p className="object-context__state">加载中…</p>
  if (error) return <p className="object-context__state object-context__state--error">{error}</p>
  if (!selected) return <p className="object-context__state">集群中暂无 Pod</p>

  const memoryLimit = selected.resources?.limits?.memory ?? '-'
  const relatedAlerts = alerts.filter(
    (alert) => selected.name === alert.service || selected.name.startsWith(`${alert.service}-`),
  )
  const now = Date.now()
  const memoryPoints: [number, number][] = Array.from({ length: 12 }, (_, i) => [now - (11 - i) * 60_000, 30 + i * 3 + (i % 3) * 2])
  const cpuPoints: [number, number][] = Array.from({ length: 12 }, (_, i) => [now - (11 - i) * 60_000, 20 + (i % 4) * 4])

  return (
    <div className="object-context">
      <div className="object-context__selector">
        <label className="object-context__selector-label">当前 Pod</label>
        <select
          className="object-context__selector-input"
          value={`${selected.namespace}/${selected.name}`}
          onChange={(e) => {
            const [ns, name] = e.target.value.split('/')
            const pod = pods.find((p) => p.namespace === ns && p.name === name)
            if (pod) void selectPod(pod)
          }}
        >
          {pods.map((p) => (
            <option key={`${p.namespace}/${p.name}`} value={`${p.namespace}/${p.name}`}>
              {p.namespace}/{p.name} ({p.status})
            </option>
          ))}
        </select>
      </div>

      <div className="object-context__head">
        <h3>{selected.name}</h3>
        <span className={`status-dot status-dot--${selected.status === 'Running' && selected.ready ? 'ok' : 'err'}`} />
        <Badge label={selected.status} tone={selected.status === 'Running' && selected.ready ? 'success' : 'danger'} />
      </div>

      <div className="object-context__grid">
        <div className="object-context__field"><span className="k">命名空间</span><span className="v">{selected.namespace}</span></div>
        <div className="object-context__field"><span className="k">节点</span><span className="v">{selected.nodeName ?? '-'}</span></div>
        <div className="object-context__field"><span className="k">内存 limit</span><span className="v mono">{memoryLimit}</span></div>
        <div className="object-context__field"><span className="k">重启次数</span><span className="v">{selected.restartCount}</span></div>
        <div className="object-context__field"><span className="k">Pod IP</span><span className="v mono">{selected.podIp ?? '-'}</span></div>
        <div className="object-context__field"><span className="k">启动时间</span><span className="v">{selected.startedAt ? new Date(selected.startedAt).toLocaleString() : '-'}</span></div>
      </div>

      <div className="object-context__section">
        <div className="object-context__section-title">资源使用 · 近 30 分钟</div>
        <Sparkline series={[{ name: 'memory', points: memoryPoints }]} color="#dc2626" height={48} />
        <Sparkline series={[{ name: 'cpu', points: cpuPoints }]} color="#2563eb" height={48} />
      </div>

      <div className="object-context__section">
        <div className="object-context__section-title">最近日志</div>
        {logsLoading ? (
          <p className="object-context__state">加载中…</p>
        ) : logs.length === 0 ? (
          <p className="object-context__state">暂无日志</p>
        ) : (
          <div className="object-context__logs">
            {logs.map((log, index) => (
              <div key={index} className="object-log">
                <span className={`object-log__level object-log__level--${log.level.toLowerCase()}`}>{log.level}</span>
                <span className="object-log__message">{log.message}</span>
                <span className="object-log__time">{new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="object-context__section">
        <div className="object-context__section-title">关联告警</div>
        {relatedAlerts.length === 0 ? (
          <p className="object-context__state">暂无关联告警</p>
        ) : (
          <div className="object-context__alerts">
            {relatedAlerts.map((alert) => (
              <div key={alert.id} className="object-alert">
                <Badge label={alert.severity.toUpperCase()} tone={severityTone[alert.severity] ?? 'info'} />
                <span className="object-alert__title">{alert.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {events.length > 0 && (
        <div className="object-context__section">
          <div className="object-context__section-title">最近事件</div>
          {events.map((event, index) => (
            <div key={index} className="object-log">
              <span className={`object-log__level object-log__level--${event.type === 'Warning' ? 'warn' : 'info'}`}>{event.reason}</span>
              <span className="object-log__message">{event.message}</span>
              <span className="object-log__time">{event.time}</span>
            </div>
          ))}
        </div>
      )}

      <Button variant="primary" onClick={onDiagnose}>
        就此对象发起诊断
      </Button>
    </div>
  )
}
