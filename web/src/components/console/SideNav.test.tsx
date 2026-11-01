import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SideNav } from './SideNav.js'

const baseProps = {
  activeView: 'alerts' as const,
  alertCount: 3,
  onNavigate: () => {},
}

describe('SideNav', () => {
  it('renders nav items with alert count badge', () => {
    render(<SideNav {...baseProps} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('诊断会话')).toBeInTheDocument()
    expect(screen.getByText('知识库')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('marks active view and navigates on click', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<SideNav {...baseProps} activeView="sessions" onNavigate={onNavigate} />)
    expect(screen.getByText('诊断会话').parentElement?.className).toContain('active')
    await user.click(screen.getByText('知识库'))
    expect(onNavigate).toHaveBeenCalledWith('knowledge')
  })

  it('keeps the nav column free of the session list (它已独立成列)', () => {
    const { container } = render(<SideNav {...baseProps} activeView="sessions" />)
    expect(container.querySelector('.ui-session-list')).toBeNull()
  })
})
