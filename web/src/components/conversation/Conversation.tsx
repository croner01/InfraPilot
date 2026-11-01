import { Fragment, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { TimelineEvent } from '../../lib/types.js'
import { MessageUser } from './MessageUser.js'
import {
  EvidenceChips,
  ProgressLine,
  ThinkCard,
  ToolCallCard,
  ToolGroupCard,
  type ProcessItem,
} from './ProcessSection.js'
import { StreamStatusLine } from './StreamStatusLine.js'
import { classifyThinkKind, followupFlags } from './thinking.js'
import './conversation.css'

const PROCESS_TYPES = new Set(['tool_call_start', 'tool_call_result', 'evidence_added', 'evidence_gap_probe'])
// 计划/状态等由右侧「执行跟踪」面板承载，不在对话流中重复展示
const SKIP_TYPES = new Set([
  'checkpoint_saved',
  'runner_resumed',
  'hypothesis_update',
  'plan_update',
  'status',
  'session_created',
])

export interface ConversationProgress {
  step: number
  total: number
  label: string
  percent: number
}

interface ConversationProps {
  events: TimelineEvent[]
  loading: boolean
  running?: boolean
  statusMessage?: string
  progress?: ConversationProgress | null
  /** 结尾追加内容（如根因结论卡），渲染在会话流末尾 */
  footer?: ReactNode
  renderSpecial: (event: TimelineEvent) => ReactNode
  chatEndRef: RefObject<HTMLDivElement | null>
}

type Entry =
  | { kind: 'process'; key: string; item: ProcessItem }
  | { kind: 'evidence'; key: string; label: string }
  | { kind: 'special'; key: string; node: ReactNode }

interface Block {
  key: string
  userMessage?: string
  userTs?: string
  agentTs?: string
  entries: Entry[]
  /** 已完成的思考段数量；下一个流式段的稳定 key 由它决定 */
  thinkCount: number
  /** 当前流式思考段的稳定 key（与完成后的 key 相同，便于复用 DOM） */
  liveThinkKey?: string
}

export function Conversation({
  events,
  loading,
  running = false,
  statusMessage,
  progress,
  footer,
  renderSpecial,
  chatEndRef,
}: ConversationProps) {
  const { blocks, runningTool } = buildBlocks(events, renderSpecial)
  const statusText = runningTool ? `正在执行 ${runningTool}…` : (statusMessage ?? 'Agent 正在思考…')
  // 思考段展开态：默认「流式中 / 结论」展开，「过程推理」完成后折叠；用户手动操作优先并 pin 住
  const [thinkOverrides, setThinkOverrides] = useState<Record<string, boolean>>({})
  const isThinkOpen = (item: ProcessItem) =>
    thinkOverrides[item.key] ?? Boolean(item.thinkLive || item.thinkKind === 'answer')
  const toggleThink = (item: ProcessItem) =>
    setThinkOverrides((prev) => ({ ...prev, [item.key]: !isThinkOpen(item) }))

  return (
    <div className="ui-conversation">
      <div className="ui-conversation__inner">
        {blocks.map((block) => (
          <Fragment key={block.key}>
            {block.userMessage !== undefined && (
              <MessageUser content={block.userMessage} time={block.userTs ? formatClock(block.userTs) : undefined} />
            )}
            {block.entries.length > 0 && (
              <div className="ui-agent-block">
                <div className="ui-agent-block__head">
                  <span className="ui-agent-avatar">IP</span>
                  <div>
                    <div className="ui-agent-block__name">InfraPilot Agent</div>
                    <div className="ui-agent-block__time">{blockTimeLabel(block, events)}</div>
                  </div>
                </div>
                {running && progress && (
                  <ProgressLine label={`第 ${progress.step} 步 · ${progress.label}`} percent={progress.percent} />
                )}
                {renderEntries(block.entries, isThinkOpen, toggleThink)}
              </div>
            )}
          </Fragment>
        ))}
        {(loading || running) && <StreamStatusLine text={statusText} />}
        {footer}
        <div ref={chatEndRef} />
      </div>
    </div>
  )
}

/** 按事件顺序重建「用户消息 → Agent 输出块」的扁平结构（对齐 Cortex 原型） */
function buildBlocks(
  events: TimelineEvent[],
  renderSpecial: (event: TimelineEvent) => ReactNode,
): { blocks: Block[]; runningTool: string | null } {
  const blocks: Block[] = []
  const flags = followupFlags(events)
  let current: Block = { key: 'block-0', entries: [], thinkCount: 0 }
  const toolIndex = new Map<string, number>()
  let runningTool: string | null = null
  let blockSeq = 0

  const flush = () => {
    if (current.userMessage !== undefined || current.entries.length > 0) {
      blocks.push(current)
    }
  }

  const findThink = (key: string): Extract<Entry, { kind: 'process' }> | undefined => {
    for (const entry of current.entries) {
      if (entry.kind === 'process' && entry.item.key === key) return entry
    }
    return undefined
  }

  const mergeTool = (item: ProcessItem) => {
    const id = item.toolCallId
    const existing = id ? toolIndex.get(id) : undefined
    if (existing !== undefined) {
      const prev = current.entries[existing]
      if (prev && prev.kind === 'process') {
        const merged: ProcessItem = {
          ...prev.item,
          ...item,
          key: prev.item.key,
          title: prev.item.title,
          args: item.args ?? prev.item.args,
          riskLevel: item.riskLevel ?? prev.item.riskLevel,
        }
        current.entries[existing] = { kind: 'process', key: prev.key, item: merged }
        return
      }
    }
    if (id) toolIndex.set(id, current.entries.length)
    current.entries.push({ kind: 'process', key: item.key, item })
  }

  for (let idx = 0; idx < events.length; idx += 1) {
    const event = events[idx]
    if (SKIP_TYPES.has(event.type)) continue
    const p = event.payload || {}

    if (event.type === 'user_message') {
      flush()
      blockSeq += 1
      current = { key: `block-${blockSeq}-${event.id}`, entries: [], thinkCount: 0 }
      current.userMessage = String(p.message ?? p.content ?? '')
      current.userTs = event.timestamp
      toolIndex.clear()
      continue
    }

    if (current.agentTs === undefined) current.agentTs = event.timestamp

    if (event.type === 'assistant_delta') {
      // 同一段思考使用稳定 key：流式 → 完成时复用同一 DOM 节点，便于展开/折叠过渡
      const key = current.liveThinkKey ?? `think-${current.key}-${current.thinkCount}`
      current.liveThinkKey = key
      const piece = String(p.content ?? '')
      if (piece) {
        const entry = findThink(key)
        if (entry) {
          entry.item = { ...entry.item, detail: (entry.item.detail ?? '') + piece, thinkLive: true }
        } else {
          current.entries.push({
            kind: 'process',
            key,
            item: { key, icon: 'think', title: '思考过程', detail: piece, thinkLive: true },
          })
        }
      }
      continue
    }
    if (event.type === 'assistant_message') {
      const content = String(p.content ?? '')
      const key = current.liveThinkKey ?? `think-${current.key}-${current.thinkCount}`
      const entry = findThink(key)
      // assistant_message 是完整正文，优先于流式累积，避免丢帧造成残缺
      const text = (content.trim() || entry?.item.detail || '').trim()
      const kind = classifyThinkKind(text, flags[idx])
      if (entry) {
        entry.item = { ...entry.item, detail: text || entry.item.detail || '', thinkLive: false, thinkKind: kind }
      } else if (text) {
        current.entries.push({
          kind: 'process',
          key,
          item: { key, icon: 'think', title: '思考过程', detail: text, thinkKind: kind },
        })
      }
      current.thinkCount += 1
      current.liveThinkKey = undefined
      continue
    }
    if (PROCESS_TYPES.has(event.type)) {
      const item = toProcessItem(event)
      if (event.type === 'tool_call_start' || event.type === 'tool_call_result') {
        mergeTool(item)
        if (item.status === 'running') runningTool = item.title
      } else if (item.icon === 'evidence') {
        current.entries.push({ kind: 'evidence', key: event.id, label: String(p.summary ?? item.detail ?? '证据') })
      } else {
        current.entries.push({ kind: 'process', key: event.id, item })
      }
      continue
    }
    current.entries.push({ kind: 'special', key: event.id, node: <Fragment key={event.id}>{renderSpecial(event)}</Fragment> })
  }
  flush()
  return { blocks, runningTool }
}

/** 顺序渲染块内条目：工具卡自动合并连续只读调用，证据合并为 chips 行 */
function renderEntries(
  entries: Entry[],
  isThinkOpen: (item: ProcessItem) => boolean,
  onToggleThink: (item: ProcessItem) => void,
): ReactNode[] {
  const out: ReactNode[] = []
  let run: ProcessItem[] = []
  const flushRun = () => {
    if (run.length >= 2) {
      out.push(
        <ToolGroupCard
          key={`group-${run[0].key}`}
          group={{ key: `group-${run[0].key}`, isGroup: true, label: '批量采集', items: run }}
        />,
      )
    } else if (run.length === 1) {
      out.push(<ToolCallCard key={run[0].key} item={run[0]} />)
    }
    run = []
  }

  let i = 0
  while (i < entries.length) {
    const entry = entries[i]
    if (entry.kind === 'special') {
      flushRun()
      out.push(entry.node)
      i += 1
      continue
    }
    if (entry.kind === 'evidence') {
      flushRun()
      const labels: { id: string; label: string }[] = []
      while (i < entries.length && entries[i].kind === 'evidence') {
        const evidence = entries[i] as Extract<Entry, { kind: 'evidence' }>
        labels.push({ id: evidence.key, label: evidence.label })
        i += 1
      }
      out.push(<EvidenceChips key={`evidence-${labels[0].id}`} items={labels} />)
      continue
    }
    const item = entry.item
    if (item.icon === 'think') {
      flushRun()
      out.push(
        <ThinkCard
          key={item.key}
          text={item.detail ?? ''}
          live={item.thinkLive}
          kind={item.thinkKind}
          open={isThinkOpen(item)}
          onToggle={() => onToggleThink(item)}
        />,
      )
      i += 1
      continue
    }
    if (item.icon === 'tool' && item.status === 'ok') {
      run.push(item)
      i += 1
      continue
    }
    flushRun()
    if (item.icon === 'tool') {
      out.push(<ToolCallCard key={item.key} item={item} />)
    } else {
      out.push(<ProcessRow key={item.key} item={item} />)
    }
    i += 1
  }
  flushRun()
  return out
}

function ProcessRow({ item }: { item: ProcessItem }) {
  return (
    <div className="ui-process-row">
      <span className="ui-process-row__icon">{item.icon === 'plan' ? '≡' : 'ⓘ'}</span>
      <span className="ui-process-row__title">{item.title}</span>
      {item.detail && <span className="ui-process-row__detail">{item.detail}</span>}
      {item.time && <span className="ui-process-row__time">{item.time}</span>}
    </div>
  )
}

function blockTimeLabel(block: Block, events: TimelineEvent[]): string {
  if (!block.agentTs) return ''
  const start = formatClock(block.agentTs)
  const last = events[events.length - 1]?.timestamp
  if (!last || last === block.agentTs) return start
  const elapsed = new Date(last).getTime() - new Date(block.agentTs).getTime()
  if (elapsed <= 0) return start
  return `${start} · 已运行 ${formatElapsed(elapsed)}`
}

function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes} 分 ${seconds} 秒`
}

/** 截断工具输出，避免超长结果撑爆卡片 */
function truncate(text: string, max = 2400): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，完整结果见证据链/审计）` : text
}

function resultToText(result: any): string | undefined {
  if (!result) return undefined
  const parts: string[] = []
  if (result.error) parts.push(`错误: ${result.error}`)
  if (result.stdout) parts.push(String(result.stdout))
  if (result.stderr) parts.push(`stderr: ${result.stderr}`)
  if (result.data !== undefined && result.data !== null) {
    try {
      parts.push(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2))
    } catch {
      parts.push(String(result.data))
    }
  }
  if (parts.length === 0) parts.push(result.success ? '执行成功（无输出）' : '执行失败')
  return truncate(parts.join('\n'))
}

function toProcessItem(event: TimelineEvent): ProcessItem {
  const p = event.payload || {}
  switch (event.type) {
    case 'tool_call_start':
      return {
        key: event.id,
        icon: 'tool',
        status: 'running',
        toolCallId: String(p.toolCallId ?? event.id),
        title: `${p.skill}.${p.tool}()`,
        riskLevel: p.risk?.level,
        args: p.args,
        time: formatClock(event.timestamp),
      }
    case 'tool_call_result': {
      const ok = Boolean(p.result?.success)
      return {
        key: event.id,
        icon: 'tool',
        status: ok ? 'ok' : 'fail',
        toolCallId: String(p.toolCallId ?? event.id),
        title: `${p.skill}.${p.tool}()`,
        durationMs: p.result?.durationMs != null ? Number(p.result.durationMs) : undefined,
        riskLevel: p.risk?.level,
        args: p.args,
        resultText: resultToText(p.result),
        time: formatClock(event.timestamp),
      }
    }
    case 'evidence_added':
      return {
        key: event.id,
        icon: 'evidence',
        title: '新增证据',
        detail: String(p.summary ?? ''),
        time: formatClock(event.timestamp),
      }
    case 'evidence_gap_probe':
      return {
        key: event.id,
        icon: 'status',
        title: '结论自检：置信度不足，追加一轮证据采集',
        detail: '将以新证据复核结论，不会重复已执行过的工具调用。',
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
