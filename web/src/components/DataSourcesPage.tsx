import { useEffect, useRef, useState } from "react";
import {
  elkSearch,
  fetchDatabaseSystems,
  fetchLogSystems,
  fetchMetricSystems,
  listKnowledgeCases,
  promInstantQuery,
  promRangeQuery,
  searchKnowledgeCases,
  testMetricSystem,
  type DatabaseBackend,
  type ElkSearchRow,
  type KnowledgeCase,
  type LogBackend,
  type PrometheusBackend,
} from "../lib/api.js";
import { createMetricChart } from "../lib/charts.js";
import "./datasources.css";

type Category = "metrics" | "logs" | "database" | "knowledge";

const CATEGORY_LABELS: Record<Category, string> = {
  metrics: "指标查询",
  logs: "日志查询",
  database: "数据库查询",
  knowledge: "知识库检索",
};

// 每个类别连的是什么后端、有多少已启用，直接写在导航项里；
// 原先顶部那行「支持矩阵」与四张 KPI 卡片的信息都收敛到这里。
const CATEGORY_META: Record<Category, string> = {
  metrics: "Prometheus · VictoriaMetrics",
  logs: "ELK / ClickHouse / Generic",
  database: "SQLite · MySQL · PostgreSQL",
  knowledge: "案例检索 · 经验回流",
};

const RANGE_PRESETS: { label: string; window: string; step: string }[] = [
  { label: "近 15 分钟", window: "15m", step: "30s" },
  { label: "近 1 小时", window: "1h", step: "1m" },
  { label: "近 6 小时", window: "6h", step: "5m" },
  { label: "近 24 小时", window: "24h", step: "15m" },
];

const QUICK_QUERIES = [
  { label: "CPU 使用率", query: '100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)' },
  { label: "内存可用率", query: "node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100" },
  { label: "容器内存 (MiB)", query: "container_memory_working_set_bytes / 1024 / 1024" },
  { label: "Pod 重启次数", query: "increase(kube_pod_container_status_restarts_total[1h])" },
  { label: "5 分钟负载", query: "node_load5" },
];

const PROMQL_HISTORY_KEY = "infrapilot.promql.history";

export function DataSourcesPage({
  notify,
  onOpenSettings,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onOpenSettings: (section: string) => void;
}) {
  const [category, setCategory] = useState<Category>("metrics");
  const [logSystems, setLogSystems] = useState<LogBackend[]>([]);
  const [metricSystems, setMetricSystems] = useState<PrometheusBackend[]>([]);
  const [databaseSystems, setDatabaseSystems] = useState<DatabaseBackend[]>([]);
  const [knowledgeCount, setKnowledgeCount] = useState<number | null>(null);

  useEffect(() => {
    fetchLogSystems((err) => notify(err.message)).then((r) => r && setLogSystems(r.systems));
    fetchMetricSystems((err) => notify(err.message)).then((r) => r && setMetricSystems(r.systems));
    fetchDatabaseSystems((err) => notify(err.message)).then((r) => r && setDatabaseSystems(r.systems));
    listKnowledgeCases((err) => notify(err.message)).then((r) => r && setKnowledgeCount(r.cases.length));
  }, [notify]);

  const enabledCount = (list: { enabled: boolean }[]) => list.filter((x) => x.enabled).length;

  const categoryCount = (key: Category): string | null => {
    if (key === "metrics") return `${enabledCount(metricSystems)}/${metricSystems.length}`;
    if (key === "logs") return `${enabledCount(logSystems)}/${logSystems.length}`;
    if (key === "database") return `${enabledCount(databaseSystems)}/${databaseSystems.length}`;
    if (key === "knowledge") return knowledgeCount === null ? null : String(knowledgeCount);
    return null;
  };

  return (
    <div className="ds-page">
      <div className="page-header">
        <h1 className="page-header__title">数据源工作台</h1>
        <p className="page-header__subtitle">统一查询指标、日志、数据库与知识库，为诊断提供多源数据支撑</p>
      </div>

      <div className="ds-layout">
        <nav className="ds-nav">
          <div className="settings-nav__title">数据类别</div>
          <ul className="ds-nav__list">
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((key) => (
              <li key={key}>
                <button
                  className={["ds-nav__item", category === key ? "ds-nav__item--active" : ""].filter(Boolean).join(" ")}
                  onClick={() => setCategory(key)}
                >
                  <span className="ds-nav__text">
                    <span className="ds-nav__label">{CATEGORY_LABELS[key]}</span>
                    <span className="ds-nav__meta" title={CATEGORY_META[key]}>{CATEGORY_META[key]}</span>
                  </span>
                  {categoryCount(key) !== null && <span className="ds-nav__count">{categoryCount(key)}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="ds-nav__hint">
            本页用于<strong>查询/使用</strong>数据源；增删改与连接测试在
            「设置 → 日志系统后端 / 指标数据源 / 数据库」中管理。
          </div>
        </nav>

        <div className="ds-content">
          {category === "metrics" && <MetricsPanel systems={metricSystems} notify={notify} onOpenSettings={onOpenSettings} />}
          {category === "logs" && <LogsPanel systems={logSystems} notify={notify} onOpenSettings={onOpenSettings} />}
          {category === "database" && <DatabasePanel systems={databaseSystems} notify={notify} onOpenSettings={onOpenSettings} />}
          {category === "knowledge" && <KnowledgePanel notify={notify} />}
        </div>
      </div>
    </div>
  );
}

// ============================================================================ //
// 指标查询（Prometheus）
// ============================================================================ //

function MetricsPanel({
  systems,
  notify,
  onOpenSettings,
}: {
  systems: PrometheusBackend[];
  notify: (msg: string, type?: "error" | "success") => void;
  onOpenSettings: (section: string) => void;
}) {
  const enabled = systems.filter((s) => s.enabled);
  const [targetId, setTargetId] = useState<string>(enabled[0]?.id ?? systems[0]?.id ?? "");
  const [query, setQuery] = useState("up");
  const [rangeIdx, setRangeIdx] = useState(1);
  const [loading, setLoading] = useState(false);
  const [series, setSeries] = useState<{ name: string; points: [number, number][] }[]>([]);
  const [instantRows, setInstantRows] = useState<{ labels: string; value: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(PROMQL_HISTORY_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const chartRef = useRef<HTMLDivElement | null>(null);

  const target = systems.find((s) => s.id === targetId);

  useEffect(() => {
    if (!target) return;
    // 切换后端后自动探活，让用户立刻知道该数据源是否可用
    testMetricSystem(target.id, (err) => notify(err.message)).then((r) => {
      if (!r) return;
      if (r.reachable) {
        notify(`已连接 ${target.name}${r.version ? ` (v${r.version})` : ""}`, "success");
      } else {
        notify(`${target.name} 连接失败：${r.error ?? "未知错误"}`);
      }
    });
  }, [target?.id]);

  const renderChart = (data: { name: string; points: [number, number][] }[]) => {
    const host = chartRef.current;
    if (!host) return;
    host.innerHTML = "";
    if (data.length === 0) return;
    try {
      const width = host.clientWidth || 760;
      createMetricChart(host, data, width, 300);
    } catch {
      // 渲染失败静默处理
    }
  };

  const runQuery = async (q?: string) => {
    if (!target) {
      notify("请先在设置中添加并启用 Prometheus 数据源");
      return;
    }
    const promql = (q ?? query).trim();
    if (!promql) return;
    setLoading(true);
    setError(null);
    setInstantRows(null);
    try {
      const preset = RANGE_PRESETS[rangeIdx];
      const end = new Date();
      const start = new Date(end.getTime() - msOf(preset.window));
      const res = await promRangeQuery(target.id, promql, { start: start.toISOString(), end: end.toISOString(), step: preset.step }, (err) => notify(err.message));
      if (!res) return;
      if (!res.ok) {
        setError(res.error ?? "查询失败");
        setSeries([]);
        return;
      }
      const next = res.series ?? [];
      setSeries(next);
      // DOM 已更新后渲染
      requestAnimationFrame(() => renderChart(next));
      const nextHistory = [promql, ...history.filter((h) => h !== promql)].slice(0, 12);
      setHistory(nextHistory);
      localStorage.setItem(PROMQL_HISTORY_KEY, JSON.stringify(nextHistory));
    } finally {
      setLoading(false);
    }
  };

  if (systems.length === 0) {
    return (
      <div className="card ds-card">
        <div className="settings-section__header">
          <div>
            <h3 className="settings-section__title">指标查询</h3>
            <p className="settings-section__desc">
              尚未配置 Prometheus 数据源。支持原生 Prometheus、VictoriaMetrics、Mimir 等兼容 PromQL API 的后端；
              数据源的增删改与连接测试在「设置 → 指标数据源」中管理。
            </p>
          </div>
        </div>
        <div className="ds-query-actions">
          <button className="btn btn--primary btn--sm" onClick={() => onOpenSettings("metric-systems")}>
            去设置添加指标数据源
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-stack">
      <div className="card ds-card">
        <div className="ds-toolbar">
          <select className="input input--sm" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.enabled ? "" : "（已禁用）"} · {s.url}
              </option>
            ))}
          </select>
          <span className="ds-query-hint">切换数据源时自动探活</span>
        </div>
        <div className="ds-query-row">
          <textarea
            className="input textarea ds-promql"
            rows={3}
            placeholder='输入 PromQL，如 rate(http_requests_total[5m])'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runQuery();
            }}
          />
          <div className="ds-query-actions">
            <button className="btn btn--primary" onClick={() => runQuery()} disabled={loading}>
              {loading ? "查询中…" : "查询"}
            </button>
            <span className="ds-query-hint">Ctrl+Enter 快速执行</span>
          </div>
        </div>
        <div className="ds-preset-row">
          {RANGE_PRESETS.map((p, idx) => (
            <button
              key={p.window}
              className={`ds-chip${rangeIdx === idx ? " ds-chip--active" : ""}`}
              onClick={() => {
                setRangeIdx(idx);
                requestAnimationFrame(() => runQuery());
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="ds-quick-row">
          <span className="ds-quick-label">常用：</span>
          {QUICK_QUERIES.map((q) => (
            <button key={q.label} className="ds-chip" onClick={() => { setQuery(q.query); runQuery(q.query); }}>
              {q.label}
            </button>
          ))}
          {history.slice(0, 4).map((h) => (
            <button key={h} className="ds-chip ds-chip--history" title={h} onClick={() => { setQuery(h); runQuery(h); }}>
              ⟲ {h.length > 28 ? `${h.slice(0, 28)}…` : h}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="ds-error card">{error}</div>}

      <div className="card ds-card">
        <div className="settings-section__header">
          <div>
            <h3 className="settings-section__title">指标曲线</h3>
            <p className="settings-section__desc">{series.length > 0 ? `${series.length} 条时间序列` : "执行查询后在此展示区间曲线"}</p>
          </div>
          <button
            className="btn btn--secondary btn--sm"
            disabled={!target || loading}
            onClick={async () => {
              if (!target) return;
              const res = await promInstantQuery(target.id, query, (err) => notify(err.message));
              if (!res) return;
              if (!res.ok) {
                notify(res.error ?? "查询失败");
                return;
              }
              const rows = res.result?.samples ?? [];
              notify(`瞬时查询返回 ${rows.length} 条序列，已在下方表格展示`, "success");
              setSeries([]);
              const host = chartRef.current;
              if (host) host.innerHTML = "";
              setInstantRows(rows.map((s) => ({ labels: JSON.stringify(s.metric), value: s.value?.[1] ?? "?" })));
            }}
          >
            当前值查询
          </button>
        </div>
        <div ref={chartRef} className="ds-chart" />
        {series.length > 0 && (
          <div className="ds-series-list">
            {series.map((s) => (
              <div key={s.name} className="ds-series-row">
                <code>{s.name}</code>
                <span>{s.points.length} 点 · 最新 {s.points.at(-1)?.[1] ?? "-"}</span>
              </div>
            ))}
          </div>
        )}
        {instantRows && (
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr><th>Labels</th><th>Value</th></tr>
              </thead>
              <tbody>
                {instantRows.slice(0, 50).map((r, i) => (
                  <tr key={i}><td><code>{r.labels}</code></td><td>{r.value}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function msOf(window: string): number {
  const m = /^(\d+)([smhd])$/.exec(window);
  if (!m) return 3600_000;
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(m[1]) * (unit[m[2]] ?? 3_600_000);
}

// ============================================================================ //
// 日志查询（ELK / OpenSearch）
// ============================================================================ //

function LogsPanel({
  systems,
  notify,
  onOpenSettings,
}: {
  systems: LogBackend[];
  notify: (msg: string, type?: "error" | "success") => void;
  onOpenSettings: (section: string) => void;
}) {
  const elkBackends = systems.filter((s) => s.type === "elk");
  const [namespace, setNamespace] = useState("");
  const [level, setLevel] = useState("");
  const [keyword, setKeyword] = useState("");
  const [since, setSince] = useState("1h");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ElkSearchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (elkBackends.length === 0) {
    return (
      <div className="card ds-card">
        <h3 className="settings-section__title">日志查询</h3>
        <p className="settings-section__desc">
          尚未配置 ELK / OpenSearch 日志后端。日志后端的增删改与连接测试在「设置 → 日志系统后端」中管理。
        </p>
        <div className="ds-query-actions">
          <button className="btn btn--primary btn--sm" onClick={() => onOpenSettings("log-systems")}>
            去设置添加日志数据源
          </button>
        </div>
      </div>
    );
  }

  const runSearch = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await elkSearch({ namespace: namespace || undefined, level: level || undefined, keyword: keyword || undefined, since: since || undefined, limit: 100 }, (err) => notify(err.message));
      if (!res) return;
      if (!res.ok) {
        setError(res.error ?? "日志查询失败");
        setRows(null);
        return;
      }
      setRows(res.data?.logs ?? []);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ds-stack">
      <div className="card ds-card">
        <div className="ds-toolbar">
          <span className="tag">ELK / OpenSearch</span>
          <input className="input input--sm" placeholder="namespace（可选）" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
          <select className="input input--sm" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">全部级别</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
          </select>
          <select className="input input--sm" value={since} onChange={(e) => setSince(e.target.value)}>
            <option value="15m">近 15 分钟</option>
            <option value="1h">近 1 小时</option>
            <option value="6h">近 6 小时</option>
            <option value="24h">近 24 小时</option>
            <option value="">不限时间</option>
          </select>
          <input className="input input--sm ds-grow" placeholder="消息关键字（可选）" value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} />
          <button className="btn btn--primary btn--sm" onClick={runSearch} disabled={loading}>
            {loading ? "查询中…" : "检索日志"}
          </button>
        </div>
      </div>

      {error && <div className="ds-error card">{error}</div>}

      <div className="card ds-card">
        {rows === null ? (
          <div className="empty-state">
            <div className="empty-state__icon">📄</div>
            <div className="empty-state__message">设置过滤条件后检索日志</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">🕳️</div>
            <div className="empty-state__message">没有匹配的日志记录（时间窗内可能无数据或采集未覆盖）</div>
          </div>
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table ds-table--logs">
              <thead>
                <tr><th>时间</th><th>级别</th><th>服务</th><th>消息</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const ts = r["@timestamp"] ?? r.timestamp ?? "";
                  return (
                    <tr key={i}>
                      <td className="ds-nowrap">{ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "-"}</td>
                      <td><span className={`ds-level ds-level--${(r.level ?? "INFO").toLowerCase()}`}>{r.level ?? "INFO"}</span></td>
                      <td className="ds-nowrap">{r.service ?? r.namespace ?? "-"}</td>
                      <td className="ds-msg">{r.message ?? JSON.stringify(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================ //
// 数据库查询（SQLite 直接执行 / MySQL·PG 探活）
// ============================================================================ //

function DatabasePanel({
  systems,
  notify,
  onOpenSettings,
}: {
  systems: DatabaseBackend[];
  notify: (msg: string, type?: "error" | "success") => void;
  onOpenSettings: (section: string) => void;
}) {
  const enabled = systems.filter((s) => s.enabled);
  const [targetId, setTargetId] = useState(enabled[0]?.id ?? systems[0]?.id ?? "");
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ columns: string[]; rows: Array<Record<string, unknown>>; total?: number; truncated?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = systems.find((s) => s.id === targetId);

  const runSql = async () => {
    if (!target) {
      notify("请先添加数据库数据源");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { dbQuery } = await import("../lib/api.js");
      const res = await dbQuery(target.id, sql.trim(), (err) => notify(err.message));
      if (!res) return;
      if (!res.ok) {
        setError(res.error ?? "查询失败");
        setResult(null);
        return;
      }
      setResult({ columns: res.columns ?? [], rows: res.rows ?? [], total: res.total, truncated: res.truncated });
    } finally {
      setLoading(false);
    }
  };

  if (systems.length === 0) {
    return (
      <div className="card ds-card">
        <div className="settings-section__header">
          <div>
            <h3 className="settings-section__title">数据库查询</h3>
            <p className="settings-section__desc">
              接入业务数据库进行只读排查。SQLite 直接执行；MySQL / PostgreSQL 需在 server 端安装对应驱动。
              数据源的增删改与连接测试在「设置 → 数据库数据源」中管理。
            </p>
          </div>
        </div>
        <div className="ds-query-actions">
          <button className="btn btn--primary btn--sm" onClick={() => onOpenSettings("database-systems")}>
            去设置添加数据库数据源
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-stack">
      <div className="card ds-card">
        <div className="ds-toolbar">
          <select className="input input--sm" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.dialect}{s.enabled ? "" : "（已禁用）"}
              </option>
            ))}
          </select>
          <span className="tag">{target?.readonly ?? true ? "只读模式" : "读写模式"}</span>
          <span className="ds-query-hint">连接测试请在「设置 → 数据库数据源」中执行</span>
        </div>
        <textarea
          className="input textarea ds-sql"
          rows={4}
          placeholder="SELECT * FROM ...（只读模式仅允许 SELECT / EXPLAIN / SHOW / DESCRIBE / PRAGMA / WITH）"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runSql();
          }}
        />
        <div className="ds-query-actions">
          <button className="btn btn--primary" onClick={runSql} disabled={loading}>
            {loading ? "执行中…" : "执行查询"}
          </button>
          <span className="ds-query-hint">Ctrl+Enter 快速执行 · 最多返回 {target?.maxRows ?? 200} 行</span>
        </div>
      </div>

      {error && <div className="ds-error card">{error}</div>}

      {result && (
        <div className="card ds-card">
          <div className="settings-section__header">
            <div>
              <h3 className="settings-section__title">查询结果</h3>
              <p className="settings-section__desc">
                {result.total ?? result.rows.length} 行{result.truncated ? "（已截断）" : ""}
              </p>
            </div>
          </div>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>{result.columns.map((c) => <td key={c}><code>{String(row[c] ?? "")}</code></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================ //
// 知识库检索
// ============================================================================ //

function KnowledgePanel({ notify }: { notify: (msg: string, type?: "error" | "success") => void }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [cases, setCases] = useState<Array<KnowledgeCase & { score?: number }> | null>(null);

  const runSearch = async () => {
    setLoading(true);
    try {
      if (!query.trim()) {
        const all = await listKnowledgeCases((err) => notify(err.message));
        setCases(all?.cases ?? []);
        return;
      }
      const res = await searchKnowledgeCases(query.trim(), (err) => notify(err.message));
      setCases(res?.results ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runSearch();
  }, []);

  return (
    <div className="ds-stack">
      <div className="card ds-card">
        <div className="ds-toolbar">
          <input
            className="input input--sm ds-grow"
            placeholder="搜索历史案例：故障现象、服务名、根因关键词…（留空列出全部）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
          />
          <button className="btn btn--primary btn--sm" onClick={runSearch} disabled={loading}>
            {loading ? "检索中…" : "检索知识库"}
          </button>
        </div>
      </div>

      <div className="ds-stack">
        {cases === null ? null : cases.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">📚</div>
            <div className="empty-state__message">没有匹配的知识案例</div>
          </div>
        ) : (
          cases.map((c) => (
            <div key={c.id} className="card ds-case-card">
              <div className="ds-case-card__head">
                <span className={`badge badge--${c.resolved ? "success" : "muted"}`}>{c.resolved ? "已解决" : "未解决"}</span>
                <span className="tag">P{c.severity}</span>
                <strong className="ds-case-card__title">{c.title}</strong>
                {c.serviceName && <span className="tag">{c.serviceName}</span>}
                {typeof c.score === "number" && <span className="ds-case-card__score">相关度 {(c.score * 100).toFixed(0)}%</span>}
              </div>
              <p className="ds-case-card__summary">{c.summary}</p>
              {c.rootCauses.length > 0 && (
                <div className="ds-case-card__section">
                  <span className="ds-case-card__label">根因</span>
                  <ul>{c.rootCauses.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
              {c.solutions.length > 0 && (
                <div className="ds-case-card__section">
                  <span className="ds-case-card__label">解决方案</span>
                  <ul>{c.solutions.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
