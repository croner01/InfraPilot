import { describe, it, expect } from 'vitest'
import { progressForStatus } from './progress.js'

describe('progressForStatus', () => {
  it('maps planning to stage 1 of 4', () => {
    expect(progressForStatus('planning')).toEqual({ label: '正在规划', step: 1, total: 4, percent: 25 })
  })

  it('maps executing and awaiting approval to stage 2 of 4', () => {
    expect(progressForStatus('executing')?.step).toBe(2)
    expect(progressForStatus('awaiting_approval')?.step).toBe(2)
  })

  it('maps reflecting to stage 3 of 4', () => {
    expect(progressForStatus('reflecting')?.percent).toBe(75)
  })

  it('maps concluded to 100%', () => {
    expect(progressForStatus('concluded')?.percent).toBe(100)
  })

  it('returns null for unknown status', () => {
    expect(progressForStatus('weird')).toBeNull()
  })
})
