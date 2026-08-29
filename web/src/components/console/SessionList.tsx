import { useState } from 'react'
import type { AgentSession } from '../../lib/types.js'
import { formatTime } from '../../lib/format.js'
import './session-list.css'

const statusText: Record<string, string> = {
  intake: '接收中',
  planning: '分析规划',
  executing: '执行中',
  awaiting_approval: '等待审批',
  reflecting: '反思中',
  concluded: '已得出结论',
  remediating: '修复中',
  closed: '已关闭',
}

const statusClass: Record<string, string> = {
  intake: 'status--intake',
  planning: 'status--planning',
  executing: 'status--executing',
  awaiting_approval: 'status--warning',
  reflecting: 'status--planning',
  concluded: 'status--success',
  remediating: 'status--executing',
  closed: 'status--closed',
}

interface SessionListProps {
  activeSessions: AgentSession[]
  closedSessions: AgentSession[]
  currentId: string | null
  search: string
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onTitleSave: (id: string, title: string) => void
}

export function SessionList({
  activeSessions,
  closedSessions,
  currentId,
  search,
  onSearch,
  onSelect,
  onDelete,
  onTitleSave,
}: SessionListProps) {
  const renderGroup = (title: string, sessions: AgentSession[]) => (
    <>
      <div className="ui-session-list__group-title">
        {title} ({sessions.length})
      </div>
      {sessions.length === 0 && <div className="ui-session-list__empty">暂无会话</div>}
      {sessions.map((session) => (
        <SessionListItem
          key={session.id}
          session={session}
          active={session.id === currentId}
          onSelect={() => onSelect(session.id)}
          onDelete={() => onDelete(session.id)}
          onTitleSave={(title) => onTitleSave(session.id, title)}
        />
      ))}
    </>
  )

  return (
    <div className="ui-session-list">
      <div className="ui-session-list__search">
        <input
          className="ui-session-list__search-input"
          placeholder="搜索会话..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <div className="ui-session-list__content">
        {renderGroup('进行中', activeSessions)}
        {renderGroup('历史会话', closedSessions)}
      </div>
    </div>
  )
}

function SessionListItem({
  session,
  active,
  onSelect,
  onDelete,
  onTitleSave,
}: {
  session: AgentSession
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onTitleSave: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)

  const save = () => {
    setEditing(false)
    onTitleSave(title)
  }

  return (
    <div
      className={`ui-session-item${active ? ' ui-session-item--active' : ''}`}
      onClick={onSelect}
    >
      <div className="ui-session-item__row">
        {editing ? (
          <input
            className="ui-session-item__input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="ui-session-item__title"
            onDoubleClick={() => setEditing(true)}
            title="双击编辑标题"
          >
            {session.title}
          </span>
        )}
        <button
          type="button"
          className="ui-session-item__close"
          title="删除会话"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          ✕
        </button>
      </div>
      <div className="ui-session-item__meta">
        <span className="ui-session-item__id">{session.id.slice(0, 8)}</span>
        <span className={`ui-status ${statusClass[session.status] ?? ''}`}>
          {statusText[session.status] ?? session.status}
        </span>
        <span className="ui-session-item__time">{formatTime(session.updatedAt)}</span>
      </div>
    </div>
  )
}
