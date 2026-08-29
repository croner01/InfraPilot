import { Fragment } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { TimelineEvent } from '../../lib/types.js'
import { MessageUser } from './MessageUser.js'
import { MessageAssistant } from './MessageAssistant.js'
import { ProcessSection, type ProcessItem } from './ProcessSection.js'
import { StreamStatusLine } from './StreamStatusLine.js'
import './conversation.css'

const PROCESS_TYPES = new Set(['tool_call_start', 'tool_call_result', 'evidence_added', 'plan_update', 'status'])
const SKIP_TYPES = new Set(['checkpoint_saved', 'runner_resumed', 'hypothesis_update'])

interface ConversationProps {
  events: TimelineEvent[]
  loading: boolean
  renderSpecial: (event: TimelineEvent) => ReactNode
  chatEndRef: RefObject<HTMLDivElement | null>
}

export function Conversation({ events, loading, renderSpecial, chatEndRef }: ConversationProps) {
  const { items, runningTool } = buildItems(events, renderSpecial)
  return (
    <div className="ui-conversation">
      <div className="ui-conversation__inner">
        {loading && <StreamStatusLine text={runningTool ? `正在执行 ${runningTool}…` : 'Agent 正在思考…'} />}
        {items.map((item) =>
          item.kind === 'process' ? (
            <ProcessSection key={item.key} items={item.items} />
          ) : (
            item.node
          ),
        )}
        <div ref={chatEndRef} />
      </div>
    </div>
  )
}

type RenderItem =
  | { kind: 'process'; key: string; items: ProcessItem[] }
  | { kind: 'node'; node: ReactNode }

function buildItems(
  events: TimelineEvent[],
  renderSpecial: (event: TimelineEvent) => ReactNode,
): { items: RenderItem[]; runningTool: string | null } {
  const items: RenderItem[] = []
  let buffer: ProcessItem[] = []
  let runningTool: string | null = null
  let groupIndex = 0

  const flush = () => {
    if (buffer.length > 0) {
      items.push({ kind: 'process', key: `process-${groupIndex++}`, items: buffer })
      buffer = []
    }
  }

  for (const event of events) {
    if (SKIP_TYPES.has(event.type)) continue
    if (PROCESS_TYPES.has(event.type)) {
      const item = toProcessItem(event)
      buffer.push(item)
      if (item.icon === 'tool' && item.status === 'running') {
        runningTool = item.title
      }
      continue
    }
    flush()
    if (event.type === 'user_message') {
      items.push({
        kind: 'node',
        node: <MessageUser key={event.id} content={String(event.payload?.message ?? event.payload?.content ?? '')} />,
      })
    } else if (event.type === 'assistant_message') {
      items.push({
        kind: 'node',
        node: <MessageAssistant key={event.id} content={String(event.payload?.content ?? '')} />,
      })
    } else {
      items.push({ kind: 'node', node: <Fragment key={event.id}>{renderSpecial(event)}</Fragment> })
    }
  }
  flush()
  return { items, runningTool }
}

function toProcessItem(event: TimelineEvent): ProcessItem {
  const p = event.payload || {}
  switch (event.type) {
    case 'tool_call_start':
      return {
        key: event.id,
        icon: 'tool',
        status: 'running',
        title: `${p.skill}.${p.tool}()`,
        detail: p.risk?.level ? `风险等级: ${p.risk.level}` : undefined,
        time: formatClock(event.timestamp),
      }
    case 'tool_call_result':
      return {
        key: event.id,
        icon: 'result',
        status: p.result?.success ? 'ok' : 'fail',
        title: `${p.skill}.${p.tool}()`,
        detail: p.result?.success ? '执行成功' : '执行失败',
        time: formatClock(event.timestamp),
      }
    case 'evidence_added':
      return {
        key: event.id,
        icon: 'evidence',
        title: '新增证据',
        detail: String(p.summary ?? ''),
        time: formatClock(event.timestamp),
      }
    case 'plan_update':
      return {
        key: event.id,
        icon: 'plan',
        title: '诊断计划更新',
        detail: Array.isArray(p.plan) ? p.plan.join(' → ') : undefined,
        time: formatClock(event.timestamp),
      }
    default:
      return {
        key: event.id,
        icon: 'status',
        title: '状态更新',
        detail: String(p.message ?? p.status ?? ''),
        time: formatClock(event.timestamp),
      }
  }
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
}
