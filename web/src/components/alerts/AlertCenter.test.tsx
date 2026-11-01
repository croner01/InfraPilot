import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertCenter } from './AlertCenter.js'
import type { AlertItem } from './AlertList.js'

const alerts: AlertItem[] = [
  { id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', service: 'order-api', startedAt: '2026-08-25T10:24:00Z', status: 'firing' },
]

describe('AlertCenter', () => {
  it('renders health grid, alerts and quick entries', () => {
    render(<AlertCenter alerts={alerts} loading={false} onInvestigate={() => {}} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('服务健康')).toBeInTheDocument()
    expect(screen.getByText('order-api Pod CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.getByText('快捷入口')).toBeInTheDocument()
  })

  it('renders real service health from the API prop', () => {
    render(
      <AlertCenter
        alerts={[]}
        loading={false}
        onInvestigate={() => {}}
        services={[
          { name: 'aodh-api', meta: 'openstack · 3/3 副本', status: 'ok', metricLabel: '可用副本', metricValue: '3/3', chart: [3, 3, 3] },
        ]}
        servicesSource="prometheus"
      />,
    )
    expect(screen.getByText('aodh-api')).toBeInTheDocument()
    expect(screen.getByText('3/3')).toBeInTheDocument()
    expect(screen.getByText(/Prometheus kube-state-metrics/)).toBeInTheDocument()
  })

  it('fires onDiagnoseService when a health card is clicked', async () => {
    const onDiagnoseService = vi.fn()
    const user = userEvent.setup()
    render(
      <AlertCenter
        alerts={[]}
        loading={false}
        onInvestigate={() => {}}
        onDiagnoseService={onDiagnoseService}
        services={[
          { name: 'ecp-dashboard-api', namespace: 'ems', meta: 'ems · 2/3 副本', status: 'warn', metricLabel: '可用副本', metricValue: '2/3', chart: [3, 3, 2] },
        ]}
      />,
    )
    await user.click(screen.getByRole('button', { name: '诊断 ems/ecp-dashboard-api' }))
    expect(onDiagnoseService).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ecp-dashboard-api', namespace: 'ems', status: 'warn' }),
    )
  })

  it('shows a data-source hint when service health is unavailable', () => {
    render(
      <AlertCenter alerts={[]} loading={false} onInvestigate={() => {}} servicesError="connection refused" />,
    )
    expect(screen.getByText(/数据源异常：connection refused/)).toBeInTheDocument()
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
