import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchUsageCalls,
  fetchUsageSummary,
  saveModelPrices,
  type LlmCall,
  type UsageModelPrice,
  type UsageSummary,
} from "../lib/api.js";
import "./usage.css";

/**
 * Token 用量统计页
 * 数据来源：GET /api/usage/summary（llm_calls 表聚合）；
 * 模型单价支持就地编辑并 PUT /api/config/model-prices。
 */

type NotifyFn = (msg: string, type?: "error" | "success") => void;

interface UsagePageProps {
  notify: NotifyFn;
}

const MODEL_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#d97706", "#16a34a", "#dc2626"];

const EMPTY_TOTALS = { prompt: 0, completion: 0, total: 0, calls: 0, cost: 0, avgLatency: 0 };

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function costOf(prices: UsageModelPrice[], model: string, prompt: number, completion: number): number {
  const p = prices.find((m) => m.model === model) ?? prices[0];
  if (!p) return 0;
  return (prompt / 1_000_000) * p.inputPerM + (completion / 1_000_000) * p.outputPerM;
}

export function UsagePage({ notify }: UsagePageProps) {
  const [range, setRange] = useState<7 | 14>(14);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingPrices, setEditingPrices] = useState(false);
  const [priceDraft, setPriceDraft] = useState<UsageModelPrice[]>([]);
  const [calls, setCalls] = useState<LlmCall[]>([]);
  const [callFilter, setCallFilter] = useState("");

  const load = useCallback(
    async (days: number) => {
      setLoading(true);
      const res = await fetchUsageSummary(days, 20, (err) => notify(err.message));
      if (res) setSummary(res);
      setLoading(false);
    },
    [notify],
  );

  useEffect(() => {
    void load(range);
  }, [load, range]);

  const loadCalls = useCallback(
    async (sessionId?: string) => {
      const res = await fetchUsageCalls(sessionId || undefined, 50, (err) => notify(err.message));
      if (res) setCalls(res.calls);
    },
    [notify],
  );

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  const series = summary?.series ?? [];
  const prices = summary?.prices ?? [];
  const sessionRows = summary?.sessions ?? [];
  const totals = summary?.totals ?? EMPTY_TOTALS;

  const models = useMemo(
    () =>
      (summary?.models ?? []).map((m, i) => ({
        ...m,
        color: MODEL_COLORS[i % MODEL_COLORS.length],
      })),
    [summary],
  );

  const maxDay = Math.max(1, ...series.map((d) => d.prompt + d.completion));
  const maxModel = Math.max(1, ...models.map((m) => m.tokens));
  const totalTokens = totals.total;

  const startEditPrices = () => {
    setPriceDraft(prices.map((p) => ({ ...p })));
    setEditingPrices(true);
  };

  const updateDraft = (index: number, key: "inputPerM" | "outputPerM", value: string) => {
    setPriceDraft((prev) => prev.map((p, i) => (i === index ? { ...p, [key]: Number(value) || 0 } : p)));
  };

  const commitPrices = async () => {
    const res = await saveModelPrices(priceDraft, (err) => notify(err.message));
    if (!res) return;
    setSummary((prev) => (prev ? { ...prev, prices: res.prices } : prev));
    setEditingPrices(false);
    notify("模型单价已保存", "success");
  };

  return (
    <div className="usage-page">
      <div className="page-header">
        <h1 className="page-header__title">
          用量统计
          <span className="usage-mock-tag">{loading ? "加载中…" : "实时数据"}</span>
        </h1>
        <p className="page-header__subtitle">
          Token 消耗、成本核算与 LLM 调用可观测，数据来自后端 llm_calls 表（捕获 response.usage）。
        </p>
      </div>

      {/* 时间范围 */}
      <div className="usage-toolbar">
        <div className="usage-toolbar__tabs">
          {[7, 14].map((r) => (
            <button
              key={r}
              className={`usage-toolbar__tab${range === r ? " usage-toolbar__tab--active" : ""}`}
              onClick={() => setRange(r as 7 | 14)}
            >
              近 {r} 天
            </button>
          ))}
        </div>
        <div className="usage-toolbar__hint">按会话 / 模型聚合，支持配额熔断（后端待接入）</div>
      </div>

      {/* 统计卡 */}
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card__label">总 Tokens</div>
          <div className="stat-card__value">{fmtTokens(totals.total)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">估算成本</div>
          <div className="stat-card__value stat-card__value--accent">¥{totals.cost.toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">LLM 调用</div>
          <div className="stat-card__value stat-card__value--info">{totals.calls}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">平均延迟 P50</div>
          <div className="stat-card__value stat-card__value--success">{totals.avgLatency}ms</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">活跃会话</div>
          <div className="stat-card__value stat-card__value--warning">{sessionRows.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">Prompt / Completion</div>
          <div className="stat-card__value" style={{ fontSize: 16, paddingTop: 8 }}>
            {totals.total > 0 ? Math.round((totals.prompt / totals.total) * 100) : 0}% /{" "}
            {totals.total > 0 ? Math.round((totals.completion / totals.total) * 100) : 0}%
          </div>
        </div>
      </div>

      {/* 图表行 */}
      <div className="usage-charts">
        <div className="usage-panel">
          <div className="usage-panel__header">
            <div className="usage-panel__title">每日 Token 消耗</div>
            <div className="usage-legend">
              <span className="usage-legend__item"><i style={{ background: "#2563eb" }} />prompt</span>
              <span className="usage-legend__item"><i style={{ background: "#7c3aed" }} />completion</span>
            </div>
          </div>
          <svg viewBox="0 0 560 200" className="usage-bar-chart">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1="36" y1={170 - 150 * f} x2="552" y2={170 - 150 * f} stroke="#eef1f5" />
            ))}
            {series.map((d, i) => {
              const bw = Math.min(26, 460 / Math.max(series.length, 1) - 6);
              const x = 46 + i * (500 / Math.max(series.length, 1));
              const hp = ((d.prompt / maxDay) * 150) | 0;
              const hc = ((d.completion / maxDay) * 150) | 0;
              return (
                <g key={d.date}>
                  <rect x={x} y={170 - hp} width={bw} height={hp} rx="2" fill="#2563eb" opacity="0.85" />
                  <rect x={x} y={170 - hp - hc} width={bw} height={hc} rx="2" fill="#7c3aed" opacity="0.85" />
                  <text x={x + bw / 2} y="186" textAnchor="middle" fontSize="9.5" fill="#8a93a6">
                    {d.date}
                  </text>
                </g>
              );
            })}
            <text x="36" y={170 - 150} textAnchor="end" fontSize="9.5" fill="#8a93a6">{fmtTokens(maxDay)}</text>
            <text x="36" y="174" textAnchor="end" fontSize="9.5" fill="#8a93a6">0</text>
          </svg>
        </div>

        <div className="usage-panel">
          <div className="usage-panel__header">
            <div className="usage-panel__title">模型分布</div>
          </div>
          <div className="usage-models">
            {models.map((m) => (
              <div key={m.model} className="usage-model-row">
                <div className="usage-model-row__head">
                  <span className="usage-model-row__name">{m.model}</span>
                  <span className="usage-model-row__meta">
                    {fmtTokens(m.tokens)} · {m.calls} 次 · ¥{costOf(prices, m.model, m.tokens * 0.72, m.tokens * 0.28).toFixed(2)}
                  </span>
                </div>
                <div className="usage-model-row__bar">
                  <div
                    className="usage-model-row__fill"
                    style={{ width: `${(m.tokens / maxModel) * 100}%`, background: m.color }}
                  />
                </div>
                <div className="usage-model-row__pct">{totalTokens > 0 ? Math.round((m.tokens / totalTokens) * 100) : 0}%</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 会话排行 */}
      <div className="usage-panel">
        <div className="usage-panel__header">
          <div className="usage-panel__title">会话用量排行</div>
          <div className="usage-panel__hint">按消耗排序 · 用户隔离上线后增加按用户筛选</div>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>会话</th>
              <th>模型</th>
              <th style={{ textAlign: "right" }}>调用</th>
              <th style={{ textAlign: "right" }}>Prompt</th>
              <th style={{ textAlign: "right" }}>Completion</th>
              <th style={{ textAlign: "right" }}>成本</th>
              <th style={{ textAlign: "right" }}>延迟 P50</th>
            </tr>
          </thead>
          <tbody>
            {sessionRows.length === 0 && (
              <tr>
                <td className="usage-table__title" colSpan={7}>暂无用量的会话记录</td>
              </tr>
            )}
            {sessionRows.map((r) => (
              <tr key={r.id}>
                <td className="usage-table__title">{r.title}</td>
                <td><span className="usage-model-chip">{r.model}</span></td>
                <td className="num">{r.calls}</td>
                <td className="num">{fmtTokens(r.promptTokens)}</td>
                <td className="num">{fmtTokens(r.completionTokens)}</td>
                <td className="num">¥{costOf(prices, r.model, r.promptTokens, r.completionTokens).toFixed(2)}</td>
                <td className="num">{r.latencyP50}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 调用明细 */}
      <div className="usage-panel">
        <div className="usage-panel__header">
          <div className="usage-panel__title">LLM 调用明细</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="按会话 ID 过滤"
              value={callFilter}
              onChange={(e) => setCallFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadCalls(callFilter.trim())}
              style={{ width: 260 }}
            />
            <button className="btn btn--sm" onClick={() => loadCalls(callFilter.trim())}>刷新</button>
          </div>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>类型</th>
              <th style={{ textAlign: "right" }}>Prompt</th>
              <th style={{ textAlign: "right" }}>Completion</th>
              <th style={{ textAlign: "right" }}>延迟</th>
              <th style={{ textAlign: "right" }}>成本</th>
              <th>会话</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 && (
              <tr>
                <td className="usage-table__title" colSpan={8}>暂无调用记录</td>
              </tr>
            )}
            {calls.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.created_at).toLocaleString()}</td>
                <td><span className="usage-model-chip">{c.model}</span></td>
                <td>{c.call_type}</td>
                <td className="num">{fmtTokens(c.prompt_tokens)}</td>
                <td className="num">{fmtTokens(c.completion_tokens)}</td>
                <td className="num">{c.latency_ms}ms</td>
                <td className="num">¥{c.cost.toFixed(4)}</td>
                <td className="usage-table__title">{c.session_id ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 模型单价 */}
      <div className="usage-panel">
        <div className="usage-panel__header">
          <div className="usage-panel__title">模型单价（成本核算依据）</div>
          {editingPrices ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn--sm" onClick={() => setEditingPrices(false)}>取消</button>
              <button className="btn btn--sm btn--primary" onClick={commitPrices}>保存</button>
            </div>
          ) : (
            <button className="btn btn--sm" onClick={startEditPrices}>编辑单价</button>
          )}
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>模型</th>
              <th style={{ textAlign: "right" }}>输入 ¥ / 1M tokens</th>
              <th style={{ textAlign: "right" }}>输出 ¥ / 1M tokens</th>
            </tr>
          </thead>
          <tbody>
            {(editingPrices ? priceDraft : prices).map((p, i) => (
              <tr key={p.model}>
                <td className="usage-table__title">{p.model}</td>
                {editingPrices ? (
                  <>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        step="0.1"
                        style={{ width: 110, textAlign: "right" }}
                        value={p.inputPerM}
                        onChange={(e) => updateDraft(i, "inputPerM", e.target.value)}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        step="0.1"
                        style={{ width: 110, textAlign: "right" }}
                        value={p.outputPerM}
                        onChange={(e) => updateDraft(i, "outputPerM", e.target.value)}
                      />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="num">{p.inputPerM.toFixed(1)}</td>
                    <td className="num">{p.outputPerM.toFixed(1)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
