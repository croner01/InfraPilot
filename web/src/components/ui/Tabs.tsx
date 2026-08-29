import './tabs.css'

export interface TabItem {
  key: string
  label: string
  count?: number
}

interface TabsProps {
  items: TabItem[]
  activeKey: string
  onChange: (key: string) => void
}

export function Tabs({ items, activeKey, onChange }: TabsProps) {
  return (
    <div className="ui-tabs" role="tablist">
      {items.map((item) => {
        const active = item.key === activeKey
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ui-tabs__tab${active ? ' ui-tabs__tab--active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            {item.label}
            {item.count !== undefined && <span className="ui-tabs__count">{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
