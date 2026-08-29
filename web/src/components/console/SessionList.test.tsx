import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionList } from './SessionList.js'
import type { AgentSession } from '../../lib/types.js'

const makeSession = (over: Partial<AgentSession>): AgentSession => ({
  id: 's1',
  title: 'order-api 排查',
  status: 'concluded',
  createdAt: '2026-08-25T10:00:00Z',
  updatedAt: '2026-08-25T10:30:00Z',
  incidentSummary: '',
  plan: [],
  evidence: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 3,
  maxIterations: 20,
  ...over,
})

describe('SessionList', () => {
  it('renders active and closed groups', () => {
    render(
      <SessionList
        activeSessions={[makeSession({})]}
        closedSessions={[makeSession({ id: 's2', title: 'node-08 磁盘排查', status: 'closed' })]}
        currentId="s1"
        search=""
        onSearch={() => {}}
        onSelect={() => {}}
        onDelete={() => {}}
        onTitleSave={() => {}}
      />,
    )
    expect(screen.getByText('order-api 排查')).toBeInTheDocument()
    expect(screen.getByText(/进行中 \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/历史会话 \(1\)/)).toBeInTheDocument()
  })

  it('selects and deletes a session', async () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(
      <SessionList
        activeSessions={[makeSession({})]}
        closedSessions={[]}
        currentId={null}
        search=""
        onSearch={() => {}}
        onSelect={onSelect}
        onDelete={onDelete}
        onTitleSave={() => {}}
      />,
    )
    await user.click(screen.getByText('order-api 排查'))
    expect(onSelect).toHaveBeenCalledWith('s1')
    await user.click(screen.getByTitle('删除会话'))
    expect(onDelete).toHaveBeenCalled()
  })
})
