import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProcessSection } from './ProcessSection.js'

const items = [
  { key: 't1', icon: 'tool' as const, status: 'running' as const, title: 'k8s.describe_pod()' },
  { key: 't2', icon: 'result' as const, status: 'ok' as const, title: 'k8s.describe_pod()' },
  { key: 'e1', icon: 'evidence' as const, title: '新增证据', detail: 'Pod 事件：OOMKilled' },
]

describe('ProcessSection', () => {
  it('shows counts and stays collapsed by default', () => {
    render(<ProcessSection items={items} />)
    expect(screen.getByText(/已执行 1 个工具/)).toBeInTheDocument()
    expect(screen.getByText(/收集 1 条证据/)).toBeInTheDocument()
    expect(screen.queryByText('k8s.describe_pod()')).not.toBeInTheDocument()
  })

  it('expands on click and renders rows', async () => {
    const user = userEvent.setup()
    render(<ProcessSection items={items} />)
    await user.click(screen.getByRole('button', { name: /诊断过程/ }))
    expect(screen.getAllByText('k8s.describe_pod()')).toHaveLength(2)
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
  })

  it('opens automatically when autoOpen is set', () => {
    render(<ProcessSection items={items} autoOpen />)
    expect(screen.getAllByText('k8s.describe_pod()')).toHaveLength(2)
  })

  it('shows running label with counts', () => {
    render(<ProcessSection items={items} runningLabel="linux.get_memory_info()" />)
    expect(screen.getByText(/正在执行 linux\.get_memory_info\(\)/)).toBeInTheDocument()
    expect(screen.getByText(/已执行 1 个工具/)).toBeInTheDocument()
  })
})
