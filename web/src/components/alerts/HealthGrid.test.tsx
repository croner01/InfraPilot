import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HealthGrid } from './HealthGrid.js'

const services = [
  { name: 'order-api', meta: 'order-service · 3 副本', status: 'err' as const, metricLabel: '内存占用', metricValue: '98%', chart: [10, 12, 15, 22, 30] },
  { name: 'gateway', meta: 'edge · 2 副本', status: 'ok' as const, metricLabel: '请求延迟 p99', metricValue: '42ms', chart: [20, 18, 21, 19, 20] },
]

describe('HealthGrid', () => {
  it('renders service cards with status and metrics', () => {
    render(<HealthGrid services={services} />)
    expect(screen.getByText('order-api')).toBeInTheDocument()
    expect(screen.getByText('order-service · 3 副本')).toBeInTheDocument()
    expect(screen.getByText('98%')).toBeInTheDocument()
    expect(screen.getByText('order-api').parentElement?.querySelector('.status-dot--err')).not.toBeNull()
  })

  it('fires onDiagnose with the clicked service', async () => {
    const onDiagnose = vi.fn()
    const user = userEvent.setup()
    render(
      <HealthGrid
        services={[{ ...services[0], namespace: 'order-service' }]}
        onDiagnose={onDiagnose}
      />,
    )
    await user.click(screen.getByRole('button', { name: '诊断 order-service/order-api' }))
    expect(onDiagnose).toHaveBeenCalledTimes(1)
    expect(onDiagnose.mock.calls[0][0]).toMatchObject({ name: 'order-api', namespace: 'order-service' })
  })

  it('keeps cards non-interactive without onDiagnose', () => {
    render(<HealthGrid services={services} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
