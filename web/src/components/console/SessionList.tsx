import { useState } from 'react'
import type { AgentSession } from '../../lib/types.js'
import { formatTime } from '../../lib/format.js'
import { RUNNING_SESSION_STATUSES, sessionStatusClass as statusClass, sessionStatusText as statusText } from '../../lib/session-status.js'
import './session-list.css'

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
  // 对齐原型 meta 行的「资源域」：优先用本轮激活技能，其次用已调用工具的 skill
  const scope = Array.from(
    new Set([
      ...(session.activeSkills ?? []),
      ...session.executedToolCalls.map((call) => call.skill).filter(Boolean),
    ]),
  )
    .slice(0, 2)
    .join(' · ')

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
            {RUNNING_SESSION_STATUSES.has(session.status) && <span className="ui-session-item__run-dot" />}
            {session.title}
          </span>
        )}
        <span className="ui-session-item__actions">
          <button
            type="button"
            className="ui-session-item__action"
            title="重命名"
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="ui-session-item__action ui-session-item__action--danger"
            title="删除会话"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            ✕
          </button>
        </span>
      </div>
      <div className="ui-session-item__meta">
        <span className={`ui-status ${statusClass[session.status] ?? ''}`}>
          {statusText[session.status] ?? session.status}
        </span>
        {scope && <span className="ui-session-item__scope" title={`会话 ${session.id}`}>{scope}</span>}
        <span className="ui-session-item__time">{formatTime(session.updatedAt)}</span>
      </div>
    </div>
  )
}
