import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HypothesisTree } from './HypothesisTree.js'
import type { Hypothesis } from '../../lib/types.js'

const hypotheses: Hypothesis[] = [
  { id: 'h1', statement: '内存 limit 不足导致 OOM', status: 'confirmed', evidenceIds: ['ev1'], toolCallIds: [], updatedAt: '2026-08-25T10:30:00Z' },
  { id: 'h2', statement: '节点资源不足', status: 'ruled_out', evidenceIds: [], toolCallIds: [], updatedAt: '2026-08-25T10:31:00Z' },
  { id: 'h3', statement: '镜像拉取失败', status: 'active', evidenceIds: [], toolCallIds: [], updatedAt: '2026-08-25T10:29:00Z' },
]

describe('HypothesisTree', () => {
  it('renders hypotheses with status labels', () => {
    render(<HypothesisTree hypotheses={hypotheses} />)
    expect(screen.getByText('内存 limit 不足导致 OOM')).toBeInTheDocument()
    expect(screen.getByText('已确认')).toBeInTheDocument()
    expect(screen.getByText('已排除')).toBeInTheDocument()
    expect(screen.getByText('待验证')).toBeInTheDocument()
  })

  it('renders empty state', () => {
    render(<HypothesisTree hypotheses={[]} />)
    expect(screen.getByText(/暂无假设/)).toBeInTheDocument()
  })

  it('fires citation click with evidence id', async () => {
    const onCitationClick = vi.fn()
    const user = userEvent.setup()
    render(<HypothesisTree hypotheses={hypotheses} onCitationClick={onCitationClick} />)
    await user.click(screen.getByRole('button', { name: /证据 ev1/ }))
    expect(onCitationClick).toHaveBeenCalledWith('ev1')
  })
})
