import { describe, it, expect } from 'vitest'
import { buildThinkingSegments, classifyThinkKind } from './thinking.js'
import type { TimelineEvent } from '../../lib/types.js'

const ev = (id: string, type: string, payload: Record<string, unknown>): TimelineEvent => ({
  id,
  sessionId: 's1',
  type,
  timestamp: '2026-08-25T10:30:00Z',
  payload,
})

describe('classifyThinkKind', () => {
  it('marks root-cause conclusion and remediation as answer', () => {
    expect(classifyThinkKind('【根因分析结论】内存不足', true)).toBe('answer')
    expect(classifyThinkKind('【修复方案】调大 limit', true)).toBe('answer')
  })

  it('treats plan/hypothesis/counter-evidence as reasoning even without follow-up', () => {
    expect(classifyThinkKind('【诊断计划】先看 Pod', false)).toBe('reasoning')
    expect(classifyThinkKind('【假设列表】可能 OOM', false)).toBe('reasoning')
    expect(classifyThinkKind('【反证检查】无', false)).toBe('reasoning')
  })

  it('uses follow-up activity to decide otherwise', () => {
    expect(classifyThinkKind('先做发现类探查', true)).toBe('reasoning')
    expect(classifyThinkKind('这是本轮最终答复', false)).toBe('answer')
  })
})

describe('buildThinkingSegments', () => {
  it('splits by assistant_message and keeps a trailing live segment', () => {
    const segments = buildThinkingSegments(
      [
        ev('d1', 'assistant_delta', { content: '计' }),
        ev('d2', 'assistant_delta', { content: '划' }),
        ev('m1', 'assistant_message', { content: '计划' }),
        ev('t1', 'tool_call_start', { skill: 'k8s', tool: 'list_pods', toolCallId: 'c1' }),
        ev('d3', 'assistant_delta', { content: '新一段' }),
      ],
      'think',
    )
    expect(segments.map((s) => s.id)).toEqual(['think-0', 'think-1'])
    expect(segments[0].live).toBe(false)
    expect(segments[0].kind).toBe('reasoning')
    expect(segments[1].live).toBe(true)
    expect(segments[1].text).toBe('新一段')
  })

  it('prefers the complete assistant_message over a partial delta buffer', () => {
    const segments = buildThinkingSegments(
      [
        ev('d1', 'assistant_delta', { content: '残' }),
        ev('m1', 'assistant_message', { content: '完整正文' }),
      ],
      'think',
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('完整正文')
  })
})
