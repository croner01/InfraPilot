import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tabs } from '../ui/Tabs.js'
import './right-panel.css'

export type PanelTab = 'track' | 'evidence' | 'audit' | 'plan' | 'remediation' | 'artifacts'

/** 顺序对齐 Cortex 原型：执行跟踪 → 证据 → 审计，其后是平台扩展（计划/修复/产物） */
const tabs: { key: PanelTab; label: string }[] = [
  { key: 'track', label: '跟踪' },
  { key: 'evidence', label: '证据' },
  { key: 'audit', label: '审计' },
  { key: 'plan', label: '计划' },
  { key: 'remediation', label: '修复' },
  { key: 'artifacts', label: '产物' },
]

interface RightPanelProps {
  /** 执行跟踪（里程碑 + 思考流 + 思考记录），默认 Tab */
  track: ReactNode
  evidence: ReactNode
  audit?: ReactNode
  plan?: ReactNode
  remediation?: ReactNode
  artifacts?: ReactNode
  /** 各 Tab 数量角标（如证据条数） */
  counts?: Partial<Record<PanelTab, number>>
  defaultTab?: PanelTab
  activeTab?: PanelTab
  onTabChange?: (tab: PanelTab) => void
  /** 受控折叠状态；不传时组件内部自管（兼容 stories/tests） */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function RightPanel({
  track,
  evidence,
  audit,
  plan,
  remediation,
  artifacts,
  counts,
  defaultTab = 'track',
  activeTab: controlledTab,
  onTabChange,
  collapsed: controlledCollapsed,
  onToggleCollapse,
}: RightPanelProps) {
  const [internalTab, setInternalTab] = useState<PanelTab>(defaultTab)
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const activeTab = controlledTab ?? internalTab
  const collapsed = controlledCollapsed ?? internalCollapsed

  const content: Record<PanelTab, ReactNode> = {
    track,
    evidence,
    audit: audit ?? null,
    plan: plan ?? null,
    remediation: remediation ?? null,
    artifacts: artifacts ?? null,
  }
  const visibleTabs = tabs
    .filter((t) => content[t.key] != null)
    .map((t) => ({ ...t, count: counts?.[t.key] }))

  const changeTab = (key: string) => {
    const tab = key as PanelTab
    if (onTabChange) {
      onTabChange(tab)
    } else {
      setInternalTab(tab)
    }
  }

  const toggleCollapse = () => {
    if (onToggleCollapse) onToggleCollapse()
    else setInternalCollapsed((value) => !value)
  }

  return (
    <aside className={`ui-right-panel${collapsed ? ' ui-right-panel--collapsed' : ''}`}>
      {/* 折叠后右栏整体移出屏幕，这里提供一个始终可见的边缘把手用于恢复 */}
      {collapsed && (
        <button
          type="button"
          className="ui-right-panel__handle"
          onClick={toggleCollapse}
          title="展开执行跟踪"
          aria-label="展开执行跟踪"
        >
          <span className="ui-right-panel__handle-arrow">◂</span>
          <span className="ui-right-panel__handle-text">执行跟踪</span>
        </button>
      )}
      <div className="ui-right-panel__head">
        <Tabs items={visibleTabs} activeKey={activeTab} onChange={changeTab} />
        <button
          type="button"
          className="ui-right-panel__collapse"
          onClick={toggleCollapse}
          title={collapsed ? '展开右栏' : '折叠右栏'}
        >
          {collapsed ? '«' : '»'}
        </button>
      </div>
      <div className="ui-right-panel__body">{content[activeTab]}</div>
    </aside>
  )
}
