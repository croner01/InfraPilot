export function TopologyPage() {
  return (
    <div className="topology-page">
      <div className="page-header">
        <h1 className="page-header__title">服务拓扑</h1>
        <p className="page-header__subtitle">自动发现服务依赖关系与调用链可视化</p>
      </div>
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card__label">服务节点</div>
          <div className="stat-card__value">—</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">调用边</div>
          <div className="stat-card__value stat-card__value--info">—</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">异常链路</div>
          <div className="stat-card__value stat-card__value--danger">—</div>
        </div>
      </div>
      <div className="main__content">
        <div className="page-placeholder">
          <div className="page-placeholder__icon">🌐</div>
          <h2>拓扑视图</h2>
          <p>服务拓扑自动发现与可视化能力正在建设中。</p>
          <div className="page-placeholder__hint">
            当前 Agent 已支持通过 <code>trace</code> / <code>topology</code> Skill 在会话中分析调用链，
            独立的拓扑浏览器将在后续版本提供。
          </div>
        </div>
      </div>
    </div>
  );
}
