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
