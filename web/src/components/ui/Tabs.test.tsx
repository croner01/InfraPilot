import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tabs } from './Tabs.js'

const items = [
  { key: 'process', label: '调查过程' },
  { key: 'evidence', label: '证据链', count: 4 },
]

describe('Tabs', () => {
  it('marks active tab and fires onChange', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Tabs items={items} activeKey="process" onChange={onChange} />)
    const process = screen.getByRole('tab', { name: '调查过程' })
    expect(process.className).toContain('ui-tabs__tab--active')
    await user.click(screen.getByRole('tab', { name: /证据链/ }))
    expect(onChange).toHaveBeenCalledWith('evidence')
  })
})
