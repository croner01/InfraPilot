import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, TimelineEvent } from '../../lib/types.js'
import { TRACK_STEPS, type InvestigationProgress, type TrackStepKey } from '../../lib/progress.js'
import { Markdown } from '../ui/Markdown.js'
import { buildThinkingSegments, type ThinkingSegment } from './thinking.js'
import './execution-track.css'

/**
 * 执行跟踪面板（对齐 Cortex 原型右侧「执行跟踪」）
 * - 顶部只钉一行执行进展（第 N/M 步 + 进度条），不遮挡也不重复内容
 * - 实时思考流落在「思考记录」的 live 条目上：默认展开、自动跟随最新文本
 * - 步骤时间线：里程碑 + 归属于该步骤的技能调用（不再单独堆一长串调用列表）
 * - 底部会话信息汇总；逐次调用的时间/风险/参数由右栏「审计」Tab 呈现（AuditCallList）
 */

interface TrackToolCall {
  toolCallId: string
  skill: string
  tool: string
  name: string
  status: 'running' | 'ok' | 'fail'
  durationMs?: number
  risk?: string
  time: string
  args?: Record<string, unknown>
  /** 该调用在事件流中的序号，用于归属到里程碑 */
  eventIndex: number
}

interface Milestone {
  key: TrackStepKey
  label: string
  time?: string
  status: 'done' | 'active' | 'pending'
  note?: string
}

const RISK_ORDER = ['readonly', 'low', 'medium', 'high', 'critical']
const RISK_LABEL: Record<string, string> = {
  readonly: '只读',
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
}

function buildToolCalls(events: TimelineEvent[]): TrackToolCall[] {
  const calls: TrackToolCall[] = []
  const index = new Map<string, number>()
  events.forEach((event, eventIndex) => {
    const p = event.payload || {}
    const skill = String(p.skill ?? '')
    const tool = String(p.tool ?? '')
    const id = String(p.toolCallId ?? event.id)
    if (event.type === 'tool_call_start') {
      index.set(id, calls.length)
      calls.push({
        toolCallId: id,
        skill,
        tool,
        name: `${skill}.${tool}`,
        status: 'running',
        risk: p.risk?.level,
        time: clock(event.timestamp),
        args: p.args,
        eventIndex,
      })
    } else if (event.type === 'tool_call_result') {
      const existing = index.get(id)
      const ok = Boolean(p.result?.success)
      const patch: Partial<TrackToolCall> = {
        status: ok ? 'ok' : 'fail',
        durationMs: p.result?.durationMs != null ? Number(p.result.durationMs) : undefined,
        risk: p.risk?.level ?? (existing !== undefined ? calls[existing]?.risk : undefined) ?? 'readonly',
      }
      if (existing !== undefined && calls[existing]) {
        calls[existing] = { ...calls[existing], ...patch }
      } else {
        calls.push({
          toolCallId: id,
          skill,
          tool,
          name: `${skill}.${tool}`,
          time: clock(event.timestamp),
          eventIndex,
          ...(patch as Pick<TrackToolCall, 'status' | 'durationMs' | 'risk'>),
        })
      }
    }
  })
  return calls
}

/** 各阶段用于取时间戳/判定达成的事件类型 */
const STEP_EVENT_TYPES: Record<TrackStepKey, string> = {
  intake: 'user_message',
  collect: 'tool_call_result',
  remediate: 'approval_decision',
  archive: 'rca_conclusion',
}

function buildMilestones(
  events: TimelineEvent[],
  session: AgentSession | undefined,
  progress: InvestigationProgress | null | undefined,
): Milestone[] {
  const has = (type: string) => events.some((e) => e.type === type)
  const firstOf = (types: string[]) => events.find((e) => types.includes(e.type))
  const approved = events.some((e) => e.type === 'approval_decision' && e.payload?.decision === 'approved')

  const reached: Record<TrackStepKey, boolean> = {
    intake: has('user_message'),
    collect: has('tool_call_result'),
    remediate: approved || has('remediation_plan'),
    archive: has('rca_conclusion') || has('done') || session?.rootCause != null,
  }

  // 当前步骤以进度线（会话状态推导）为准，保证「第 N 步」与里程碑高亮一致
  const activeIdx = progress
    ? TRACK_STEPS.findIndex((s) => s.key === progress.key)
    : TRACK_STEPS.findIndex((s) => !reached[s.key])
  const finished = session?.status === 'concluded' || session?.status === 'closed'

  return TRACK_STEPS.map((step, i) => {
    const evt =
      step.key === 'remediate'
        ? firstOf(['approval_decision', 'remediation_plan'])
        : firstOf([STEP_EVENT_TYPES[step.key]])
    let status: Milestone['status']
    if (finished || activeIdx < 0) {
      // 会话已结束 / 无法定位当前阶段：按事件达成情况展示，不出现越级打勾
      status = reached[step.key] ? 'done' : 'pending'
    } else if (i > activeIdx) {
      status = 'pending'
    } else if (i === activeIdx) {
      status = 'active'
    } else {
      status = 'done'
    }
    return {
      key: step.key,
      label: step.label,
      time: evt ? clock(evt.timestamp) : undefined,
      status,
      note: step.note,
    }
  })
}

/** 把每次技能调用归属到它所属的里程碑（按事件顺序切段） */
function groupCallsByStep(events: TimelineEvent[], calls: TrackToolCall[]): Record<string, TrackToolCall[]> {
  const firstIndex = (types: string[]) => {
    const i = events.findIndex((e) => types.includes(e.type))
    return i < 0 ? undefined : i
  }
  const collectAt = firstIndex(['tool_call_start'])
  const remediateAt = firstIndex(['approval_decision', 'remediation_plan'])
  const archiveAt = firstIndex(['rca_conclusion', 'done'])

  const buckets: Record<string, TrackToolCall[]> = { intake: [], collect: [], remediate: [], archive: [] }
  for (const call of calls) {
    let key: TrackStepKey = 'intake'
    if (archiveAt !== undefined && call.eventIndex > archiveAt) key = 'archive'
    else if (remediateAt !== undefined && call.eventIndex > remediateAt) key = 'remediate'
    else if (collectAt !== undefined && call.eventIndex >= collectAt) key = 'collect'
    buckets[key].push(call)
  }
  return buckets
}

function summarize(text: string, max = 46): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function ExecutionTrackPanel({
  events,
  running,
  session,
  progress,
}: {
  events: TimelineEvent[]
  running: boolean
  session?: AgentSession
  /** 调查阶段进度（会话状态推导），钉在面板顶部展示执行进展 */
  progress?: InvestigationProgress | null
}) {

  const toolCalls = useMemo(() => buildToolCalls(events), [events])
  const milestones = useMemo(
    () => buildMilestones(events, session, progress),
    [events, session, progress],
  )
  const stepTools = useMemo(() => groupCallsByStep(events, toolCalls), [events, toolCalls])
  const thinkingLog = useMemo(() => buildThinkingSegments(events, 'track-think'), [events])
  // 展开态：流式中 / 结论 默认展开；过程推理完成后折叠；用户手动操作优先并 pin 住
  const [thinkOverrides, setThinkOverrides] = useState<Record<string, boolean>>({})
  const thinkOpen = (entry: ThinkingSegment) =>
    thinkOverrides[entry.id] ?? (entry.live || entry.kind === 'answer')
  const toggleThink = (entry: ThinkingSegment) =>
    setThinkOverrides((prev) => ({ ...prev, [entry.id]: !thinkOpen(entry) }))
  // 实时条目正文自动跟随最新一行
  const liveBodyRef = useRef<HTMLDivElement | null>(null)
  const liveText = thinkingLog.find((entry) => entry.live)?.text
  useEffect(() => {
    const el = liveBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveText])

  const totalDuration = toolCalls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
  const failCount = toolCalls.filter((c) => c.status === 'fail').length
  const writeCalls = toolCalls.filter((c) => (c.risk ?? 'readonly') !== 'readonly')
  const highestRisk = toolCalls.reduce(
    (acc, c) => Math.max(acc, RISK_ORDER.indexOf(c.risk ?? 'readonly')),
    0,
  )
  const skills = Array.from(new Set(toolCalls.map((c) => c.skill).filter(Boolean)))

  return (
    <div className="ui-track">
      <div className="ui-track__body">
        <div className="ui-track__sticky">
          {progress && (
            <div className="ui-track__progress">
              <span className="ui-track__progress-label">
                <span className="ui-pulse-dot" />第 {progress.step}/{progress.total} 步 · {progress.label}
              </span>
              <span className="ui-track__progress-track">
                <span className="ui-track__progress-fill" style={{ width: `${Math.max(4, Math.min(100, progress.percent))}%` }} />
              </span>
            </div>
          )}
        </div>

          <div className="ui-track__section-title">执行里程碑</div>
          <ol className="ui-track__steps">
            {milestones.map((m, i) => {
              const calls = stepTools[m.key] ?? []
              return (
                <li key={m.key} className={`ui-track__step ui-track__step--${m.status}`}>
                  <span className="ui-track__step-dot">{m.status === 'done' ? '✓' : i + 1}</span>
                  <div className="ui-track__step-body">
                    <div className="ui-track__step-head">
                      <span className="ui-track__step-label">
                        第 {i + 1} 步 · {m.label}
                      </span>
                      {m.time && <span className="ui-track__step-time">{m.time}</span>}
                    </div>
                    <div className="ui-track__step-note">{m.note}</div>
                    {calls.length > 0 && (
                      <ul className="ui-track__step-tools">
                        {calls.map((c) => (
                          <li key={c.toolCallId} className={`ui-track__tool ui-track__tool--${c.status}`}>
                            <span className="ui-track__tool-status">
                              {c.status === 'ok' ? '✓' : c.status === 'fail' ? '✗' : '●'}
                            </span>
                            <span className="ui-track__tool-name">{c.name}</span>
                            <span className="ui-track__tool-meta">
                              {c.risk && c.risk !== 'readonly' && (
                                <span className="ui-track__call-risk">{RISK_LABEL[c.risk] ?? c.risk}</span>
                              )}
                              {c.durationMs != null && <span className="t">{c.durationMs}ms</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>

          <div className="ui-track__section-title">思考记录（{thinkingLog.length}）</div>
          {thinkingLog.length === 0 ? (
            // 跑动中但还没有推理输出：在这里给出「还活着」的信号，而不是再开一块悬浮卡片
            <div className="ui-track__empty">{running ? 'Agent 正在思考…' : '暂无思考记录'}</div>
          ) : (
            <ul className="ui-thinklog">
              {thinkingLog.map((entry, index) => {
                const open = thinkOpen(entry)
                return (
                  <li
                    key={entry.id}
                    className={`ui-thinklog__item${open ? ' ui-thinklog__item--open' : ''}${entry.live ? ' ui-thinklog__item--live' : ''}`}
                  >
                    <button
                      type="button"
                      className="ui-thinklog__head"
                      aria-expanded={open}
                      onClick={() => toggleThink(entry)}
                    >
                      <span className="ui-thinklog__idx">{index + 1}</span>
                      <span className="ui-thinklog__time">{entry.timestamp ? clock(entry.timestamp) : '实时'}</span>
                      <span className="ui-thinklog__summary">{summarize(entry.text)}</span>
                      {entry.kind === 'answer' && <span className="ui-thinklog__badge">结论</span>}
                      <span className="ui-thinklog__caret">{open ? '▾' : '▸'}</span>
                    </button>
                    {open && (
                      <div className="ui-thinklog__body" ref={entry.live ? liveBodyRef : undefined}>
                        <Markdown>{entry.text}</Markdown>
                        {entry.live && <span className="ui-track__cursor" />}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <div className="ui-track__info">
            <div className="ui-track__info-row">
              <span>对象</span>
              <b>{session?.subject ?? '—'}</b>
            </div>
            <div className="ui-track__info-row">
              <span>技能</span>
              <b>{skills.length > 0 ? skills.join(' / ') : '—'}</b>
            </div>
            <div className="ui-track__info-row">
              <span>工具调用</span>
              <b>
                {toolCalls.length} 次 · 只读 {toolCalls.length - writeCalls.length} · 变更 {writeCalls.length}
              </b>
            </div>
            <div className="ui-track__info-row">
              <span>风险等级</span>
              <b className={highestRisk > 0 ? 'ui-track__info-risk' : undefined}>
                {highestRisk > 0 ? `${RISK_LABEL[RISK_ORDER[highestRisk]]} × ${writeCalls.length}` : '只读'}
              </b>
            </div>
            <div className="ui-track__info-row">
              <span>证据</span>
              <b>{session?.evidence.length ?? 0} 条</b>
            </div>
            <div className="ui-track__summary">
              <span>总耗时 {totalDuration}ms</span>
              <span>{failCount > 0 ? `失败 ${failCount} 次` : '全部成功'}</span>
            </div>
          </div>
        </div>
    </div>
  )
}

/** 审计 Tab：逐次技能调用的时间 / 风险 / 参数（由右栏「审计」承载） */
export function AuditCallList({ events, session }: { events: TimelineEvent[]; session?: AgentSession }) {
  const toolCalls = useMemo(() => buildToolCalls(events), [events])
  const failCount = toolCalls.filter((c) => c.status === 'fail').length

  return (
    <div className="ui-track">
      <div className="ui-track__body">
        <div className="ui-track__section-title">审计记录（{toolCalls.length}）</div>
        {toolCalls.length === 0 ? (
          <div className="ui-track__empty">暂无审计记录</div>
        ) : (
          <ul className="ui-track__calls">
            {toolCalls.map((c) => (
              <li key={c.toolCallId} className={`ui-track__call ui-track__call--${c.status}`}>
                <span className="ui-track__call-status">
                  {c.status === 'ok' ? '✓' : c.status === 'fail' ? '✗' : '●'}
                </span>
                <div className="ui-track__audit-body">
                  <div className="ui-track__call-name">{c.name}</div>
                  <div className="ui-track__audit-meta">
                    <span>{c.time}</span>
                    <span>风险: {RISK_LABEL[c.risk ?? 'readonly'] ?? c.risk ?? '只读'}</span>
                    {c.args && <span>参数 {Object.keys(c.args).length} 项</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="ui-track__summary">
          <span>共 {toolCalls.length} 次调用</span>
          <span>{failCount > 0 ? `失败 ${failCount} 次` : '全部成功'}</span>
          <span>证据 {session?.evidence.length ?? 0} 条</span>
        </div>
        <div className="ui-track__hint">
          完整审计（含审批哈希与脱敏输出）见「诊断计划 / 审计日志」Tab 与 server 审计表。
        </div>
      </div>
    </div>
  )
}
