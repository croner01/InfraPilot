import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConclusionCard } from './ConclusionCard.js'
import type { RootCause, Remediation } from '../../lib/types.js'

const rootCause: RootCause = {
  summary: 'order-api 内存 limit 256Mi 过低，触发 OOMKilled',
  confidence: 0.87,
  evidenceChain: [
    { evidenceId: 'ev1', role: 'primary', claim: '结论正文直接引用' },
    { evidenceId: 'ev2', role: 'supporting', claim: '支撑: 副本被外部终止' },
  ],
  alternativeHypotheses: ['节点资源不足（已排除）'],
}

const remediation: Remediation = {
  summary: '调整内存 limit',
  steps: [
    { description: '将内存 limit 从 256Mi 调整到 512Mi', skill: 'k8s', tool: 'patch_deployment', risk: 'medium', rollback: '改回 256Mi' },
  ],
}

describe('ConclusionCard', () => {
  it('renders summary, confidence and remediation', () => {
    render(<ConclusionCard rootCause={rootCause} remediation={remediation} onCitationClick={() => {}} />)
    expect(screen.getByText('根因分析结论')).toBeInTheDocument()
    expect(screen.getByText(/order-api 内存 limit 256Mi/)).toBeInTheDocument()
    expect(screen.getByText('置信度 87%')).toBeInTheDocument()
    expect(screen.getByText('将内存 limit 从 256Mi 调整到 512Mi')).toBeInTheDocument()
  })

  it('exposes what each cited evidence supports as a hover hint', () => {
    render(<ConclusionCard rootCause={rootCause} remediation={null} onCitationClick={() => {}} />)
    expect(screen.getByText(/证据#1/)).toHaveAttribute('title', '结论正文直接引用')
    expect(screen.getByText(/证据#2/)).toHaveAttribute('title', '支撑: 副本被外部终止')
  })

  it('shows 未给出 instead of 0% when confidence is absent', () => {
    render(<ConclusionCard rootCause={{ ...rootCause, confidence: null }} onCitationClick={() => {}} />)
    expect(screen.getByText('置信度 未给出')).toBeInTheDocument()
    expect(screen.queryByText('置信度 0%')).toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('renders markdown formatting in the summary', () => {
    const withMarkdown: RootCause = {
      ...rootCause,
      summary: '**根因摘要**：内存 limit 过小\n\n- 置信度 0.9',
    }
    render(<ConclusionCard rootCause={withMarkdown} onCitationClick={() => {}} />)
    expect(screen.getByText('根因摘要')).toBeInTheDocument()
    expect(screen.getAllByRole('list').length).toBeGreaterThan(0)
    expect(screen.queryByText('**根因摘要**：内存 limit 过小')).not.toBeInTheDocument()
  })

  it('fires citation click with evidence id', async () => {
    const onCitationClick = vi.fn()
    const user = userEvent.setup()
    render(<ConclusionCard rootCause={rootCause} onCitationClick={onCitationClick} />)
    await user.click(screen.getByRole('button', { name: /证据#1/ }))
    expect(onCitationClick).toHaveBeenCalledWith('ev1')
  })
})
