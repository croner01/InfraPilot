import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RightPanel } from './RightPanel.js'

const base = {
  track: <p>跟踪内容</p>,
  evidence: <p>证据内容</p>,
  audit: <p>审计内容</p>,
  plan: <p>计划内容</p>,
  remediation: <p>修复内容</p>,
  artifacts: <p>产物内容</p>,
}

describe('RightPanel', () => {
  it('shows the track panel by default and switches tabs', async () => {
    const user = userEvent.setup()
    render(<RightPanel {...base} />)
    expect(screen.getByText('跟踪内容')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /证据/ }))
    expect(screen.getByText('证据内容')).toBeInTheDocument()
    expect(screen.queryByText('跟踪内容')).not.toBeInTheDocument()
  })

  it('renders count badges on tabs', () => {
    render(<RightPanel {...base} counts={{ evidence: 3, audit: 5 }} />)
    expect(screen.getByRole('tab', { name: /证据.*3/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /审计.*5/ })).toBeInTheDocument()
  })

  it('hides optional tabs when no content is provided', () => {
    render(<RightPanel track={<p>t</p>} evidence={<p>e</p>} />)
    expect(screen.queryByRole('tab', { name: /审计/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /产物/ })).not.toBeInTheDocument()
  })

  it('collapses and expands the panel', async () => {
    const user = userEvent.setup()
    const { container } = render(<RightPanel {...base} />)
    const aside = container.querySelector('aside')
    expect(aside?.className).not.toContain('ui-right-panel--collapsed')
    await user.click(screen.getByTitle('折叠右栏'))
    expect(aside?.className).toContain('ui-right-panel--collapsed')
    await user.click(screen.getByTitle('展开右栏'))
    expect(aside?.className).not.toContain('ui-right-panel--collapsed')
  })

  it('renders an edge handle to reopen when collapsed', async () => {
    const onToggleCollapse = vi.fn()
    const user = userEvent.setup()
    render(<RightPanel {...base} collapsed onToggleCollapse={onToggleCollapse} />)
    const handle = screen.getByRole('button', { name: '展开执行跟踪' })
    expect(handle.className).toContain('ui-right-panel__handle')
    await user.click(handle)
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('hides the reopen handle while expanded', () => {
    render(<RightPanel {...base} />)
    expect(screen.queryByRole('button', { name: '展开执行跟踪' })).not.toBeInTheDocument()
  })

  it('supports controlled active tab and collapse', async () => {
    const onTabChange = vi.fn()
    const user = userEvent.setup()
    const { rerender, container } = render(
      <RightPanel {...base} activeTab="track" onTabChange={onTabChange} />,
    )
    await user.click(screen.getByRole('tab', { name: /审计/ }))
    expect(onTabChange).toHaveBeenCalledWith('audit')
    rerender(<RightPanel {...base} activeTab="audit" onTabChange={onTabChange} collapsed />)
    expect(screen.getByText('审计内容')).toBeInTheDocument()
    expect(container.querySelector('aside')?.className).toContain('ui-right-panel--collapsed')
  })
})
