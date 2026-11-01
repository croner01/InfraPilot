import { describe, it, expect } from 'vitest'
import { mergeTimeline } from './timeline.js'
import type { TimelineEvent } from './types.js'

function ev(id: string, sessionId: string, type = 'tool_call_start'): TimelineEvent {
  return { id, sessionId, type, timestamp: '2026-08-25T10:00:00Z', payload: {} }
}

describe('mergeTimeline', () => {
  it('appends live events that arrived while the history was loading', () => {
    const history = [ev('e1', 's1'), ev('e2', 's1')]
    const live = [ev('e3', 's1'), ev('e4', 's1')]
    expect(mergeTimeline(history, live, 's1').map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
  })

  it('drops duplicates already present in the history', () => {
    const history = [ev('e1', 's1'), ev('e2', 's1')]
    const live = [ev('e2', 's1'), ev('e3', 's1')]
    expect(mergeTimeline(history, live, 's1').map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
  })

  it('ignores events belonging to another session', () => {
    const history = [ev('e1', 's1')]
    const live = [ev('x1', 's2')]
    expect(mergeTimeline(history, live, 's1').map((e) => e.id)).toEqual(['e1'])
  })

  it('returns the same array reference when there is nothing to merge', () => {
    const history = [ev('e1', 's1')]
    expect(mergeTimeline(history, [], 's1')).toBe(history)
  })
})
