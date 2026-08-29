import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RightPanel } from './RightPanel.js'

describe('RightPanel', () => {
  it('switches tabs and shows the active panel', async () => {
    const user = userEvent.setup()
    render(
      <RightPanel
        process={<p>过程内容</p>}
        evidence={<p>证据内容</p>}
        object={<p>对象内容</p>}
      />,
    )
    expect(screen.getByText('过程内容')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '证据链' }))
    expect(screen.getByText('证据内容')).toBeInTheDocument()
    expect(screen.queryByText('过程内容')).not.toBeInTheDocument()
  })

  it('collapses and expands the panel', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RightPanel process={<p>p</p>} evidence={<p>e</p>} object={<p>o</p>} />,
    )
    const aside = container.querySelector('aside')
    expect(aside?.className).not.toContain('ui-right-panel--collapsed')
    await user.click(screen.getByTitle('折叠右栏'))
    expect(aside?.className).toContain('ui-right-panel--collapsed')
    await user.click(screen.getByTitle('展开右栏'))
    expect(aside?.className).not.toContain('ui-right-panel--collapsed')
  })

  it('supports controlled active tab', async () => {
    const onTabChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <RightPanel
        process={<p>过程内容</p>}
        evidence={<p>证据内容</p>}
        object={<p>对象内容</p>}
        activeTab="process"
        onTabChange={onTabChange}
      />,
    )
    await user.click(screen.getByRole('tab', { name: '证据链' }))
    expect(onTabChange).toHaveBeenCalledWith('evidence')
    rerender(
      <RightPanel
        process={<p>过程内容</p>}
        evidence={<p>证据内容</p>}
        object={<p>对象内容</p>}
        activeTab="evidence"
        onTabChange={onTabChange}
      />,
    )
    expect(screen.getByText('证据内容')).toBeInTheDocument()
  })
})
