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
  it('renders messages, cortex flow and special events in order', async () => {
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
    expect(screen.getByText('InfraPilot Agent')).toBeInTheDocument()
    // 工具卡默认平铺展示
    expect(screen.getAllByText(/k8s\.describe_pod/).length).toBeGreaterThanOrEqual(2)
    // 证据 chips
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
    // 审批卡经 renderSpecial 渲染
    expect(screen.getByTestId('special-approval_request')).toBeInTheDocument()
    // 过程推理完成后默认折叠，点击可展开
    expect(screen.queryByText('初步判断')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /思考过程/ }))
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
  })

  it('renders the confidence self-check as a concise status step', () => {
    render(
      <Conversation
        events={[
          ev('g1', 'evidence_gap_probe', {
            iteration: 6,
            message: '【证据缺口自检】 你的结论置信度为 0.6（低于 0.75）…',
          }),
        ]}
        loading={false}
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.getByText('结论自检：置信度不足，追加一轮证据采集')).toBeInTheDocument()
    // 提示词原文不应整段铺到对话流里
    expect(screen.queryByText(/【证据缺口自检】/)).not.toBeInTheDocument()
  })

  it('collapses finished reasoning and keeps the final answer expanded', () => {
    render(
      <Conversation
        events={[
          ev('d1', 'assistant_delta', { content: '第一步推理' }),
          ev('m1', 'assistant_message', { content: '第一步推理' }),
          ev('t1', 'tool_call_start', { skill: 'k8s', tool: 'list_pods', toolCallId: 'c1', risk: { level: 'readonly' } }),
          ev('t2', 'tool_call_result', { skill: 'k8s', tool: 'list_pods', toolCallId: 'c1', result: { success: true } }),
          ev('m2', 'assistant_message', { content: '【根因分析结论】\n\n内存不足' }),
        ]}
        loading={false}
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    // 过程推理折叠
    expect(screen.queryByText('第一步推理')).not.toBeInTheDocument()
    // 结论常驻展开
    expect(screen.getByText('内存不足')).toBeInTheDocument()
    expect(screen.getByText('分析结论')).toBeInTheDocument()
  })

  it('keeps a reasoning card open after the user expands it', async () => {
    render(
      <Conversation
        events={[
          ev('m1', 'assistant_message', { content: '中间推理' }),
          ev('t1', 'tool_call_start', { skill: 'k8s', tool: 'list_pods', toolCallId: 'c1', risk: { level: 'readonly' } }),
        ]}
        loading={false}
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.queryByText('中间推理')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /思考过程/ }))
    expect(screen.getByText('中间推理')).toBeInTheDocument()
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

  it('renders streaming assistant deltas as a live think card', () => {
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
    expect(screen.getByText('IP')).toBeInTheDocument()
  })

  it('renders flat tool cards while running', () => {
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
    expect(screen.getAllByText(/k8s\.describe_pod/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText(/正在执行 k8s\.describe_pod\(\)/).length).toBeGreaterThan(0)
  })

  it('merges start/result by toolCallId and groups consecutive readonly calls', () => {
    render(
      <Conversation
        events={[
          ev('t1', 'tool_call_start', { skill: 'k8s', tool: 'get_pod_status', toolCallId: 'c1', risk: { level: 'readonly' } }),
          ev('t2', 'tool_call_result', { skill: 'k8s', tool: 'get_pod_status', toolCallId: 'c1', result: { success: true, durationMs: 240 } }),
          ev('t3', 'tool_call_start', { skill: 'elk', tool: 'search_logs', toolCallId: 'c2', risk: { level: 'readonly' } }),
          ev('t4', 'tool_call_result', { skill: 'elk', tool: 'search_logs', toolCallId: 'c2', result: { success: true, durationMs: 512 } }),
        ]}
        loading={false}
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    // 2 次连续只读调用合并为「批量采集」组
    expect(screen.getByText(/批量采集/)).toBeInTheDocument()
    expect(screen.queryByText('k8s.get_pod_status()')).not.toBeInTheDocument()
  })
})
