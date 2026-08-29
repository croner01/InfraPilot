import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
