import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConclusionPanel } from './ConclusionPanel.js'
import type { RootCause, Remediation } from '../../lib/types.js'
import type { InvestigationProgress } from '../../lib/progress.js'

const rootCause: RootCause = {
  summary: 'order-api 内存 limit 过低触发 OOMKilled',
  confidence: 0.87,
  evidenceChain: [{ evidenceId: 'ev1', role: 'primary' }],
  alternativeHypotheses: [],
}

const remediation: Remediation = {
  summary: '调整内存 limit',
  steps: [{ description: '将 limit 调至 512Mi', skill: 'k8s', tool: 'patch_deployment', risk: 'medium' }],
}

const progress: InvestigationProgress = { label: '正在执行诊断', step: 2, total: 4, percent: 50 }

describe('ConclusionPanel', () => {
  it('shows progress strip while running without conclusion', () => {
    render(
      <ConclusionPanel
        running
        statusMessage="正在执行诊断步骤…"
        progress={progress}
        dismissed={false}
        onDismiss={() => {}}
        onReopen={() => {}}
        onCitationClick={() => {}}
      />,
    )
    expect(screen.getByText('正在执行诊断步骤…')).toBeInTheDocument()
    expect(screen.getByText(/阶段 2\/4/)).toBeInTheDocument()
    expect(screen.queryByText('根因分析结论')).not.toBeInTheDocument()
  })

  it('shows conclusion card with close button when rootCause present', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <ConclusionPanel
        running={false}
        statusMessage={undefined}
        progress={null}
        rootCause={rootCause}
        remediation={remediation}
        dismissed={false}
        onDismiss={onDismiss}
        onReopen={() => {}}
        onCitationClick={() => {}}
      />,
    )
    expect(screen.getByText('根因分析结论')).toBeInTheDocument()
    expect(screen.getByText('order-api 内存 limit 过低触发 OOMKilled')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /关闭结论/ }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('shows reopen pill when dismissed', async () => {
    const onReopen = vi.fn()
    const user = userEvent.setup()
    render(
      <ConclusionPanel
        running={false}
        statusMessage={undefined}
        progress={null}
        rootCause={rootCause}
        dismissed
        onDismiss={() => {}}
        onReopen={onReopen}
        onCitationClick={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: /查看根因结论/ }))
    expect(onReopen).toHaveBeenCalledTimes(1)
  })
})
