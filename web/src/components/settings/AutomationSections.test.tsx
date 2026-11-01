import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../lib/api.js', () => ({
  fetchTraceSystems: vi.fn().mockResolvedValue({ systems: [] }),
  upsertTraceSystem: vi.fn(),
  deleteTraceSystem: vi.fn(),
  testTraceSystem: vi.fn(),
  listSchedules: vi.fn().mockResolvedValue({ schedules: [] }),
  fetchSchedulerStatus: vi.fn().mockResolvedValue({ running: true, tickSeconds: 15, count: 0 }),
  validateCron: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runSchedule: vi.fn(),
  listEvalCases: vi.fn().mockResolvedValue({ cases: [], count: 0, casesDir: '/tmp/cases' }),
  deleteEvalCase: vi.fn(),
  judgeSession: vi.fn(),
  promoteSession: vi.fn(),
  listEvalRuns: vi.fn().mockResolvedValue({ runs: [], count: 0 }),
}))

import { EvalSection, SchedulesSection, TraceSection } from './AutomationSections.js'

describe('AutomationSections', () => {
  const notify = vi.fn()

  it('renders the trace section empty state', async () => {
    render(<TraceSection notify={notify} />)
    expect(await screen.findByText(/暂无 Trace 数据源/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /添加 Trace 数据源/ })).toBeInTheDocument()
  })

  it('renders the schedules section with scheduler status', async () => {
    render(<SchedulesSection notify={notify} />)
    expect(await screen.findByText(/调度器：运行中/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新建定时任务/ })).toBeInTheDocument()
  })

  it('renders the eval section with judge form and empty case list', async () => {
    render(<EvalSection notify={notify} />)
    expect(await screen.findByText(/LLM-as-judge 评判/)).toBeInTheDocument()
    expect(await screen.findByText(/暂无用例/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '评判' })).toBeInTheDocument()
  })
})
