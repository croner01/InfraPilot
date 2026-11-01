import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface SparkSeries {
  name: string
  points: [number, number][]
}

const CHART_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
]

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function fmtValue(v: number): string {
  if (Number.isInteger(v)) return String(v)
  if (Math.abs(v) >= 100) return v.toFixed(1)
  if (Math.abs(v) >= 1) return v.toFixed(3)
  return v.toPrecision(3)
}

/** 数据源工作台的完整指标图表：带坐标轴、图例与悬浮提示 */
export function createMetricChart(
  target: HTMLElement,
  series: SparkSeries[],
  width: number,
  height: number,
): uPlot {
  if (series.length === 0) {
    throw new Error('no series')
  }
  // 统一时间轴：以最长序列的时间戳为主轴
  const master = series.reduce((a, b) => (b.points.length > a.points.length ? b : a))
  const xs = master.points.map(([t]) => t / 1000)
  const ys = series.map((s) => {
    const map = new Map(s.points.map(([t, v]) => [t / 1000, v]))
    let last: number | null = null
    return xs.map((t) => {
      const v = map.get(t)
      if (v !== undefined) last = v
      return last
    })
  })

  return new uPlot(
    {
      width,
      height,
      legend: { show: true, live: true },
      cursor: { points: { show: false } },
      axes: [
        {
          stroke: '#94a3b8',
          grid: { stroke: 'rgba(148,163,184,0.18)', width: 1 },
          ticks: { stroke: 'rgba(148,163,184,0.3)', size: 4 },
          values: (_u: uPlot, us: number[]) => us.map((u) => fmtTime(u)),
          space: 70,
        },
        {
          stroke: '#94a3b8',
          grid: { stroke: 'rgba(148,163,184,0.18)', width: 1 },
          ticks: { stroke: 'rgba(148,163,184,0.3)', size: 4 },
          values: (_u: uPlot, us: number[]) => us.map((u) => fmtValue(u)),
          space: 50,
        },
      ],
      series: [
        {},
        ...series.map((item, i) => ({
          label: item.name.length > 42 ? `${item.name.slice(0, 40)}…` : item.name,
          stroke: CHART_COLORS[i % CHART_COLORS.length],
          width: 1.6,
          points: { show: false },
        })),
      ],
    },
    [xs, ...ys],
    target,
  )
}
