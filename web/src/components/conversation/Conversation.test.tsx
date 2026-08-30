import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { Conversation } from './Conversation.js'
import type { TimelineEvent } from '../../lib/types.js'

const ev = (id: string, type: string, payload: Record<string, unknown>): TimelineEvent => ({
  id,
  sessionId: 's1',
  type,
  timestamp: '2026-08-25T10:30:00Z',
  payload,
})

const events: TimelineEvent[] = [
  ev('e1', 'user_message', { message: '查一下 order-api' }),
  ev('e2', 'plan_update', { plan: ['查 Pod 状态', '查日志'] }),
  ev('e3', 'tool_call_start', { skill: 'k8s', tool: 'describe_pod' }),
  ev('e4', 'tool_call_result', { skill: 'k8s', tool: 'describe_pod', result: { success: true } }),
  ev('e5', 'evidence_added', { summary: 'Pod 事件：OOMKilled' }),
  ev('e6', 'assistant_message', { content: '### 初步判断\n\n内存 limit 过低' }),
  ev('e7', 'approval_request', { approvalId: 'a1' }),
]

describe('Conversation', () => {
  it('renders messages, grouped process and special events in order', async () => {
    const ref = createRef<HTMLDivElement | null>()
    render(
      <Conversation
        events={events}
        loading={false}
        renderSpecial={(event) => <div data-testid={`special-${event.type}`}>{event.type}</div>}
        chatEndRef={ref}
      />,
    )
    expect(screen.getByText('查一下 order-api')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
    expect(screen.getByText(/已执行 1 个工具/)).toBeInTheDocument()
    expect(screen.getByTestId('special-approval_request')).toBeInTheDocument()

    // 过程小节默认折叠，展开后能看到工具名与证据摘要
    await userEvent.setup().click(screen.getByRole('button', { name: /诊断过程/ }))
    expect(screen.getAllByText('k8s.describe_pod()')).toHaveLength(2)
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
  })

  it('shows stream status when loading', () => {
    render(
      <Conversation
        events={[ev('e1', 'tool_call_start', { skill: 'k8s', tool: 'describe_pod' })]}
        loading
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.getByText(/正在执行 k8s\.describe_pod\(\)/)).toBeInTheDocument()
  })

  it('shows running status message while agent is active', () => {
    render(
      <Conversation
        events={[ev('e1', 'user_message', { message: '查一下' })]}
        loading={false}
        running
        statusMessage="正在执行诊断步骤…"
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.getByText('正在执行诊断步骤…')).toBeInTheDocument()
  })

  it('renders streaming assistant deltas with live cursor', () => {
    render(
      <Conversation
        events={[
          ev('d1', 'assistant_delta', { content: '正在' }),
          ev('d2', 'assistant_delta', { content: '分析' }),
        ]}
        loading={false}
        running
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.getByText('正在分析')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
  })

  it('opens process sections automatically while running', () => {
    render(
      <Conversation
        events={[
          ev('e1', 'tool_call_start', { skill: 'k8s', tool: 'describe_pod' }),
          ev('e2', 'tool_call_result', { skill: 'k8s', tool: 'describe_pod', result: { success: true } }),
        ]}
        loading={false}
        running
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.getAllByText('k8s.describe_pod()')).toHaveLength(2)
    expect(screen.getAllByText(/正在执行 k8s\.describe_pod\(\)/).length).toBeGreaterThan(0)
  })
})
