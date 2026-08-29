import type { ReactNode } from 'react'
import type { ViewKey } from '../../lib/view.js'
import type { AgentSession } from '../../lib/types.js'
import { SessionList } from './SessionList.js'
import './sidenav.css'

interface NavItem {
  key: ViewKey
  label: string
  icon: ReactNode
  badge?: number
}

const workspaceNav: NavItem[] = [
  {
    key: 'alerts',
    label: '告警中心',
    icon: (
      <svg className="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
    ),
  },
  {
    key: 'sessions',
    label: '会话中心',
    icon: (
      <svg className="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
]

const resourceNav: NavItem[] = [
  { key: 'knowledge', label: '知识库', icon: <BookIcon /> },
  { key: 'topology', label: '拓扑', icon: <TopologyIcon /> },
  { key: 'skills', label: '技能', icon: <SkillsIcon /> },
  { key: 'settings', label: '设置', icon: <SettingsIcon /> },
]

interface SideNavProps {
  activeView: ViewKey
  alertCount: number
  onNavigate: (view: ViewKey) => void
  activeSessions: AgentSession[]
  closedSessions: AgentSession[]
  currentId: string | null
  search: string
  onSearch: (value: string) => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onTitleSave: (id: string, title: string) => void
}

export function SideNav({
  activeView,
  alertCount,
  onNavigate,
  activeSessions,
  closedSessions,
  currentId,
  search,
  onSearch,
  onSelect,
  onDelete,
  onTitleSave,
}: SideNavProps) {
  const items = workspaceNav.map((item) => ({
    ...item,
    badge: item.key === 'alerts' ? alertCount : undefined,
  }))

  return (
    <aside className="ui-sidenav">
      <div className="ui-sidenav__group">工作区</div>
      {items.map((item) => (
        <NavButton key={item.key} item={item} active={activeView === item.key} onNavigate={onNavigate} />
      ))}
      <div className="ui-sidenav__group">资源</div>
      {resourceNav.map((item) => (
        <NavButton key={item.key} item={item} active={activeView === item.key} onNavigate={onNavigate} />
      ))}
      {activeView === 'sessions' && (
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
      )}
    </aside>
  )
}

function NavButton({
  item,
  active,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  onNavigate: (view: ViewKey) => void
}) {
  return (
    <button
      type="button"
      className={`ui-nav-item${active ? ' ui-nav-item--active' : ''}`}
      onClick={() => onNavigate(item.key)}
    >
      {item.icon}
      <span className="ui-nav-item__label">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 && (
        <span className="ui-nav-item__badge">{item.badge}</span>
      )}
    </button>
  )
}

function BookIcon() {
  return (
    <svg className="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function TopologyIcon() {
  return (
    <svg className="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </svg>
  )
}

function SkillsIcon() {
  return (
    <svg className="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="ui-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
