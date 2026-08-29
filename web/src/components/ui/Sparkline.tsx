import { useEffect, useRef } from 'react'
import { createSparkline } from '../../lib/charts.js'
import type { SparkSeries } from '../../lib/charts.js'
import './sparkline.css'

interface SparklineProps {
  series: SparkSeries[]
  color?: string
  height?: number
}

export function Sparkline({ series, color = '#0f766e', height = 40 }: SparklineProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const width = ref.current.clientWidth || 300
    const plot = createSparkline(ref.current, series, color, width, height)
    return () => {
      plot.destroy()
    }
  }, [series, color, height])

  return <div ref={ref} className="ui-sparkline" style={{ height }} />
}
