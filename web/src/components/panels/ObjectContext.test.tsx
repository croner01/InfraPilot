import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Alert } from '../../lib/types.js'

const { FakeUPlot } = vi.hoisted(() => ({
  FakeUPlot: vi.fn(function (this: { destroy: () => void }) {
    this.destroy = vi.fn()
  }),
}))

vi.mock('uplot', () => ({ default: FakeUPlot }))
vi.mock('../../lib/api.js', () => ({
  listPods: vi.fn(),
  getPodDetail: vi.fn(),
  fetchObjectLogs: vi.fn(),
}))

import { listPods, getPodDetail, fetchObjectLogs } from '../../lib/api.js'
import { ObjectContext } from './ObjectContext.js'

const pod = {
  name: 'order-api-7f9c6d4b8c-x2j8l',
  namespace: 'order-service',
  status: 'CrashLoopBackOff',
  restartCount: 14,
  ready: false,
  podIp: '10.42.1.77',
  nodeName: 'node-08',
  startedAt: '2026-08-25T10:24:00Z',
  resources: { limits: { memory: '256Mi' } },
}

const alerts: Alert[] = [
  { id: 'a1', severity: 'p0', title: 'order-api CrashLoopBackOff', source: 'Prometheus', service: 'order-api', status: 'firing', startedAt: '2026-08-25T10:24:00Z' },
  { id: 'a2', severity: 'p1', title: 'payment 5xx', source: 'Prometheus', service: 'payment-service', status: 'firing', startedAt: '2026-08-25T10:02:00Z' },
]

describe('ObjectContext', () => {
  beforeEach(() => {
    vi.mocked(listPods).mockResolvedValue({ pods: [pod] } as never)
    vi.mocked(getPodDetail).mockResolvedValue({
      pod,
      events: [{ time: '10:24', type: 'Warning', reason: 'OOMKilled', message: 'Pod was OOMKilled' }],
    } as never)
    vi.mocked(fetchObjectLogs).mockResolvedValue({
      logs: [
        { timestamp: '2026-08-25T10:24:31Z', level: 'ERROR', message: 'Memory limit exceeded' },
        { timestamp: '2026-08-25T10:24:12Z', level: 'WARN', message: 'Heap usage 92%' },
      ],
    } as never)
  })

  it('renders pod fields, logs and related alerts', async () => {
    render(<ObjectContext alerts={alerts} onDiagnose={() => {}} />)
    expect(await screen.findByText('order-api-7f9c6d4b8c-x2j8l')).toBeInTheDocument()
    expect(screen.getByText('256Mi')).toBeInTheDocument()
    expect(await screen.findByText('Memory limit exceeded')).toBeInTheDocument()
    expect(screen.getByText('order-api CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.queryByText('payment 5xx')).not.toBeInTheDocument()
  })

  it('fires onDiagnose', async () => {
    const onDiagnose = vi.fn()
    const user = userEvent.setup()
    render(<ObjectContext alerts={alerts} onDiagnose={onDiagnose} />)
    await user.click(await screen.findByRole('button', { name: /就此对象发起诊断/ }))
    expect(onDiagnose).toHaveBeenCalledTimes(1)
  })
})
