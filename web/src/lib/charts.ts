import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface SparkSeries {
  name: string
  points: [number, number][]
}

export function createSparkline(
  target: HTMLElement,
  series: SparkSeries[],
  color: string,
  width: number,
  height: number,
): uPlot {
  const xs: number[] = []
  const ys: number[][] = series.map(() => [])
  series.forEach((item, index) => {
    for (const [t, v] of item.points) {
      xs.push(t)
      ys[index].push(v)
    }
  })

  return new uPlot(
    {
      width,
      height,
      legend: { show: false },
      axes: [{ show: false }, { show: false }],
      series: [{}, ...series.map((item) => ({ label: item.name, stroke: color, width: 1.5 }))],
    },
    [xs, ...ys],
    target,
  )
}
