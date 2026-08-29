# InfraPilot 前端改版 M2（布局骨架）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 InfraPilot 前端从"聊天工具"骨架升级为专业控制台布局：TopBar（全局状态）、SideNav（一级导航 + 会话列表）、Workspace（工作台）、RightPanel（调查面板三 Tab + 折叠），并落地告警中心静态页。

**Architecture:** 在 M1 组件库（Button/Badge/Tabs/tokens）之上新增 `components/console/`（布局骨架）和 `components/alerts/`（告警中心），全部采用 TDD；最后一步把 `App.tsx` 的渲染树切换到新布局，保留全部现有会话/聊天/审批逻辑与后端调用。`App.tsx` 只改"壳"，不改数据流。

**Tech Stack:** React 19 + Vite 8 + TypeScript（`verbatimModuleSyntax`、`noUnusedLocals`）；Vitest + Testing Library + jsdom；Storybook（react-vite）；设计 token（M1 的 `tokens.css`）。

**前置依赖：** 本计划依赖 M1 已完成（`ui/Button`、`ui/Badge`、`ui/Tabs`、`tokens.css`、Vitest/Storybook 基建）。若 M1 未完成，先完成 M1。

**执行前注意：**
- 工作目录为 `web/`，所有命令在 `web/` 下执行。
- 建议在 `feature/frontend-redesign-m1` 分支（或其后继分支）上继续实施。
- 与 M0 原型的一处差异（有意保留）：会话列表暂保留在左栏导航下方，以保留现有会话管理（搜索/重命名/删除）功能；后续里程碑再评估移入工作台视图。

---

### Task 1: TopBar 组件（TDD）

**Files:**
- Create: `web/src/lib/view.ts`
- Test: `web/src/components/console/TopBar.test.tsx`
- Create: `web/src/components/console/TopBar.tsx`
- Create: `web/src/components/console/topbar.css`
- Create: `web/src/components/console/TopBar.stories.tsx`

- [ ] **Step 1: 创建共享视图类型**

Create `web/src/lib/view.ts`:

```ts
export type ViewKey = 'alerts' | 'sessions' | 'knowledge' | 'topology' | 'settings' | 'skills'
```

- [ ] **Step 2: 写失败测试**

Create `web/src/components/console/TopBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TopBar } from './TopBar.js'

describe('TopBar', () => {
  it('renders brand, connection and count pills', () => {
    render(<TopBar connected pendingApprovals={2} activeAlerts={3} onNewSession={() => {}} />)
    expect(screen.getByText('InfraPilot')).toBeInTheDocument()
    expect(screen.getByText('实时连接')).toBeInTheDocument()
    expect(screen.getByText('2 待审批')).toBeInTheDocument()
    expect(screen.getByText('3 活跃告警')).toBeInTheDocument()
  })

  it('hides zero-count pills and shows offline state', () => {
    render(<TopBar connected={false} pendingApprovals={0} activeAlerts={0} onNewSession={() => {}} />)
    expect(screen.getByText('未连接')).toBeInTheDocument()
    expect(screen.queryByText(/待审批/)).not.toBeInTheDocument()
    expect(screen.queryByText(/活跃告警/)).not.toBeInTheDocument()
  })

  it('fires onNewSession', async () => {
    const onNewSession = vi.fn()
    const user = userEvent.setup()
    render(<TopBar connected pendingApprovals={0} activeAlerts={0} onNewSession={onNewSession} />)
    await user.click(screen.getByRole('button', { name: /新建会话/ }))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/components/console/TopBar.test.tsx`

Expected: FAIL，错误为 `Cannot find module './TopBar.js'`。

- [ ] **Step 4: 实现 TopBar**

Create `web/src/components/console/TopBar.tsx`:

```tsx
import { Button } from '../ui/Button.js'
import './topbar.css'

interface TopBarProps {
  connected: boolean
  pendingApprovals: number
  activeAlerts: number
  onNewSession: () => void
}

export function TopBar({ connected, pendingApprovals, activeAlerts, onNewSession }: TopBarProps) {
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
      </div>
    </header>
  )
}
```

Create `web/src/components/console/topbar.css`:

```css
.ui-topbar {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 0 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.ui-topbar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ui-topbar__logo {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ui-topbar__name {
  font-size: 16px;
  font-weight: 600;
}
.ui-topbar__sub {
  font-size: 12px;
  color: var(--text-3);
}
.ui-topbar__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ui-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 12.5px;
}
.ui-pill__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
}
.ui-pill--muted .ui-pill__dot {
  background: var(--text-3);
}
.ui-pill--warn {
  color: var(--warn);
  border-color: #f3dfc1;
}
.ui-pill--warn .ui-pill__dot {
  background: var(--warn);
}
.ui-pill--danger {
  color: var(--danger);
  border-color: #f3cdcd;
}
.ui-pill--danger .ui-pill__dot {
  background: var(--danger);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/components/console/TopBar.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 6: 创建 Story**

Create `web/src/components/console/TopBar.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { TopBar } from './TopBar.js'

const meta: Meta<typeof TopBar> = {
  title: 'console/TopBar',
  component: TopBar,
}
export default meta
type Story = StoryObj<typeof TopBar>

export const Default: Story = {
  args: { connected: true, pendingApprovals: 2, activeAlerts: 3 },
}
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/view.ts src/components/console/TopBar.tsx src/components/console/topbar.css src/components/console/TopBar.test.tsx src/components/console/TopBar.stories.tsx
git commit -m "feat(web): add console TopBar with global status pills"
```

---

### Task 2: 时间格式化工具 + SessionList 组件（TDD）

**Files:**
- Create: `web/src/lib/format.ts`
- Test: `web/src/components/console/SessionList.test.tsx`
- Create: `web/src/components/console/SessionList.tsx`
- Create: `web/src/components/console/session-list.css`

- [ ] **Step 1: 创建共享时间格式化工具**

Create `web/src/lib/format.ts`:

```ts
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}
```

- [ ] **Step 2: 写失败测试**

Create `web/src/components/console/SessionList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionList } from './SessionList.js'
import type { AgentSession } from '../../lib/types.js'

const makeSession = (over: Partial<AgentSession>): AgentSession => ({
  id: 's1',
  title: 'order-api 排查',
  status: 'concluded',
  createdAt: '2026-08-25T10:00:00Z',
  updatedAt: '2026-08-25T10:30:00Z',
  incidentSummary: '',
  plan: [],
  evidence: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 3,
  maxIterations: 20,
  ...over,
})

describe('SessionList', () => {
  it('renders active and closed groups', () => {
    render(
      <SessionList
        activeSessions={[makeSession({})]}
        closedSessions={[makeSession({ id: 's2', status: 'closed' })]}
        currentId="s1"
        search=""
        onSearch={() => {}}
        onSelect={() => {}}
        onDelete={() => {}}
        onTitleSave={() => {}}
      />,
    )
    expect(screen.getByText('order-api 排查')).toBeInTheDocument()
    expect(screen.getByText(/进行中 \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/历史会话 \(1\)/)).toBeInTheDocument()
  })

  it('selects and deletes a session', async () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const user = userEvent.setup()
    render(
      <SessionList
        activeSessions={[makeSession({})]}
        closedSessions={[]}
        currentId={null}
        search=""
        onSearch={() => {}}
        onSelect={onSelect}
        onDelete={onDelete}
        onTitleSave={() => {}}
      />,
    )
    await user.click(screen.getByText('order-api 排查'))
    expect(onSelect).toHaveBeenCalledWith('s1')
    await user.click(screen.getByTitle('删除会话'))
    expect(onDelete).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/components/console/SessionList.test.tsx`

Expected: FAIL，错误为 `Cannot find module './SessionList.js'`。

- [ ] **Step 4: 实现 SessionList**

Create `web/src/components/console/SessionList.tsx`:

```tsx
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
```

Create `web/src/components/console/session-list.css`:

```css
.ui-session-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.ui-session-list__search {
  padding: 10px 10px 6px;
}
.ui-session-list__search-input {
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font-size: 12.5px;
  font-family: var(--font-sans);
  outline: none;
}
.ui-session-list__search-input:focus {
  border-color: var(--accent);
}
.ui-session-list__content {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
}
.ui-session-list__group-title {
  font-size: 11px;
  color: var(--text-3);
  padding: 10px 4px 6px;
  letter-spacing: 0.4px;
}
.ui-session-list__empty {
  font-size: 12px;
  color: var(--text-3);
  padding: 6px 4px;
}
.ui-session-item {
  border-radius: var(--radius-sm);
  padding: 7px 8px;
  margin-bottom: 2px;
  cursor: pointer;
  border: 1px solid transparent;
}
.ui-session-item:hover {
  background: var(--bg);
}
.ui-session-item--active {
  background: var(--accent-soft);
  border-color: transparent;
}
.ui-session-item__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ui-session-item__title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-session-item__input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  font-size: 13px;
  font-family: var(--font-sans);
  outline: none;
}
.ui-session-item__close {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.ui-session-item__close:hover {
  color: var(--danger);
}
.ui-session-item__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
}
.ui-session-item__id {
  font-family: var(--font-mono);
}
.ui-session-item__time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.ui-status {
  font-size: 11px;
  font-weight: 500;
}
.status--intake,
.status--planning {
  color: var(--info);
}
.status--executing {
  color: var(--warn);
}
.status--warning {
  color: var(--danger);
}
.status--success {
  color: var(--success);
}
.status--closed {
  color: var(--text-3);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/components/console/SessionList.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.ts src/components/console/SessionList.tsx src/components/console/session-list.css src/components/console/SessionList.test.tsx
git commit -m "feat(web): add SessionList console component"
```

---

### Task 3: SideNav 组件（TDD）

**Files:**
- Test: `web/src/components/console/SideNav.test.tsx`
- Create: `web/src/components/console/SideNav.tsx`
- Create: `web/src/components/console/sidenav.css`
- Create: `web/src/components/console/SideNav.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/console/SideNav.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SideNav } from './SideNav.js'

const baseProps = {
  activeView: 'alerts' as const,
  alertCount: 3,
  onNavigate: () => {},
  activeSessions: [],
  closedSessions: [],
  currentId: null,
  search: '',
  onSearch: () => {},
  onSelect: () => {},
  onDelete: () => {},
  onTitleSave: () => {},
}

describe('SideNav', () => {
  it('renders nav items with alert count badge', () => {
    render(<SideNav {...baseProps} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('会话中心')).toBeInTheDocument()
    expect(screen.getByText('知识库')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('marks active view and navigates on click', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<SideNav {...baseProps} activeView="sessions" onNavigate={onNavigate} />)
    expect(screen.getByText('会话中心').parentElement?.className).toContain('active')
    await user.click(screen.getByText('知识库'))
    expect(onNavigate).toHaveBeenCalledWith('knowledge')
  })

  it('shows session list when sessions view is active', () => {
    render(<SideNav {...baseProps} activeView="sessions" />)
    expect(screen.getByPlaceholderText('搜索会话...')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/console/SideNav.test.tsx`

Expected: FAIL，错误为 `Cannot find module './SideNav.js'`。

- [ ] **Step 3: 实现 SideNav**

Create `web/src/components/console/SideNav.tsx`:

```tsx
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
```

Create `web/src/components/console/sidenav.css`:

```css
.ui-sidenav {
  width: 224px;
  flex: 0 0 224px;
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 14px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.ui-sidenav__group {
  font-size: 11px;
  color: var(--text-3);
  padding: 12px 10px 6px;
  letter-spacing: 0.4px;
}
.ui-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 13.5px;
  font-family: var(--font-sans);
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease, color 0.12s ease;
}
.ui-nav-item:hover {
  background: var(--bg);
  color: var(--text);
}
.ui-nav-item--active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.ui-nav-icon {
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
}
.ui-nav-item__label {
  flex: 1;
}
.ui-nav-item__badge {
  font-size: 11.5px;
  background: var(--bg);
  color: var(--text-3);
  border-radius: 999px;
  padding: 1px 7px;
}
.ui-nav-item--active .ui-nav-item__badge {
  background: var(--accent);
  color: #fff;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/console/SideNav.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/console/SideNav.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SideNav } from './SideNav.js'

const meta: Meta<typeof SideNav> = {
  title: 'console/SideNav',
  component: SideNav,
}
export default meta
type Story = StoryObj<typeof SideNav>

export const Default: Story = {
  args: {
    activeView: 'sessions',
    alertCount: 3,
    activeSessions: [],
    closedSessions: [],
    currentId: null,
    search: '',
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/console/SideNav.tsx src/components/console/sidenav.css src/components/console/SideNav.test.tsx src/components/console/SideNav.stories.tsx
git commit -m "feat(web): add console SideNav with session list"
```

---

### Task 4: RightPanel 组件（TDD）

**Files:**
- Test: `web/src/components/console/RightPanel.test.tsx`
- Create: `web/src/components/console/RightPanel.tsx`
- Create: `web/src/components/console/right-panel.css`
- Create: `web/src/components/console/RightPanel.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/console/RightPanel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RightPanel } from './RightPanel.js'

describe('RightPanel', () => {
  it('switches tabs and shows the active panel', async () => {
    const user = userEvent.setup()
    render(
      <RightPanel
        process={<p>过程内容</p>}
        evidence={<p>证据内容</p>}
        object={<p>对象内容</p>}
      />,
    )
    expect(screen.getByText('过程内容')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '证据链' }))
    expect(screen.getByText('证据内容')).toBeInTheDocument()
    expect(screen.queryByText('过程内容')).not.toBeInTheDocument()
  })

  it('collapses and expands the panel', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RightPanel process={<p>p</p>} evidence={<p>e</p>} object={<p>o</p>} />,
    )
    const aside = container.querySelector('aside')
    expect(aside?.className).not.toContain('ui-right-panel--collapsed')
    await user.click(screen.getByTitle('折叠右栏'))
    expect(aside?.className).toContain('ui-right-panel--collapsed')
    await user.click(screen.getByTitle('展开右栏'))
    expect(aside?.className).not.toContain('ui-right-panel--collapsed')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/console/RightPanel.test.tsx`

Expected: FAIL，错误为 `Cannot find module './RightPanel.js'`。

- [ ] **Step 3: 实现 RightPanel**

Create `web/src/components/console/RightPanel.tsx`:

```tsx
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tabs } from '../ui/Tabs.js'
import './right-panel.css'

type PanelTab = 'process' | 'evidence' | 'object'

const tabs: { key: PanelTab; label: string }[] = [
  { key: 'process', label: '调查过程' },
  { key: 'evidence', label: '证据链' },
  { key: 'object', label: '对象上下文' },
]

interface RightPanelProps {
  process: ReactNode
  evidence: ReactNode
  object: ReactNode
}

export function RightPanel({ process, evidence, object }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('process')
  const [collapsed, setCollapsed] = useState(false)
  const content: Record<PanelTab, ReactNode> = { process, evidence, object }

  return (
    <aside className={`ui-right-panel${collapsed ? ' ui-right-panel--collapsed' : ''}`}>
      <div className="ui-right-panel__head">
        <Tabs items={tabs} activeKey={activeTab} onChange={(key) => setActiveTab(key as PanelTab)} />
        <button
          type="button"
          className="ui-right-panel__collapse"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? '展开右栏' : '折叠右栏'}
        >
          {collapsed ? '«' : '»'}
        </button>
      </div>
      <div className="ui-right-panel__body">{content[activeTab]}</div>
    </aside>
  )
}
```

Create `web/src/components/console/right-panel.css`:

```css
.ui-right-panel {
  width: 356px;
  flex: 0 0 356px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  transition: margin-right 0.18s ease;
  min-height: 0;
}
.ui-right-panel--collapsed {
  margin-right: -356px;
}
.ui-right-panel__head {
  height: 46px;
  flex: 0 0 46px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
}
.ui-right-panel__collapse {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 14px;
}
.ui-right-panel__collapse:hover {
  background: var(--bg);
  color: var(--text-2);
}
.ui-right-panel__body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/console/RightPanel.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/console/RightPanel.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { RightPanel } from './RightPanel.js'

const meta: Meta<typeof RightPanel> = {
  title: 'console/RightPanel',
  component: RightPanel,
}
export default meta
type Story = StoryObj<typeof RightPanel>

export const Default: Story = {
  args: {
    process: <p style={{ color: 'var(--text-2)' }}>调查过程（M3/M7 接入）</p>,
    evidence: <p style={{ color: 'var(--text-2)' }}>证据链（M3 接入）</p>,
    object: <p style={{ color: 'var(--text-2)' }}>对象上下文（M5/M6 接入）</p>,
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/console/RightPanel.tsx src/components/console/right-panel.css src/components/console/RightPanel.test.tsx src/components/console/RightPanel.stories.tsx
git commit -m "feat(web): add collapsible RightPanel with investigation tabs"
```

---

### Task 5: HealthGrid 组件（TDD）

**Files:**
- Test: `web/src/components/alerts/HealthGrid.test.tsx`
- Create: `web/src/components/alerts/HealthGrid.tsx`
- Create: `web/src/components/alerts/health-grid.css`
- Create: `web/src/components/alerts/HealthGrid.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/alerts/HealthGrid.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HealthGrid } from './HealthGrid.js'

const services = [
  { name: 'order-api', meta: 'order-service · 3 副本', status: 'err' as const, metricLabel: '内存占用', metricValue: '98%', chart: [10, 12, 15, 22, 30] },
  { name: 'gateway', meta: 'edge · 2 副本', status: 'ok' as const, metricLabel: '请求延迟 p99', metricValue: '42ms', chart: [20, 18, 21, 19, 20] },
]

describe('HealthGrid', () => {
  it('renders service cards with status and metrics', () => {
    render(<HealthGrid services={services} />)
    expect(screen.getByText('order-api')).toBeInTheDocument()
    expect(screen.getByText('order-service · 3 副本')).toBeInTheDocument()
    expect(screen.getByText('98%')).toBeInTheDocument()
    expect(screen.getByText('order-api').parentElement?.querySelector('.status-dot--err')).not.toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/alerts/HealthGrid.test.tsx`

Expected: FAIL，错误为 `Cannot find module './HealthGrid.js'`。

- [ ] **Step 3: 实现 HealthGrid**

Create `web/src/components/alerts/HealthGrid.tsx`:

```tsx
import './health-grid.css'

export type ServiceStatus = 'ok' | 'warn' | 'err'

export interface ServiceHealth {
  name: string
  meta: string
  status: ServiceStatus
  metricLabel: string
  metricValue: string
  chart: number[]
}

interface HealthGridProps {
  services: ServiceHealth[]
}

export function HealthGrid({ services }: HealthGridProps) {
  return (
    <div className="health-grid">
      {services.map((service) => (
        <div key={service.name} className={`health-card${service.status !== 'ok' ? ' health-card--alert' : ''}`}>
          <div className="health-card__head">
            <span className={`status-dot status-dot--${service.status}`} />
            <span className="health-card__name">{service.name}</span>
          </div>
          <div className="health-card__meta">{service.meta}</div>
          <div className="health-card__chart">
            <Sparkline values={service.chart} status={service.status} />
          </div>
          <div className="health-card__stat">
            <span>{service.metricLabel}</span>
            <b>{service.metricValue}</b>
          </div>
        </div>
      ))}
    </div>
  )
}

function Sparkline({ values, status }: { values: number[]; status: ServiceStatus }) {
  const points = sparklinePoints(values)
  return (
    <svg viewBox="0 0 200 34" preserveAspectRatio="none">
      {points && <polyline points={points} className={`sparkline sparkline--${status}`} />}
    </svg>
  )
}

function sparklinePoints(values: number[]): string {
  if (values.length < 2) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 200
      const y = 34 - ((value - min) / span) * 30 - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
```

Create `web/src/components/alerts/health-grid.css`:

```css
.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}
.health-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.health-card--alert {
  border-color: #f3cdcd;
}
.health-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.health-card__name {
  font-size: 14px;
  font-weight: 600;
}
.health-card__meta {
  font-size: 12px;
  color: var(--text-3);
}
.health-card__chart {
  height: 34px;
  margin-top: 2px;
}
.health-card__chart svg {
  width: 100%;
  height: 100%;
  display: block;
}
.sparkline {
  fill: none;
  stroke: var(--success);
  stroke-width: 1.6;
}
.sparkline--warn {
  stroke: var(--warn);
}
.sparkline--err {
  stroke: var(--danger);
}
.health-card__stat {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
}
.health-card__stat b {
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
}
.status-dot--ok {
  background: var(--success);
}
.status-dot--warn {
  background: var(--warn);
}
.status-dot--err {
  background: var(--danger);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/alerts/HealthGrid.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/alerts/HealthGrid.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { HealthGrid } from './HealthGrid.js'

const meta: Meta<typeof HealthGrid> = {
  title: 'alerts/HealthGrid',
  component: HealthGrid,
}
export default meta
type Story = StoryObj<typeof HealthGrid>

export const Default: Story = {
  args: {
    services: [
      { name: 'order-api', meta: 'order-service · 3 副本', status: 'err', metricLabel: '内存占用', metricValue: '98%', chart: [10, 12, 15, 22, 30] },
      { name: 'gateway', meta: 'edge · 2 副本', status: 'ok', metricLabel: '请求延迟 p99', metricValue: '42ms', chart: [20, 18, 21, 19, 20] },
      { name: 'payment-service', meta: 'pay · 2 副本', status: 'warn', metricLabel: '5xx 比例', metricValue: '1.8%', chart: [12, 14, 16, 20, 24] },
    ],
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/alerts/HealthGrid.tsx src/components/alerts/health-grid.css src/components/alerts/HealthGrid.test.tsx src/components/alerts/HealthGrid.stories.tsx
git commit -m "feat(web): add alert center HealthGrid"
```

---

### Task 6: AlertList 组件（TDD）

**Files:**
- Test: `web/src/components/alerts/AlertList.test.tsx`
- Create: `web/src/components/alerts/AlertList.tsx`
- Create: `web/src/components/alerts/alert-list.css`
- Create: `web/src/components/alerts/AlertList.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/alerts/AlertList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertList } from './AlertList.js'

const alerts = [
  {
    id: 'a1',
    severity: 'p0' as const,
    title: 'order-api Pod CrashLoopBackOff',
    source: 'order-service/order-api · Prometheus',
    startedAt: '2026-08-25T10:24:00Z',
    status: 'firing' as const,
  },
]

describe('AlertList', () => {
  it('renders alert rows and fires investigate', async () => {
    const onInvestigate = vi.fn()
    const user = userEvent.setup()
    render(<AlertList alerts={alerts} onInvestigate={onInvestigate} />)
    expect(screen.getByText('order-api Pod CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.getByText('P0 严重')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '一键开查' }))
    expect(onInvestigate).toHaveBeenCalledWith('a1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/alerts/AlertList.test.tsx`

Expected: FAIL，错误为 `Cannot find module './AlertList.js'`。

- [ ] **Step 3: 实现 AlertList**

Create `web/src/components/alerts/AlertList.tsx`:

```tsx
import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { formatTime } from '../../lib/format.js'
import './alert-list.css'

export type AlertSeverity = 'p0' | 'p1' | 'p2'
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged'

export interface AlertItem {
  id: string
  severity: AlertSeverity
  title: string
  source: string
  startedAt: string
  status: AlertStatus
}

interface AlertListProps {
  alerts: AlertItem[]
  onInvestigate: (id: string) => void
}

const severityMeta: Record<AlertSeverity, { label: string; tone: 'danger' | 'warn' | 'info' }> = {
  p0: { label: 'P0 严重', tone: 'danger' },
  p1: { label: 'P1 警告', tone: 'warn' },
  p2: { label: 'P2 提示', tone: 'info' },
}

const statusLabel: Record<AlertStatus, string> = {
  firing: '处理中',
  resolved: '已解决',
  acknowledged: '已确认',
}

export function AlertList({ alerts, onInvestigate }: AlertListProps) {
  return (
    <div className="alert-list">
      {alerts.map((alert) => {
        const severity = severityMeta[alert.severity]
        return (
          <div key={alert.id} className="alert-row">
            <Badge label={severity.label} tone={severity.tone} />
            <div className="alert-row__main">
              <div className="alert-row__title">{alert.title}</div>
              <div className="alert-row__source">{alert.source}</div>
            </div>
            <span className="alert-row__time">{formatTime(alert.startedAt)}</span>
            <Badge label={statusLabel[alert.status]} tone={alert.status === 'firing' ? severity.tone : 'neutral'} />
            <Button size="sm" onClick={() => onInvestigate(alert.id)}>
              一键开查
            </Button>
          </div>
        )
      })}
    </div>
  )
}
```

Create `web/src/components/alerts/alert-list.css`:

```css
.alert-list {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.alert-row {
  display: grid;
  grid-template-columns: 86px 1fr 150px 74px 84px;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.alert-row:last-child {
  border-bottom: none;
}
.alert-row:hover {
  background: #fafbfc;
}
.alert-row__title {
  font-weight: 600;
}
.alert-row__source {
  color: var(--text-3);
  font-size: 12px;
  margin-top: 1px;
}
.alert-row__time {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/alerts/AlertList.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/alerts/AlertList.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { AlertList } from './AlertList.js'

const meta: Meta<typeof AlertList> = {
  title: 'alerts/AlertList',
  component: AlertList,
}
export default meta
type Story = StoryObj<typeof AlertList>

export const Default: Story = {
  args: {
    alerts: [
      { id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', startedAt: '2026-08-25T10:24:00Z', status: 'firing' },
      { id: 'a2', severity: 'p1', title: 'payment-service 5xx 上升', source: 'pay/payment-service · Prometheus', startedAt: '2026-08-25T10:02:00Z', status: 'firing' },
      { id: 'a3', severity: 'p2', title: 'node-08 磁盘使用率 > 80%', source: 'k8s-node · node_exporter', startedAt: '2026-08-25T09:41:00Z', status: 'acknowledged' },
    ],
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/alerts/AlertList.tsx src/components/alerts/alert-list.css src/components/alerts/AlertList.test.tsx src/components/alerts/AlertList.stories.tsx
git commit -m "feat(web): add alert center AlertList"
```

---

### Task 7: AlertCenter 页面（静态数据）

**Files:**
- Test: `web/src/components/alerts/AlertCenter.test.tsx`
- Create: `web/src/components/alerts/AlertCenter.tsx`
- Create: `web/src/components/alerts/alert-center.css`
- Create: `web/src/components/alerts/AlertCenter.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/alerts/AlertCenter.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertCenter } from './AlertCenter.js'

describe('AlertCenter', () => {
  it('renders health grid, alerts and quick entries', () => {
    render(<AlertCenter onInvestigate={() => {}} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('服务健康')).toBeInTheDocument()
    expect(screen.getByText('最近告警')).toBeInTheDocument()
    expect(screen.getByText('快捷入口')).toBeInTheDocument()
  })

  it('fires investigate from alert rows', async () => {
    const onInvestigate = vi.fn()
    const user = userEvent.setup()
    render(<AlertCenter onInvestigate={onInvestigate} />)
    await user.click(screen.getAllByRole('button', { name: '一键开查' })[0])
    expect(onInvestigate).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/alerts/AlertCenter.test.tsx`

Expected: FAIL，错误为 `Cannot find module './AlertCenter.js'`。

- [ ] **Step 3: 实现 AlertCenter**

Create `web/src/components/alerts/AlertCenter.tsx`:

```tsx
import { HealthGrid } from './HealthGrid.js'
import { AlertList } from './AlertList.js'
import './alert-center.css'

const demoServices = [
  { name: 'order-api', meta: 'order-service · 3 副本', status: 'err' as const, metricLabel: '内存占用', metricValue: '98%', chart: [10, 12, 15, 22, 30] },
  { name: 'gateway', meta: 'edge · 2 副本', status: 'ok' as const, metricLabel: '请求延迟 p99', metricValue: '42ms', chart: [20, 18, 21, 19, 20] },
  { name: 'payment-service', meta: 'pay · 2 副本', status: 'warn' as const, metricLabel: '5xx 比例', metricValue: '1.8%', chart: [12, 14, 16, 20, 24] },
  { name: 'auth-service', meta: 'iam · 2 副本', status: 'ok' as const, metricLabel: 'QPS', metricValue: '1.2k', chart: [15, 16, 15, 17, 16] },
]

const demoAlerts = [
  { id: 'a1', severity: 'p0' as const, title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', startedAt: '2026-08-25T10:24:00Z', status: 'firing' as const },
  { id: 'a2', severity: 'p1' as const, title: 'payment-service 5xx 上升', source: 'pay/payment-service · Prometheus', startedAt: '2026-08-25T10:02:00Z', status: 'firing' as const },
  { id: 'a3', severity: 'p2' as const, title: 'node-08 磁盘使用率 > 80%', source: 'k8s-node · node_exporter', startedAt: '2026-08-25T09:41:00Z', status: 'acknowledged' as const },
]

interface AlertCenterProps {
  onInvestigate: (id: string) => void
}

export function AlertCenter({ onInvestigate }: AlertCenterProps) {
  return (
    <div className="alert-center">
      <header className="alert-center__head">
        <h1>告警中心</h1>
        <p>服务健康总览与待处理告警</p>
      </header>
      <section className="alert-center__section">
        <h2>服务健康</h2>
        <HealthGrid services={demoServices} />
      </section>
      <section className="alert-center__section">
        <h2>最近告警</h2>
        <AlertList alerts={demoAlerts} onInvestigate={onInvestigate} />
      </section>
      <section className="alert-center__section">
        <h2>快捷入口</h2>
        <div className="quick-row">
          <div className="quick-card"><b>排查 Pod 异常</b><span>输入故障现象，Agent 自动诊断</span></div>
          <div className="quick-card"><b>查询日志</b><span>按服务/关键字检索 ELK 日志</span></div>
          <div className="quick-card"><b>查看告警</b><span>进入告警中心处理待办</span></div>
        </div>
      </section>
    </div>
  )
}
```

Create `web/src/components/alerts/alert-center.css`:

```css
.alert-center {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
}
.alert-center__head h1 {
  font-size: 20px;
  font-weight: 600;
}
.alert-center__head p {
  color: var(--text-3);
  font-size: 13px;
  margin-top: 3px;
}
.alert-center__section {
  margin-top: 26px;
}
.alert-center__section h2 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}
.quick-row {
  display: flex;
  gap: 12px;
}
.quick-card {
  flex: 1;
  max-width: 300px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
}
.quick-card b {
  display: block;
  font-size: 13.5px;
  margin-bottom: 3px;
}
.quick-card span {
  font-size: 12px;
  color: var(--text-3);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/alerts/AlertCenter.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/alerts/AlertCenter.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { AlertCenter } from './AlertCenter.js'

const meta: Meta<typeof AlertCenter> = {
  title: 'alerts/AlertCenter',
  component: AlertCenter,
}
export default meta
type Story = StoryObj<typeof AlertCenter>

export const Default: Story = {
  args: { onInvestigate: (id: string) => console.log('investigate', id) },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/alerts/AlertCenter.tsx src/components/alerts/alert-center.css src/components/alerts/AlertCenter.test.tsx src/components/alerts/AlertCenter.stories.tsx
git commit -m "feat(web): add alert center page with static demo data"
```

---

### Task 8: Workspace 容器组件（TDD）

**Files:**
- Test: `web/src/components/console/Workspace.test.tsx`
- Create: `web/src/components/console/Workspace.tsx`
- Create: `web/src/components/console/workspace.css`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/console/Workspace.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Workspace } from './Workspace.js'

describe('Workspace', () => {
  it('renders children in workspace container', () => {
    render(<Workspace>内容</Workspace>)
    expect(screen.getByText('内容')).toBeInTheDocument()
    expect(screen.getByText('内容').parentElement?.className).toContain('ui-workspace')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/console/Workspace.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Workspace.js'`。

- [ ] **Step 3: 实现 Workspace**

Create `web/src/components/console/Workspace.tsx`:

```tsx
import type { ReactNode } from 'react'
import './workspace.css'

export function Workspace({ children }: { children: ReactNode }) {
  return <div className="ui-workspace">{children}</div>
}
```

Create `web/src/components/console/workspace.css`:

```css
.ui-workspace {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/console/Workspace.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/console/Workspace.tsx src/components/console/workspace.css src/components/console/Workspace.test.tsx
git commit -m "feat(web): add Workspace container"
```

---

### Task 9: App.tsx 接线（切换到新布局）

**Files:**
- Modify: `web/src/App.tsx`
  - 第 1-24 行：新增组件 import
  - 第 29 行：删除本地 `type View`，改用 `ViewKey`
  - 第 32-51 行：删除 `statusText` / `statusClass` 常量
  - 第 71 行：`useState<View>("sessions")` → `useState<ViewKey>("alerts")`
  - 第 204-300 行：替换整个 return JSX
  - 第 301-487 行：删除旧的 `TopBar` / `Sidebar` / `SessionItem` 函数

- [ ] **Step 1: 新增 import 与视图类型**

在 `web/src/App.tsx` 顶部（现有 `./styles/app.css` import 之后）新增：

```tsx
import { TopBar } from './components/console/TopBar.js'
import { SideNav } from './components/console/SideNav.js'
import { Workspace } from './components/console/Workspace.js'
import { RightPanel } from './components/console/RightPanel.js'
import { AlertCenter } from './components/alerts/AlertCenter.js'
import type { ViewKey } from './lib/view.js'
```

删除第 29 行的 `type View = "sessions" | ...`。

- [ ] **Step 2: 删除旧状态常量**

删除 `statusText`（32-42 行）与 `statusClass`（43-51 行）两个常量。它们只被旧 `SessionItem` 使用，新组件 `SessionList` 已自带副本。

- [ ] **Step 3: 修改初始视图与派生状态**

第 71 行改为：

```tsx
  const [currentView, setCurrentView] = useState<ViewKey>('alerts')
```

在 `filteredSessions` 定义之后（原约 190 行处）新增：

```tsx
  const pendingApprovals = sessions.reduce((count, session) => count + session.pendingToolCalls.length, 0)
  // M2 静态占位；M5 接入 /api/alerts 后替换
  const activeAlerts = 3

  const handleInvestigateAlert = (_alertId: string) => {
    setCurrentView('sessions')
    if (!currentId) handleCreate()
  }
```

- [ ] **Step 4: 替换 return JSX（204-300 行）**

将整个 `return (...)`（从 `<div className="app">` 到 `</div>\n  );`）替换为：

```tsx
  return (
    <div className="app">
      <TopBar
        connected={connected}
        pendingApprovals={pendingApprovals}
        activeAlerts={activeAlerts}
        onNewSession={() => {
          setCurrentView('sessions')
          handleCreate()
        }}
      />
      <div className="app__body">
        <SideNav
          activeView={currentView}
          alertCount={activeAlerts}
          onNavigate={setCurrentView}
          activeSessions={activeSessions}
          closedSessions={closedSessions}
          currentId={currentId}
          search={search}
          onSearch={setSearch}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onTitleSave={handleTitleSave}
        />
        <Workspace>
          {currentView === 'alerts' && <AlertCenter onInvestigate={handleInvestigateAlert} />}
          {currentView === 'sessions' &&
            (currentSession ? (
              <>
                <SessionHeader session={currentSession} onTitleSave={handleTitleSave} onDelete={handleDelete} />
                <div className="main__tabs">
                  {[
                    { key: 'timeline', label: '时间线' },
                    { key: 'evidence', label: '证据链' },
                    { key: 'plan', label: '诊断计划' },
                    { key: 'remediation', label: '修复方案' },
                    { key: 'audit', label: '审计日志' },
                  ].map((t) => (
                    <button
                      key={t.key}
                      className={classNames('main__tab', mainTab === t.key && 'main__tab--active')}
                      onClick={() => setMainTab(t.key as MainTab)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="main__content">
                  {mainTab === 'timeline' ? (
                    <ChatArea
                      events={events}
                      loading={loading && events.length === 0}
                      onApprove={handleApprove}
                      chatEndRef={chatEndRef}
                    />
                  ) : (
                    <SessionDetailTabs
                      session={currentSession}
                      tab={mainTab as DetailTab}
                      onTabChange={(t) => setMainTab(t)}
                    />
                  )}
                </div>
                {mainTab === 'timeline' && (
                  <div className="composer">
                    <input
                      className="composer__input"
                      placeholder="描述故障现象或输入指令，例如：order-api Pod 反复重启..."
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                      disabled={loading}
                    />
                    <button className="composer__send" onClick={handleSend} disabled={!input.trim() || loading}>
                      发送
                    </button>
                  </div>
                )}
              </>
            ) : (
              <EmptyWorkspace onNewSession={handleCreate} />
            ))}
          {currentView === 'knowledge' && <KnowledgePage notify={notify} />}
          {currentView === 'topology' && <TopologyPage />}
          {currentView === 'settings' && <SettingsPage notify={notify} />}
          {currentView === 'skills' && <SkillsPage notify={notify} />}
        </Workspace>
        {currentView === 'sessions' && currentSession && (
          <RightPanel
            process={<p className="ui-rp-placeholder">调查过程：M3 接入工具记录，M7 接入推理树</p>}
            evidence={<p className="ui-rp-placeholder">证据链：{currentSession.evidence.length} 条证据（M3 渲染列表）</p>}
            object={<ContextPanel />}
          />
        )}
      </div>
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
```

注意：`ContextPanel` 在 M2 阶段嵌入"对象上下文"Tab，保留现有 Pod 实时信息；M5/M6 由丰富版 `ObjectContext` 替换。

- [ ] **Step 5: 删除旧布局函数**

删除 `web/src/App.tsx` 中的三个函数定义：
- `function TopBar(...)`（原 301-325 行）
- `function Sidebar(...)`（原 326-423 行）
- `function SessionItem(...)`（原 424-487 行）

删除后运行：

```bash
rg -n "TopBar|Sidebar|SessionItem|statusText|statusClass" src/App.tsx
```

Expected: 除新 import 的 `TopBar` / `SideNav` 使用处外，无残留引用（`TopBar` 仅在 JSX 中使用 1 次，`statusText`/`statusClass` 无输出）。

- [ ] **Step 6: 构建验证**

Run: `npm run build`

Expected: PASS（`tsc -b` 无未使用变量/类型错误）。

- [ ] **Step 7: 运行全部测试**

Run: `npm test`

Expected: PASS（M1 组件 + M2 新组件全部通过）。

- [ ] **Step 8: 手动回归检查清单**

启动 `npm run dev` 后逐项确认：
- [ ] 默认进入告警中心，健康卡片与告警列表展示正常
- [ ] 点"一键开查"切到会话中心并新建会话
- [ ] 左侧"会话中心"下显示进行中/历史会话列表，搜索、双击重命名、删除可用
- [ ] 知识库/拓扑/技能/设置四个页面可正常切换
- [ ] 会话工作台：时间线/证据/计划/修复/审计 Tab 可切换，输入发送可用
- [ ] 右栏三 Tab 可切换，折叠/展开正常，对象上下文 Tab 显示 Pod 信息
- [ ] WebSocket 实时事件仍能追加到时间线
- [ ] 审批卡片批准/拒绝可用

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat(web): switch app shell to console layout"
```

---

### Task 10: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: 运行全部测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 2: 运行生产构建**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 3: 运行 Storybook 构建**

Run: `npm run build-storybook`

Expected: PASS，console/alerts 的 story 均可访问。

- [ ] **Step 4: 提交收尾**

如果 Step 1-3 有修复：

```bash
git add -A
git commit -m "fix(web): resolve M2 acceptance issues"
```

---

## M2 验收清单

- [ ] `npm test` 全部通过（M1 + M2 组件）
- [ ] `npm run build` 通过
- [ ] `npm run build-storybook` 通过
- [ ] 默认首屏为告警中心，导航切换正常
- [ ] 会话列表（搜索/重命名/删除）功能保留
- [ ] 右栏三 Tab + 折叠可用，对象上下文保留 Pod 实时信息
- [ ] 现有会话/聊天/审批/WebSocket 逻辑无回归
- [ ] 提交历史为 Task 1-10 的独立 conventional commits

## M2 完成后的下一步

M3（对话区重构：Kimi 式消息、过程小节折叠、Markdown 渲染接入会话流），随后 M4（结论卡片 + 证据角标回链）。
