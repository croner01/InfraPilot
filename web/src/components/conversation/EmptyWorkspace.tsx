import './empty-workspace.css'

const quickCards = [
  { title: '排查 Pod 异常', desc: '输入故障现象，Agent 自动诊断' },
  { title: '查询日志', desc: '按服务/关键字检索 ELK 日志' },
  { title: '查看告警', desc: '进入告警中心处理待办' },
]

export function EmptyWorkspace({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="ui-empty-workspace">
      <h2 className="ui-empty-workspace__title">开始一次诊断</h2>
      <p className="ui-empty-workspace__message">描述故障现象，AI Agent 将自动收集证据并分析根因</p>
      <div className="ui-empty-workspace__cards">
        {quickCards.map((card) => (
          <button key={card.title} type="button" className="ui-empty-workspace__card" onClick={onNewSession}>
            <b>{card.title}</b>
            <span>{card.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
