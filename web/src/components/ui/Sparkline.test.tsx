import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from './Sparkline.js'

const { FakeUPlot, destroy } = vi.hoisted(() => {
  const destroy = vi.fn()
  const FakeUPlot = vi.fn(function (this: { destroy: () => void }) {
    this.destroy = destroy
  })
  return { FakeUPlot, destroy }
})

vi.mock('uplot', () => ({ default: FakeUPlot }))

describe('Sparkline', () => {
  beforeEach(() => {
    FakeUPlot.mockClear()
    destroy.mockClear()
  })

  it('creates uPlot with transformed data', () => {
    render(
      <Sparkline
        series={[{ name: 'memory', points: [[1000, 1], [2000, 2]] }]}
        color="#dc2626"
        height={40}
      />,
    )
    expect(FakeUPlot).toHaveBeenCalledTimes(1)
    const [, data] = FakeUPlot.mock.calls[0]
    expect(data[0]).toEqual([1000, 2000])
    expect(data[1]).toEqual([1, 2])
  })

  it('destroys the plot on unmount', () => {
    const { unmount } = render(<Sparkline series={[]} />)
    unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
