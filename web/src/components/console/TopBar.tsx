import type { ReactNode } from 'react'
import { Button } from '../ui/Button.js'
import './topbar.css'

interface TopBarProps {
  connected: boolean
  pendingApprovals: number
  activeAlerts: number
  onNewSession: () => void
  userMenu?: ReactNode
}

export function TopBar({ connected, pendingApprovals, activeAlerts, onNewSession, userMenu }: TopBarProps) {
  return (
    <header className="ui-topbar">
      <div className="ui-topbar__brand">
        <div className="ui-topbar__logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
        <span className="ui-topbar__name">InfraPilot</span>
        <span className="ui-topbar__sub">AI SRE 智能运维</span>
      </div>
      <div className="ui-topbar__actions">
        <span className={`ui-pill${connected ? ' ui-pill--ok' : ' ui-pill--muted'}`}>
          <span className="ui-pill__dot" />
          {connected ? '实时连接' : '未连接'}
        </span>
        {pendingApprovals > 0 && (
          <span className="ui-pill ui-pill--warn">
            <span className="ui-pill__dot" />
            {pendingApprovals} 待审批
          </span>
        )}
        {activeAlerts > 0 && (
          <span className="ui-pill ui-pill--danger">
            <span className="ui-pill__dot" />
            {activeAlerts} 活跃告警
          </span>
        )}
        <Button variant="primary" onClick={onNewSession}>
          + 新建会话
        </Button>
        {userMenu}
      </div>
    </header>
  )
}
