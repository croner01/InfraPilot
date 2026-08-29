import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmptyWorkspace } from './EmptyWorkspace.js'

describe('EmptyWorkspace', () => {
  it('renders guidance and quick entry cards', () => {
    render(<EmptyWorkspace onNewSession={() => {}} />)
    expect(screen.getByText('开始一次诊断')).toBeInTheDocument()
    expect(screen.getByText('排查 Pod 异常')).toBeInTheDocument()
    expect(screen.getByText('查询日志')).toBeInTheDocument()
  })

  it('fires onNewSession when a card is clicked', async () => {
    const onNewSession = vi.fn()
    const user = userEvent.setup()
    render(<EmptyWorkspace onNewSession={onNewSession} />)
    await user.click(screen.getByText('排查 Pod 异常'))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })
})
