import { useEffect, useState } from "react";
import {
  deleteDatabaseSystem,
  deleteMetricSystem,
  testDatabaseSystem,
  testMetricSystem,
  upsertDatabaseSystem,
  upsertMetricSystem,
  type DatabaseBackend,
  type DatabaseDialect,
  type PrometheusBackend,
} from "../../lib/api.js";

// ============================================================================
// 设置页 — 指标数据源（Prometheus）与数据库数据源管理区块
// ============================================================================

export function PrometheusSection({
  notify,
  onSystemsChange,
  systems,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onSystemsChange: (systems: PrometheusBackend[]) => void;
  systems: PrometheusBackend[];
}) {
  return (
    <div className="ds-stack">
      {systems.length === 0 && <EmptyState icon="📈" message="暂无 Prometheus 数据源" />}
      {systems.map((s) => (
        <PromCard key={s.id} system={s} notify={notify} onSystemsChange={onSystemsChange} />
      ))}
      <PromNewForm notify={notify} onSaved={(systems) => onSystemsChange(systems)} />
    </div>
  );
}

function PromCard({
  system,
  notify,
  onSystemsChange,
}: {
  system: PrometheusBackend;
  notify: (msg: string, type?: "error" | "success") => void;
  onSystemsChange: (systems: PrometheusBackend[]) => void;
}) {
  const [draft, setDraft] = useState(system);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(system), [system.id]);

  const save = async () => {
    setBusy(true);
    const res = await upsertMetricSystem(draft, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onSystemsChange(res.systems);
      notify("已保存", "success");
    }
  };

  const remove = async () => {
    if (!confirm(`确定删除数据源「${system.name}」吗？`)) return;
    const res = await deleteMetricSystem(system.id, (err) => notify(err.message));
    if (res) {
      onSystemsChange(res.systems);
      notify("已删除", "success");
    }
  };

  const test = async () => {
    setBusy(true);
    const r = await testMetricSystem(system.id, (err) => notify(err.message));
    setBusy(false);
    if (r) notify(r.reachable ? `连接成功${r.version ? ` (v${r.version})` : ""}` : `连接失败：${r.error ?? ""}`, r.reachable ? "success" : "error");
  };

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <input className="input input--inline log-system-card__name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <span className="tag">PromQL API</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span className="toggle__track" />
          <span className="toggle__label">{draft.enabled ? "启用" : "禁用"}</span>
        </label>
      </div>
      <div className="log-system-card__body">
        <div className="form-grid form-grid--3">
          <Field label="API 地址">
            <input className="input" placeholder="http://prometheus:9090" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </Field>
          <Field label="认证 Header 环境变量（可选）">
            <input
              className="input"
              placeholder='{"Authorization": "PROM_TOKEN"}'
              value={JSON.stringify(draft.headerEnv ?? {})}
              onChange={(e) => {
                try {
                  setDraft({ ...draft, headerEnv: e.target.value.trim() ? JSON.parse(e.target.value) : undefined });
                } catch {
                  // 非法 JSON 时忽略，保存前校验
                }
              }}
            />
          </Field>
        </div>
      </div>
      <div className="log-system-card__actions">
        <button className="btn btn--secondary" onClick={test} disabled={busy}>{busy ? "测试中..." : "连接测试"}</button>
        <button className="btn btn--primary" onClick={save} disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        <button className="btn btn--danger" onClick={remove}>删除</button>
      </div>
    </div>
  );
}

function PromNewForm({
  notify,
  onSaved,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onSaved: (systems: PrometheusBackend[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PrometheusBackend>({
    id: `prom-${Date.now()}`,
    type: "prometheus",
    name: "Prometheus",
    enabled: true,
    url: "http://127.0.0.1:9090",
  });

  const save = async () => {
    if (!form.name || !form.url) {
      notify("请填写名称与 API 地址");
      return;
    }
    const res = await upsertMetricSystem(form, (err) => notify(err.message));
    if (res) {
      onSaved(res.systems);
      notify("Prometheus 数据源已创建", "success");
      setForm({ ...form, id: `prom-${Date.now()}` });
      setOpen(false);
    }
  };

  return (
    <div className="ds-inline-form">
      {!open ? (
        <button className="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>+ 新增 Prometheus 数据源</button>
      ) : (
        <>
          <div className="form-grid form-grid--3">
            <Field label="名称">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="API 地址">
              <input className="input" placeholder="http://prometheus:9090" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </Field>
          </div>
          <div className="ds-query-actions">
            <button className="btn btn--primary btn--sm" onClick={save}>创建</button>
            <button className="btn btn--secondary btn--sm" onClick={() => setOpen(false)}>取消</button>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================ //

export function DatabaseSection({
  notify,
  onSystemsChange,
  systems,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onSystemsChange: (systems: DatabaseBackend[]) => void;
  systems: DatabaseBackend[];
}) {
  return (
    <div className="ds-stack">
      <div className="settings-hint">
        数据库数据源以<strong>只读模式</strong>接入（仅允许 SELECT / EXPLAIN / SHOW / DESCRIBE / PRAGMA / WITH）。
        SQLite 直接执行查询；MySQL 与 <strong>MariaDB（协议完全兼容）</strong>共用 mysql2 驱动、PostgreSQL 使用 pg 驱动，均支持连接测试，
        SQL 查询需在 server 端安装对应驱动（<code>npm install mysql2</code> / <code>npm install pg</code>）。
        ClickHouse 与 Elasticsearch 为规划类型：可先创建配置，驱动接入前连接测试将提示"待接入"。
      </div>
      {systems.length === 0 && <EmptyState icon="🗄️" message="暂无数据库数据源" />}
      {systems.map((s) => (
        <DbCard key={s.id} system={s} notify={notify} onSystemsChange={onSystemsChange} />
      ))}
      <DbNewForm notify={notify} onSaved={(systems) => onSystemsChange(systems)} />
    </div>
  );
}

function DbCard({
  system,
  notify,
  onSystemsChange,
}: {
  system: DatabaseBackend;
  notify: (msg: string, type?: "error" | "success") => void;
  onSystemsChange: (systems: DatabaseBackend[]) => void;
}) {
  const [draft, setDraft] = useState(system);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(system), [system.id]);

  const save = async () => {
    setBusy(true);
    const res = await upsertDatabaseSystem(draft, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onSystemsChange(res.systems);
      notify("已保存", "success");
    }
  };

  const remove = async () => {
    if (!confirm(`确定删除数据源「${system.name}」吗？`)) return;
    const res = await deleteDatabaseSystem(system.id, (err) => notify(err.message));
    if (res) {
      onSystemsChange(res.systems);
      notify("已删除", "success");
    }
  };

  const test = async () => {
    setBusy(true);
    const r = await testDatabaseSystem(system.id, (err) => notify(err.message));
    setBusy(false);
    if (r) notify(r.reachable ? "连接成功" : `连接失败：${r.error ?? ""}`, r.reachable ? "success" : "error");
  };

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <input className="input input--inline log-system-card__name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <span className="tag">{draft.dialect}</span>
          {(draft.dialect === "clickhouse" || draft.dialect === "elasticsearch") && <span className="tag tag--warn">驱动待接入</span>}
          {(draft.readonly ?? true) && <span className="tag">只读</span>}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span className="toggle__track" />
          <span className="toggle__label">{draft.enabled ? "启用" : "禁用"}</span>
        </label>
      </div>
      <div className="log-system-card__body">
        <div className="form-grid form-grid--3">
          <Field label={draft.dialect === "sqlite" ? "数据库文件路径" : "主机"}>
            <input className="input" placeholder={draft.dialect === "sqlite" ? "server/data/infrapilot.db" : "10.0.0.1"} value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
          </Field>
          {draft.dialect !== "sqlite" && (
            <>
              <Field label="端口">
                <input className="input" type="number" placeholder={draft.dialect === "postgres" ? "5432" : "3306"} value={draft.port ?? ""} onChange={(e) => setDraft({ ...draft, port: e.target.value ? Number(e.target.value) : undefined })} />
              </Field>
              <Field label="数据库">
                <input className="input" value={draft.database ?? ""} onChange={(e) => setDraft({ ...draft, database: e.target.value })} />
              </Field>
              <Field label="用户名">
                <input className="input" value={draft.username ?? ""} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
              </Field>
              <Field label="密码环境变量名">
                <input className="input" placeholder="APP_DB_PASSWORD" value={draft.passwordEnv ?? ""} onChange={(e) => setDraft({ ...draft, passwordEnv: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="最大返回行数">
            <input className="input" type="number" min={1} max={1000} value={draft.maxRows ?? 200} onChange={(e) => setDraft({ ...draft, maxRows: Number(e.target.value) || 200 })} />
          </Field>
        </div>
      </div>
      <div className="log-system-card__actions">
        <button className="btn btn--secondary" onClick={test} disabled={busy}>{busy ? "测试中..." : "连接测试"}</button>
        <button className="btn btn--primary" onClick={save} disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        <button className="btn btn--danger" onClick={remove}>删除</button>
      </div>
    </div>
  );
}

function DbNewForm({
  notify,
  onSaved,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onSaved: (systems: DatabaseBackend[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<DatabaseBackend>({
    id: `db-${Date.now()}`,
    type: "database",
    name: "业务库",
    enabled: true,
    dialect: "sqlite" as DatabaseDialect,
    host: "server/data/infrapilot.db",
    readonly: true,
    maxRows: 200,
  });

  const save = async () => {
    if (!form.name || !form.host) {
      notify("请填写名称与路径/主机");
      return;
    }
    const res = await upsertDatabaseSystem(form, (err) => notify(err.message));
    if (res) {
      onSaved(res.systems);
      notify("数据库数据源已创建", "success");
      setForm({ ...form, id: `db-${Date.now()}` });
      setOpen(false);
    }
  };

  return (
    <div className="ds-inline-form">
      {!open ? (
        <button className="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>+ 新增数据库数据源</button>
      ) : (
        <>
          <div className="form-grid form-grid--3">
            <Field label="名称">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="类型">
              <select className="input" value={form.dialect} onChange={(e) => setForm({ ...form, dialect: e.target.value as DatabaseDialect })}>
                <option value="sqlite">SQLite（直接查询）</option>
                <option value="mysql">MySQL</option>
                <option value="mariadb">MariaDB（MySQL 协议兼容）</option>
                <option value="postgres">PostgreSQL</option>
                <option value="clickhouse">ClickHouse（驱动待接入）</option>
                <option value="elasticsearch">Elasticsearch（驱动待接入）</option>
              </select>
            </Field>
            <Field label={form.dialect === "sqlite" ? "数据库文件路径" : "主机"}>
              <input className="input" placeholder={form.dialect === "sqlite" ? "server/data/infrapilot.db" : "10.0.0.1"} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </Field>
          </div>
          <div className="ds-query-actions">
            <button className="btn btn--primary btn--sm" onClick={save}>创建</button>
            <button className="btn btn--secondary btn--sm" onClick={() => setOpen(false)}>取消</button>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================ //

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <div className="empty-state__message">{message}</div>
    </div>
  );
}
