import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertCenter } from './AlertCenter.js'

describe('AlertCenter', () => {
  it('renders health grid, alerts and quick entries', () => {
    render(<AlertCenter onInvestigate={() => {}} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('服务健康')).toBeInTheDocument()
    expect(screen.getByText('最近告警')).toBeInTheDocument()
    expect(screen.getByText('快捷入口')).toBeInTheDocument()
  })

  it('fires investigate from alert rows', async () => {
    const onInvestigate = vi.fn()
    const user = userEvent.setup()
    render(<AlertCenter onInvestigate={onInvestigate} />)
    await user.click(screen.getAllByRole('button', { name: '一键开查' })[0])
    expect(onInvestigate).toHaveBeenCalled()
  })
})
