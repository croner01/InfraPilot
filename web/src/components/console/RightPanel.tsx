import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tabs } from '../ui/Tabs.js'
import './right-panel.css'

export type PanelTab = 'process' | 'evidence' | 'object'

const tabs: { key: PanelTab; label: string }[] = [
  { key: 'process', label: '调查过程' },
  { key: 'evidence', label: '证据链' },
  { key: 'object', label: '对象上下文' },
]

interface RightPanelProps {
  process: ReactNode
  evidence: ReactNode
  object: ReactNode
  activeTab?: PanelTab
  onTabChange?: (tab: PanelTab) => void
}

export function RightPanel({ process, evidence, object, activeTab: controlledTab, onTabChange }: RightPanelProps) {
  const [internalTab, setInternalTab] = useState<PanelTab>('process')
  const [collapsed, setCollapsed] = useState(false)
  const activeTab = controlledTab ?? internalTab
  const content: Record<PanelTab, ReactNode> = { process, evidence, object }

  const changeTab = (key: string) => {
    const tab = key as PanelTab
    if (onTabChange) {
      onTabChange(tab)
    } else {
      setInternalTab(tab)
    }
  }

  return (
    <aside className={`ui-right-panel${collapsed ? ' ui-right-panel--collapsed' : ''}`}>
      <div className="ui-right-panel__head">
        <Tabs items={tabs} activeKey={activeTab} onChange={changeTab} />
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
