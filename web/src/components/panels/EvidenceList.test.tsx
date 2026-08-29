import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EvidenceList } from './EvidenceList.js'
import type { Evidence } from '../../lib/types.js'

const evidence: Evidence[] = [
  { id: 'ev1', sourceSkill: 'k8s', type: 'k8s_event', content: { exitCode: 137 }, confidence: 0.92, collectedAt: '2026-08-25T10:38:00Z', summary: 'Pod 事件：OOMKilled' },
  { id: 'ev2', sourceSkill: 'elk', type: 'log_cluster', content: 'error log', confidence: 0.84, collectedAt: '2026-08-25T10:35:00Z', summary: '错误日志聚类' },
]

describe('EvidenceList', () => {
  it('renders evidence cards', () => {
    render(<EvidenceList evidence={evidence} />)
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
    expect(screen.getByText('置信度 92%')).toBeInTheDocument()
  })

  it('highlights the target evidence id', () => {
    const { container } = render(<EvidenceList evidence={evidence} highlightId="ev2" />)
    const cards = container.querySelectorAll('.ev-card')
    expect(cards[0].className).not.toContain('ev-card--highlight')
    expect(cards[1].className).toContain('ev-card--highlight')
  })

  it('renders empty state', () => {
    render(<EvidenceList evidence={[]} />)
    expect(screen.getByText(/暂无证据/)).toBeInTheDocument()
  })
})
