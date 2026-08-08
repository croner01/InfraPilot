import { useEffect, useState } from "react";
import { addKnowledgeCase, listKnowledgeCases, searchKnowledgeCases } from "../lib/api.js";
import type { KnowledgeCase } from "../lib/api.js";

export function KnowledgePage({ notify }: { notify: (msg: string, type?: "error" | "success") => void }) {
  const [cases, setCases] = useState<KnowledgeCase[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState<KnowledgeCase | null>(null);
  const [form, setForm] = useState<Partial<KnowledgeCase>>({
    severity: "p2",
    problemType: "",
    title: "",
    summary: "",
    rootCauses: [],
    solutions: [],
    serviceName: "",
    tags: [],
  });

  const load = async () => {
    setLoading(true);
    const res = await listKnowledgeCases((err) => notify(err.message));
    if (res) setCases(res.cases);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleSearch = async () => {
    if (!query.trim()) {
      await load();
      return;
    }
    setLoading(true);
    const res = await searchKnowledgeCases(query.trim(), (err) => notify(err.message));
    if (res) setCases(res.results.map((r) => ({ ...r, resolved: true })));
    setLoading(false);
  };

  const handleSave = async () => {
    if (!form.title || !form.summary || !form.rootCauses?.length) {
      notify("请填写标题、摘要和至少一个根因");
      return;
    }
    const body = {
      title: form.title,
      problemType: form.problemType || "general",
      severity: form.severity || "p2",
      summary: form.summary,
      rootCauses: form.rootCauses,
      solutions: form.solutions || [],
      serviceName: form.serviceName,
      tags: form.tags || [],
    };
    const res = await addKnowledgeCase(body, (err) => notify(err.message));
    if (res) {
      notify("案例已保存", "success");
      setShowForm(false);
      setForm({ severity: "p2", problemType: "", title: "", summary: "", rootCauses: [], solutions: [], serviceName: "", tags: [] });
      await load();
    }
  };

  const autoCount = cases.filter((c) => c.tags?.includes("auto_persisted")).length;

  return (
    <div className="knowledge-page">
      <div className="page-header">
        <h1 className="page-header__title">知识库</h1>
        <p className="page-header__subtitle">沉淀故障案例，辅助 Agent 根因分析与推理</p>
      </div>
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card__label">案例总数</div>
          <div className="stat-card__value">{cases.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">自动沉淀</div>
          <div className="stat-card__value stat-card__value--info">{autoCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">P0 / P1</div>
          <div className="stat-card__value stat-card__value--danger">
            {cases.filter((c) => c.severity === "p0" || c.severity === "p1").length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">关联服务</div>
          <div className="stat-card__value stat-card__value--success">
            {new Set(cases.map((c) => c.serviceName).filter(Boolean)).size}
          </div>
        </div>
      </div>

      <div className="main__content">
        <div className="knowledge-page__header">
          <h2>案例列表</h2>
          <button className="btn btn--primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? "取消" : "+ 新增案例"}
          </button>
        </div>

      {showForm && (
        <div className="knowledge-form card">
          <h3>新增案例</h3>
          <div className="form-grid">
            <input className="input" placeholder="标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className="input" placeholder="问题类型" value={form.problemType} onChange={(e) => setForm({ ...form, problemType: e.target.value })} />
            <select className="input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as any })}>
              <option value="p0">P0</option>
              <option value="p1">P1</option>
              <option value="p2">P2</option>
              <option value="p3">P3</option>
            </select>
            <input className="input" placeholder="关联服务" value={form.serviceName} onChange={(e) => setForm({ ...form, serviceName: e.target.value })} />
          </div>
          <textarea
            className="input textarea"
            placeholder="问题摘要"
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            rows={3}
          />
          <ArrayInput label="根因（每行一个）" values={form.rootCauses || []} onChange={(v) => setForm({ ...form, rootCauses: v })} />
          <ArrayInput label="解决方案（每行一个）" values={form.solutions || []} onChange={(v) => setForm({ ...form, solutions: v })} />
          <input
            className="input"
            placeholder="标签，用逗号分隔"
            value={(form.tags || []).join(",")}
            onChange={(e) => setForm({ ...form, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
          <div className="form-actions">
            <button className="btn btn--primary" onClick={handleSave}>保存</button>
          </div>
        </div>
      )}

      <div className="knowledge-search">
        <input
          className="input"
          placeholder="输入关键词搜索知识库..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
        <button className="btn btn--secondary" onClick={handleSearch}>搜索</button>
        <button className="btn btn--secondary" onClick={load}>重置</button>
      </div>

      {loading ? (
        <div className="skeleton-list">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : (
        <div className="knowledge-list">
          {cases.length === 0 && <div className="empty-state"><div className="empty-state__icon">📚</div><div className="empty-state__message">暂无知识库案例</div></div>}
          {cases.map((c) => (
            <div
              key={c.id}
              className="knowledge-card card"
              onClick={() => setSelected(c)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(c);
                }
              }}
            >
              <div className="knowledge-card__header">
                <span className="knowledge-card__title">{c.title}</span>
                <span className={`risk-badge risk-badge--${c.severity}`}>{c.severity}</span>
              </div>
              <div className="knowledge-card__meta">
                {c.problemType} {c.serviceName ? `· ${c.serviceName}` : ""} · {new Date(c.createdAt).toLocaleString()}
              </div>
              <div className="knowledge-card__summary">{c.summary}</div>
              {c.rootCauses.length > 0 && (
                <div className="knowledge-card__section">
                  <div className="knowledge-card__section-title">根因</div>
                  <ul>{c.rootCauses.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
              {c.solutions.length > 0 && (
                <div className="knowledge-card__section">
                  <div className="knowledge-card__section-title">解决方案</div>
                  <ul>{c.solutions.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
              )}
              {c.tags && c.tags.length > 0 && (
                <div className="knowledge-card__tags">
                  {c.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                </div>
              )}
              <div className="knowledge-card__footer">
                <button
                  className="btn btn--sm btn--secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(c);
                  }}
                >
                  查看详情
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      {selected && (
        <div className="knowledge-modal-backdrop" onClick={() => setSelected(null)}>
          <div className="knowledge-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="knowledge-modal__header">
              <h3>{selected.title}</h3>
              <button className="btn btn--sm btn--ghost" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="knowledge-modal__meta">
              <span className={`risk-badge risk-badge--${selected.severity}`}>{selected.severity}</span>
              {selected.problemType && <span>{selected.problemType}</span>}
              {selected.serviceName && <span>关联服务：{selected.serviceName}</span>}
              <span>{new Date(selected.createdAt).toLocaleString()}</span>
              {selected.sourceSessionId && <span className="knowledge-modal__session">来源会话：{selected.sourceSessionId}</span>}
            </div>
            <div className="knowledge-modal__body">
              <section className="knowledge-modal__section">
                <h4>问题摘要</h4>
                <p>{selected.summary}</p>
              </section>
              <section className="knowledge-modal__section">
                <h4>根因（{selected.rootCauses.length}）</h4>
                <ul>{selected.rootCauses.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </section>
              <section className="knowledge-modal__section">
                <h4>解决方案（{selected.solutions.length}）</h4>
                <ul>{selected.solutions.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </section>
              {selected.tags && selected.tags.length > 0 && (
                <section className="knowledge-modal__section">
                  <h4>标签</h4>
                  <div className="knowledge-card__tags">
                    {selected.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ArrayInput({ label, values, onChange }: { label: string; values: string[]; onChange: (v: string[]) => void }) {
  const text = values.join("\n");
  return (
    <div className="array-input">
      <label>{label}</label>
      <textarea
        className="input textarea"
        value={text}
        onChange={(e) => onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
        rows={3}
      />
    </div>
  );
}
