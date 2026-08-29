import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TopBar } from './TopBar.js'

describe('TopBar', () => {
  it('renders brand, connection and count pills', () => {
    render(<TopBar connected pendingApprovals={2} activeAlerts={3} onNewSession={() => {}} />)
    expect(screen.getByText('InfraPilot')).toBeInTheDocument()
    expect(screen.getByText('实时连接')).toBeInTheDocument()
    expect(screen.getByText('2 待审批')).toBeInTheDocument()
    expect(screen.getByText('3 活跃告警')).toBeInTheDocument()
  })

  it('hides zero-count pills and shows offline state', () => {
    render(<TopBar connected={false} pendingApprovals={0} activeAlerts={0} onNewSession={() => {}} />)
    expect(screen.getByText('未连接')).toBeInTheDocument()
    expect(screen.queryByText(/待审批/)).not.toBeInTheDocument()
    expect(screen.queryByText(/活跃告警/)).not.toBeInTheDocument()
  })

  it('fires onNewSession', async () => {
    const onNewSession = vi.fn()
    const user = userEvent.setup()
    render(<TopBar connected pendingApprovals={0} activeAlerts={0} onNewSession={onNewSession} />)
    await user.click(screen.getByRole('button', { name: /新建会话/ }))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })
})
