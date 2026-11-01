import { describe, it, expect } from 'vitest'
import { progressForStatus, progressFromEvents, TRACK_STEPS } from './progress.js'

describe('TRACK_STEPS', () => {
  it('uses the 4-step prototype model', () => {
    expect(TRACK_STEPS.map((s) => s.label)).toEqual(['现象确认', '证据采集', '修复执行', '验证与归档'])
  })
})

describe('progressForStatus', () => {
  it('maps intake and planning to step 1 (现象确认)', () => {
    expect(progressForStatus('intake')).toEqual({
      label: '现象确认',
      step: 1,
      total: 4,
      percent: 25,
      key: 'intake',
    })
    expect(progressForStatus('planning')?.step).toBe(1)
  })

  it('maps executing to step 2 (证据采集)', () => {
    expect(progressForStatus('executing')).toEqual({
      label: '证据采集',
      step: 2,
      total: 4,
      percent: 50,
      key: 'collect',
    })
  })

  it('maps awaiting approval and remediating to step 3 (修复执行)', () => {
    expect(progressForStatus('awaiting_approval')?.step).toBe(3)
    expect(progressForStatus('awaiting_approval')?.key).toBe('remediate')
    expect(progressForStatus('remediating')?.step).toBe(3)
  })

  it('maps reflecting to step 4 (验证与归档) short of 100%', () => {
    expect(progressForStatus('reflecting')?.step).toBe(4)
    expect(progressForStatus('reflecting')?.percent).toBe(90)
  })

  it('maps concluded and closed to 100%', () => {
    expect(progressForStatus('concluded')?.percent).toBe(100)
    expect(progressForStatus('closed')?.percent).toBe(100)
  })

  it('returns null for unknown status', () => {
    expect(progressForStatus('weird')).toBeNull()
    expect(progressForStatus(undefined)).toBeNull()
  })

  it('keeps step numbers within the track size', () => {
    for (const status of ['intake', 'planning', 'executing', 'awaiting_approval', 'remediating', 'reflecting', 'concluded', 'closed']) {
      const progress = progressForStatus(status)
      expect(progress?.total).toBe(TRACK_STEPS.length)
      expect(progress!.step).toBeGreaterThanOrEqual(1)
      expect(progress!.step).toBeLessThanOrEqual(TRACK_STEPS.length)
    }
  })
})

describe('progressFromEvents', () => {
  it('promotes to 证据采集 as soon as tool events arrive (status may still lag)', () => {
    // 会话状态仍是 planning（后端刷新滞后），但事件流已出现工具调用
    const progress = progressFromEvents(
      [{ type: 'user_message' }, { type: 'assistant_message' }, { type: 'tool_call_start' }],
      'planning',
    )
    expect(progress?.step).toBe(2)
    expect(progress?.key).toBe('collect')
    expect(progress?.label).toBe('证据采集')
    expect(progress?.percent).toBe(50)
  })

  it('promotes through 修复执行 and 验证与归档', () => {
    const base = [{ type: 'user_message' }, { type: 'tool_call_result' }]
    expect(progressFromEvents([...base, { type: 'approval_request' }], 'executing')?.key).toBe('remediate')
    expect(progressFromEvents([...base, { type: 'rca_conclusion' }], 'executing')?.percent).toBe(100)
    expect(progressFromEvents([...base, { type: 'done' }], 'executing')?.step).toBe(4)
  })

  it('never moves backwards when the session status regresses', () => {
    // 审批通过后状态回落到 executing，事件流仍保留审批记录 => 进度不回退
    const progress = progressFromEvents(
      [{ type: 'user_message' }, { type: 'approval_decision' }, { type: 'tool_call_result' }],
      'executing',
    )
    expect(progress?.key).toBe('remediate')
    expect(progress?.percent).toBe(75)
  })

  it('falls back to the status mapping when there are no events', () => {
    expect(progressFromEvents([], 'awaiting_approval')).toEqual(progressForStatus('awaiting_approval'))
    expect(progressFromEvents([], 'concluded')?.percent).toBe(100)
  })

  it('returns step 1 for a brand new session and null without any signal', () => {
    expect(progressFromEvents([{ type: 'user_message' }], 'intake')?.step).toBe(1)
    expect(progressFromEvents([], undefined)).toBeNull()
  })
})
