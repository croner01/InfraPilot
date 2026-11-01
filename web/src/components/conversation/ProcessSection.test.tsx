import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EvidenceChips, ThinkCard, ToolCallCard, ToolGroupCard } from './ProcessSection.js'

describe('ThinkCard', () => {
  it('collapses finished reasoning by default and expands on click', async () => {
    render(<ThinkCard text="先确认 Pod 状态" />)
    expect(screen.getByText('思考过程')).toBeInTheDocument()
    expect(screen.queryByText('先确认 Pod 状态')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /思考过程/ }))
    expect(screen.getByText('先确认 Pod 状态')).toBeInTheDocument()
  })

  it('opens immediately when live', () => {
    render(<ThinkCard text="正在分析" live />)
    expect(screen.getByText('正在分析')).toBeInTheDocument()
    expect(screen.getByText(/实时/)).toBeInTheDocument()
  })

  it('keeps the final answer expanded and labels it', () => {
    render(<ThinkCard text="根因：内存不足" kind="answer" />)
    expect(screen.getByText('根因：内存不足')).toBeInTheDocument()
    expect(screen.getByText('分析结论')).toBeInTheDocument()
  })
})

describe('ToolCallCard', () => {
  const item = {
    key: 't1',
    icon: 'tool' as const,
    status: 'ok' as const,
    title: 'k8s.get_pod_status()',
    riskLevel: 'readonly',
    durationMs: 240,
    args: { name: 'order-api', namespace: 'default' },
    resultText: '{"restarts":6}',
  }

  it('renders inline args, risk badge and duration', () => {
    render(<ToolCallCard item={item} />)
    expect(screen.getByText(/k8s\.get_pod_status/)).toBeInTheDocument()
    expect(screen.getByText(/name="order-api"/)).toBeInTheDocument()
    expect(screen.getByText('readonly')).toBeInTheDocument()
    expect(screen.getByText('240ms')).toBeInTheDocument()
  })

  it('expands to reveal args and result', async () => {
    render(<ToolCallCard item={item} />)
    expect(screen.getByText('入参')).toBeInTheDocument()
    expect(screen.getByText(/restarts/)).toBeInTheDocument()
    // 默认展开（对齐原型），点击后收起
    await userEvent.setup().click(screen.getByRole('button', { name: /k8s\.get_pod_status/ }))
    expect(screen.queryByText('入参')).not.toBeInTheDocument()
  })
})

describe('ToolGroupCard', () => {
  it('summarizes consecutive readonly calls and collapses on click', async () => {
    render(
      <ToolGroupCard
        group={{
          key: 'g1',
          isGroup: true,
          label: '批量采集',
          items: [
            { key: 'a', icon: 'tool', status: 'ok', title: 'elk.search_logs()', durationMs: 512 },
            { key: 'b', icon: 'tool', status: 'ok', title: 'prom.range_query()', durationMs: 178 },
          ],
        }}
      />,
    )
    expect(screen.getByText(/连续/)).toBeInTheDocument()
    expect(screen.getByText(/次只读调用已合并/)).toBeInTheDocument()
    expect(screen.getAllByText(/elk\.search_logs/).length).toBeGreaterThan(0)
    const head = screen.getByRole('button', { name: /批量采集/ })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    await userEvent.setup().click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // 收起后仅剩组头摘要里的技能名
    expect(screen.queryAllByText(/elk\.search_logs/).length).toBe(1)
  })
})

describe('EvidenceChips', () => {
  it('renders count and labels', () => {
    render(<EvidenceChips items={[{ id: 'e1', label: 'OOMKilled · exit 137' }]} />)
    expect(screen.getByText('OOMKilled · exit 137')).toBeInTheDocument()
    expect(screen.getByText('1', { selector: 'b' })).toBeInTheDocument()
  })
})
