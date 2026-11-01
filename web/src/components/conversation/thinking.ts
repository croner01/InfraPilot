import type { TimelineEvent } from '../../lib/types.js'

/**
 * 思考段模型：把一次会话里的推理文本切成「过程推理」与「最终答复」两类。
 * - reasoning：中间的计划/假设/探索说明（完成后自动折叠）
 * - answer：根因结论/修复方案，或本轮的最终答复（保持展开）
 */
export type ThinkKind = 'reasoning' | 'answer'

export interface ThinkingSegment {
  id: string
  text: string
  live: boolean
  kind: ThinkKind
  timestamp?: string
}

const ANSWER_MARKERS = /【\s*(根因分析结论|修复方案)\s*】/
const REASONING_MARKERS = /【\s*(诊断计划|假设列表|反证检查)\s*】/

/** 这些事件出现意味着该段思考只是过程：后面还有工具/审批/后续推理。 */
const FOLLOWUP_TYPES = new Set([
  'tool_call_start',
  'tool_call_result',
  'evidence_added',
  'assistant_message',
  'approval_request',
  'approval_decision',
  'remediation_plan',
])

export function classifyThinkKind(text: string, followup: boolean): ThinkKind {
  if (ANSWER_MARKERS.test(text)) return 'answer'
  if (REASONING_MARKERS.test(text)) return 'reasoning'
  // 后面还有后续动作 => 这段是中间说明；否则是本轮的最终答复（如知识类回答）
  return followup ? 'reasoning' : 'answer'
}

/** flags[i] = 第 i 个事件之后是否还存在「后续动作」事件 */
export function followupFlags(events: TimelineEvent[]): boolean[] {
  const flags = new Array<boolean>(events.length).fill(false)
  let seen = false
  for (let i = events.length - 1; i >= 0; i -= 1) {
    flags[i] = seen
    if (FOLLOWUP_TYPES.has(events[i].type)) seen = true
  }
  return flags
}

/** 按 assistant_message 切分思考段；流式增量归入当前段，live 段留在末尾。 */
export function buildThinkingSegments(events: TimelineEvent[], idPrefix: string): ThinkingSegment[] {
  const flags = followupFlags(events)
  const segments: ThinkingSegment[] = []
  let buffer = ''
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (event.type === 'assistant_delta') {
      buffer += String(event.payload?.content ?? '')
      continue
    }
    if (event.type === 'assistant_message') {
      const content = String(event.payload?.content ?? '')
      const text = (content.trim() || buffer).trim()
      if (text) {
        segments.push({
          id: `${idPrefix}-${segments.length}`,
          text,
          live: false,
          kind: classifyThinkKind(text, flags[i]),
          timestamp: event.timestamp,
        })
      }
      buffer = ''
    }
  }
  if (buffer.trim()) {
    segments.push({ id: `${idPrefix}-${segments.length}`, text: buffer.trim(), live: true, kind: 'reasoning' })
  }
  return segments
}
