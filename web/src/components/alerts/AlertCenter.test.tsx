import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertCenter } from './AlertCenter.js'
import type { AlertItem } from './AlertList.js'

const alerts: AlertItem[] = [
  { id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', startedAt: '2026-08-25T10:24:00Z', status: 'firing' },
]

describe('AlertCenter', () => {
  it('renders health grid, alerts and quick entries', () => {
    render(<AlertCenter alerts={alerts} loading={false} onInvestigate={() => {}} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('服务健康')).toBeInTheDocument()
    expect(screen.getByText('order-api Pod CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.getByText('快捷入口')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    render(<AlertCenter alerts={[]} loading onInvestigate={() => {}} />)
    expect(screen.getByText(/加载中/)).toBeInTheDocument()
  })

  it('shows empty state', () => {
    render(<AlertCenter alerts={[]} loading={false} onInvestigate={() => {}} />)
    expect(screen.getByText('暂无告警')).toBeInTheDocument()
  })

  it('fires investigate from alert rows', async () => {
    const onInvestigate = vi.fn()
    const user = userEvent.setup()
    render(<AlertCenter alerts={alerts} loading={false} onInvestigate={onInvestigate} />)
    await user.click(screen.getByRole('button', { name: '一键开查' }))
    expect(onInvestigate).toHaveBeenCalledWith('a1')
  })
})
