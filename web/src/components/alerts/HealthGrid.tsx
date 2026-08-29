import './health-grid.css'

export type ServiceStatus = 'ok' | 'warn' | 'err'

export interface ServiceHealth {
  name: string
  meta: string
  status: ServiceStatus
  metricLabel: string
  metricValue: string
  chart: number[]
}

interface HealthGridProps {
  services: ServiceHealth[]
}

export function HealthGrid({ services }: HealthGridProps) {
  return (
    <div className="health-grid">
      {services.map((service) => (
        <div key={service.name} className={`health-card${service.status !== 'ok' ? ' health-card--alert' : ''}`}>
          <div className="health-card__head">
            <span className={`status-dot status-dot--${service.status}`} />
            <span className="health-card__name">{service.name}</span>
          </div>
          <div className="health-card__meta">{service.meta}</div>
          <div className="health-card__chart">
            <Sparkline values={service.chart} status={service.status} />
          </div>
          <div className="health-card__stat">
            <span>{service.metricLabel}</span>
            <b>{service.metricValue}</b>
          </div>
        </div>
      ))}
    </div>
  )
}

function Sparkline({ values, status }: { values: number[]; status: ServiceStatus }) {
  const points = sparklinePoints(values)
  return (
    <svg viewBox="0 0 200 34" preserveAspectRatio="none">
      {points && <polyline points={points} className={`sparkline sparkline--${status}`} />}
    </svg>
  )
}

function sparklinePoints(values: number[]): string {
  if (values.length < 2) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 200
      const y = 34 - ((value - min) / span) * 30 - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
