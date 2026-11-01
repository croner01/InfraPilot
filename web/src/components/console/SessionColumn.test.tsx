import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionColumn } from './SessionColumn.js'
import type { AgentSession } from '../../lib/types.js'

const makeSession = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 's1',
  title: 'order-api 频繁重启排查',
  status: 'executing',
  createdAt: '2026-09-29T08:30:00Z',
  updatedAt: '2026-09-29T08:32:00Z',
  incidentSummary: '',
  plan: [],
  evidence: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 1,
  maxIterations: 20,
  activeSkills: ['k8s'],
  ...over,
})

const base = {
  activeSessions: [makeSession()],
  closedSessions: [],
  currentId: null as string | null,
  search: '',
  onSearch: () => {},
  onSelect: () => {},
  onDelete: () => {},
  onTitleSave: () => {},
  onNew: () => {},
  onCollapse: () => {},
  onExpand: () => {},
}

describe('SessionColumn', () => {
  it('renders header actions and the session list as its own column', () => {
    const { container } = render(<SessionColumn {...base} />)
    expect(container.querySelector('.ui-session-col')).toBeInTheDocument()
    expect(screen.getByText('诊断会话')).toBeInTheDocument()
    expect(screen.getByTitle('新建会话')).toBeInTheDocument()
    expect(screen.getByTitle('折叠会话清单')).toBeInTheDocument()
    expect(screen.getByText('order-api 频繁重启排查')).toBeInTheDocument()
  })

  it('triggers new / collapse callbacks', async () => {
    const onNew = vi.fn()
    const onCollapse = vi.fn()
    const user = userEvent.setup()
    render(<SessionColumn {...base} onNew={onNew} onCollapse={onCollapse} />)
    await user.click(screen.getByTitle('新建会话'))
    await user.click(screen.getByTitle('折叠会话清单'))
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('renders a reachable restore handle when collapsed', async () => {
    const onExpand = vi.fn()
    const user = userEvent.setup()
    render(<SessionColumn {...base} collapsed onExpand={onExpand} />)
    const handle = screen.getByTitle('展开会话清单')
    expect(handle).toBeInTheDocument()
    await user.click(handle)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('shows skill scope and status badge in the item meta', () => {
    render(<SessionColumn {...base} />)
    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.getByText('k8s')).toBeInTheDocument()
  })
})
