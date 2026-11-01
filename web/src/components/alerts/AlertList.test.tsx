import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertList } from './AlertList.js'

const alerts = [
  {
    id: 'a1',
    severity: 'p0' as const,
    title: 'order-api Pod CrashLoopBackOff',
    source: 'order-service/order-api · Prometheus',
    service: 'order-api',
    startedAt: '2026-08-25T10:24:00Z',
    status: 'firing' as const,
  },
]

describe('AlertList', () => {
  it('renders alert rows and fires investigate', async () => {
    const onInvestigate = vi.fn()
    const user = userEvent.setup()
    render(<AlertList alerts={alerts} onInvestigate={onInvestigate} />)
    expect(screen.getByText('order-api Pod CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.getByText('P0 严重')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '一键开查' }))
    expect(onInvestigate).toHaveBeenCalledWith('a1')
  })
})
