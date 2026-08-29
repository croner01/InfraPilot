import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button.js'

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <Button variant="primary" onClick={onClick}>
        新建会话
      </Button>,
    )
    const btn = screen.getByRole('button', { name: '新建会话' })
    expect(btn.className).toContain('ui-btn--primary')
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
