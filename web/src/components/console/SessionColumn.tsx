import type { AgentSession } from '../../lib/types.js'
import { SessionList } from './SessionList.js'
import './session-column.css'

interface SessionColumnProps {
  activeSessions: AgentSession[]
  closedSessions: AgentSession[]
  currentId: string | null
  search: string
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onTitleSave: (id: string, title: string) => void
  onNew: () => void
  onCollapse: () => void
  onExpand: () => void
  /** 整列折叠（原型 .session-col.collapsed：宽度收为 0，由会话顶栏 ☰ 再展开） */
  collapsed?: boolean
}

/**
 * 会话清单独立列（对齐 prototypes/agent-session-cortex.html 的 .session-col）。
 * 与左侧导航分成两列，避免导航项和会话清单挤在同一个工作区栏里。
 */
export function SessionColumn({
  activeSessions,
  closedSessions,
  currentId,
  search,
  onSearch,
  onSelect,
  onDelete,
  onTitleSave,
  onNew,
  onCollapse,
  onExpand,
  collapsed = false,
}: SessionColumnProps) {
  if (collapsed) {
    // 收起后留一个常驻把手：没有打开会话时没有会话顶栏 ☰，必须仍能展开回来
    return (
      <button
        type="button"
        className="ui-session-col__handle"
        onClick={onExpand}
        title="展开会话清单"
        aria-label="展开会话清单"
      >
        <span className="ui-session-col__handle-arrow">▸</span>
        <span className="ui-session-col__handle-text">诊断会话</span>
      </button>
    )
  }
  return (
    <aside className="ui-session-col" aria-label="诊断会话清单">
      <div className="ui-session-col__header">
        <div className="ui-session-col__title">诊断会话</div>
        <button type="button" className="ui-session-col__new" title="新建会话" aria-label="新建会话" onClick={onNew}>
          ＋
        </button>
        <button
          type="button"
          className="ui-session-col__collapse"
          title="折叠会话清单"
          aria-label="折叠会话清单"
          onClick={onCollapse}
        >
          «
        </button>
      </div>
      <SessionList
        activeSessions={activeSessions}
        closedSessions={closedSessions}
        currentId={currentId}
        search={search}
        onSearch={onSearch}
        onSelect={onSelect}
        onDelete={onDelete}
        onTitleSave={onTitleSave}
      />
    </aside>
  )
}
