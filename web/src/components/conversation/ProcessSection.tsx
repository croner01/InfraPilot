import { useEffect, useState } from 'react'
import { Markdown } from '../ui/Markdown.js'
import type { ThinkKind } from './thinking.js'
import './process-section.css'

export type ProcessItem = {
  key: string
  icon: 'tool' | 'result' | 'evidence' | 'plan' | 'status' | 'think'
  status?: 'ok' | 'fail' | 'running'
  title: string
  detail?: string
  time?: string
  /** 工具调用 ID，用于合并 start/result 事件 */
  toolCallId?: string
  /** 工具入参（展开查看） */
  args?: Record<string, unknown>
  /** 工具输出（展开查看：数据/stdout/错误） */
  resultText?: string
  /** 风险等级（readonly / low / medium / high / critical） */
  riskLevel?: string
  /** 耗时（毫秒） */
  durationMs?: number
  /** 思考段：是否为当前流式段 */
  thinkLive?: boolean
  /** 思考段类型：过程推理 / 最终答复 */
  thinkKind?: ThinkKind
}

/** 批量采集组：连续只读工具调用合并为一张可展开的组卡（Cortex 原型合并） */
export type ProcessGroup = {
  key: string
  isGroup: true
  label: string
  items: ProcessItem[]
}

export type ProcessEntry = ProcessItem | ProcessGroup

export function isProcessGroup(entry: ProcessEntry): entry is ProcessGroup {
  return (entry as ProcessGroup).isGroup === true
}

/**
 * 思考过程卡：紫色强调。
 * - 流式段（live）与最终答复（kind=answer）默认展开
 * - 过程推理（reasoning）完成后默认折叠，可手动展开（受控模式由父级决定）
 * - 折叠/展开使用 grid-template-rows 过渡；未打开过的段不渲染 Markdown，避免长会话开销
 */
export function ThinkCard({
  text,
  live = false,
  kind = 'reasoning',
  time,
  open,
  defaultOpen,
  onToggle,
}: {
  text: string
  live?: boolean
  kind?: ThinkKind
  time?: string
  open?: boolean
  defaultOpen?: boolean
  onToggle?: () => void
}) {
  const controlled = open !== undefined
  const initial = controlled ? Boolean(open) : Boolean(defaultOpen ?? (live || kind === 'answer'))
  const [internalOpen, setInternalOpen] = useState(initial)
  const [mounted, setMounted] = useState(initial)
  const isOpen = controlled ? Boolean(open) : internalOpen

  useEffect(() => {
    if (isOpen) setMounted(true)
  }, [isOpen])

  if (!text.trim()) return null

  const label = live ? '思考中…' : kind === 'answer' ? '分析结论' : '思考过程'
  const toggle = () => {
    if (controlled) onToggle?.()
    else setInternalOpen((value) => !value)
  }

  return (
    <div
      className={`ui-think-card${isOpen ? ' ui-think-card--open' : ''}${kind === 'answer' ? ' ui-think-card--answer' : ''}${live ? ' ui-think-card--live' : ''}`}
    >
      <button
        type="button"
        className="ui-think-card__head"
        aria-expanded={isOpen}
        aria-label={label}
        onClick={toggle}
      >
        <span className="ui-think-card__icon" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3a6 6 0 0 0-9 9 5 5 0 0 0 2 8h1a2 2 0 0 0 4 0 2 2 0 0 1 4 0 2 2 0 0 0 4 0h1a5 5 0 0 0 2-8 6 6 0 0 0-9-9z" />
          </svg>
        </span>
        <span className="ui-think-card__label">{label}</span>
        {kind === 'answer' && !live && <span className="ui-think-card__badge">结论</span>}
        {time && <span className="ui-think-card__time">{time}</span>}
        <span className="ui-think-card__hint">{live ? '实时' : isOpen ? '点击收起' : '点击展开'} ▾</span>
      </button>
      {mounted && (
        <div className={`ui-think-card__collapse${isOpen ? ' ui-think-card__collapse--open' : ''}`}>
          <div className="ui-think-card__collapse-inner">
            <div className="ui-think-card__body">
              <div className="ui-think-card__text">
                <Markdown>{text}</Markdown>
                {live && <span className="ui-think-card__cursor" />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Cortex 风格工具卡：技能名 + 内联参数 + 风险徽章 + 耗时，入参与结果默认展开（对齐原型） */
export function ToolCallCard({ item }: { item: ProcessItem }) {
  const [expanded, setExpanded] = useState(true)
  const argsText = item.args && Object.keys(item.args).length > 0 ? JSON.stringify(item.args, null, 2) : null
  const hasBody = Boolean(argsText || item.resultText)
  const argsInline = summarizeArgs(item.args)
  const name = item.title.replace(/\(\)$/, '')

  return (
    <div className={`ui-toolcard ui-toolcard--${item.status ?? 'running'}`}>
      <div
        className={`ui-toolcard__row${hasBody ? ' ui-toolcard__row--clickable' : ''}`}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? expanded : undefined}
        onClick={() => hasBody && setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (hasBody && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            setExpanded((value) => !value)
          }
        }}
      >
        <span className={`ui-toolcard__status ui-toolcard__status--${item.status ?? 'running'}`}>
          <StatusIcon status={item.status} />
        </span>
        <span className="ui-toolcard__kind">{item.icon === 'evidence' ? '证据' : '技能调用'}</span>
        <span className="ui-toolcard__name">
          {name}
          {argsInline && <span className="args">({argsInline})</span>}
        </span>
        <span className="ui-toolcard__meta">
          {item.riskLevel && <span className={`ui-toolcard__badge ui-toolcard__badge--${item.riskLevel}`}>{item.riskLevel}</span>}
          {item.durationMs != null && <span>{item.durationMs}ms</span>}
          {item.detail && <span>{item.detail}</span>}
          {hasBody && <span className="ui-toolcard__caret">{expanded ? '▾' : '▸'}</span>}
        </span>
      </div>
      {expanded && hasBody && (
        <div className="ui-toolcard__body">
          {argsText && (
            <div className="ui-toolcard__section">
              <div className="ui-toolcard__section-label">入参</div>
              <pre className="ui-toolcard__code">{argsText}</pre>
            </div>
          )}
          {item.resultText && (
            <div className="ui-toolcard__section">
              <div className="ui-toolcard__section-label">
                结果{item.status === 'fail' ? ' · 执行失败' : ''}
              </div>
              <pre className={`ui-toolcard__code${item.status === 'fail' ? ' ui-toolcard__code--error' : ''}`}>
                {item.resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 批量采集组卡：连续只读调用合并，展开后组内每张卡可独立查看 */
export function ToolGroupCard({ group }: { group: ProcessGroup }) {
  const [open, setOpen] = useState(true)
  const totalMs = group.items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const allOk = group.items.every((item) => item.status === 'ok')
  const names = [...new Set(group.items.map((item) => item.title.replace(/\(\)$/, '')))]

  return (
    <div className={`ui-toolgroup${open ? ' ui-toolgroup--open' : ''}`}>
      <button
        type="button"
        className="ui-toolgroup__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`ui-toolcard__status ui-toolcard__status--${allOk ? 'ok' : 'running'}`}>
          <StatusIcon status={allOk ? 'ok' : 'running'} />
        </span>
        <span className="ui-toolcard__kind">批量采集</span>
        <span className="ui-toolgroup__title">
          连续 <b>{group.items.length}</b> 次只读调用已合并 · {names.join(' · ')}
          {totalMs > 0 && ` · 共 ${totalMs}ms`}
        </span>
        <span className="ui-toolcard__meta">
          <span className="ui-toolcard__badge">readonly</span>
          <span className="ui-toolcard__caret">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div className="ui-toolgroup__body">
          {group.items.map((item) => (
            <ToolCallCard key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 里程碑进度线：“第 N 步 · 执行中” + 渐变进度条 */
export function ProgressLine({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="ui-progress-line">
      <span className="ui-progress-line__label">
        <span className="ui-pulse-dot" />
        {label}
      </span>
      <span className="ui-progress-line__track">
        <span className="ui-progress-line__fill" style={{ width: `${Math.max(4, Math.min(100, percent))}%` }} />
      </span>
    </div>
  )
}

/** 证据 chips 行 */
export function EvidenceChips({ items }: { items: { id: string; label: string }[] }) {
  if (items.length === 0) return null
  return (
    <div className="ui-evidence-row">
      <span className="ui-evidence-chip ui-evidence-chip--count">
        📎 证据 <b>{items.length}</b> 条已沉淀
      </span>
      {items.map((item) => (
        <span key={item.id} className="ui-evidence-chip">
          {item.label}
        </span>
      ))}
    </div>
  )
}

function StatusIcon({ status }: { status?: ProcessItem['status'] }) {
  if (status === 'ok') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    )
  }
  if (status === 'fail') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    )
  }
  return <span className="ui-toolcard__spinner" />
}

function summarizeArgs(args?: Record<string, unknown>): string | null {
  if (!args || Object.keys(args).length === 0) return null
  return Object.entries(args)
    .map(([key, value]) => {
      if (value === null || value === undefined) return `${key}=null`
      if (typeof value === 'string') {
        const text = value.length > 42 ? `${value.slice(0, 42)}…` : value
        return `${key}="${text}"`
      }
      if (typeof value === 'object') {
        const text = JSON.stringify(value)
        return `${key}=${text.length > 42 ? `${text.slice(0, 42)}…` : text}`
      }
      return `${key}=${String(value)}`
    })
    .join(', ')
}
