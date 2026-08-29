import { useEffect, useRef, useState } from "react";
import {
  deleteHost,
  deleteLogSystem,
  deleteMemory,
  fetchHosts,
  fetchLogSystems,
  fetchLlmProviders,
  fetchMcpConfig,
  fetchMemoryConfig,
  fetchShipStatus,
  generateMcpSecret,
  listMemories,
  saveHost,
  testHost,
  testLogSystem,
  updateMcpConfig,
  updateMemoryConfig,
  upsertLogSystem,
  upsertLlmProvider,
  deleteLlmProvider,
  testLlmProvider,
  setDefaultLlmProvider,
  type HostEntry,
  type LogBackend,
  type LlmProvider,
  type LlmProviderType,
  type McpConfig,
  type MemoryConfig,
  type MemoryEntry,
  type ShipTargetStatus,
} from "../lib/api.js";
import { AppearanceSection } from "./settings/AppearanceSection.js";

const SECTIONS = [
  { id: "llm-providers", label: "模型配置" },
  { id: "log-systems", label: "日志系统后端" },
  { id: "remote-hosts", label: "远程主机" },
  { id: "mcp-agent", label: "MCP Agent" },
  { id: "memory-management", label: "记忆管理" },
  { id: "appearance", label: "外观" },
] as const;

export function SettingsPage({ notify }: { notify: (msg: string, type?: "error" | "success") => void }) {
  const [logSystems, setLogSystems] = useState<LogBackend[]>([]);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpConfig>({ serverPort: 8443, jwtSecret: "" });
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>({ enabled: true, recallTopK: 3 });
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    setLoading(true);
    const [l, h, p, m, memCfg, memList] = await Promise.all([
      fetchLogSystems((err) => notify(err.message)),
      fetchHosts((err) => notify(err.message)),
      fetchLlmProviders((err) => notify(err.message)),
      fetchMcpConfig((err) => notify(err.message)),
      fetchMemoryConfig((err) => notify(err.message)),
      listMemories((err) => notify(err.message)),
    ]);
    if (l) setLogSystems(l.systems);
    if (h) setHosts(h.hosts);
    if (p) setLlmProviders(p.providers);
    if (m) setMcpConfig(m);
    if (memCfg) setMemoryConfig(memCfg);
    if (memList) setMemories(memList.memories);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // 滚动时高亮当前章节
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleScroll = () => {
      const top = container.scrollTop + 80;
      for (let i = SECTIONS.length - 1; i >= 0; i--) {
        const el = document.getElementById(SECTIONS[i].id);
        if (el && el.offsetTop <= top) {
          setActiveSection(SECTIONS[i].id);
          break;
        }
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    const container = contentRef.current;
    if (!el || !container) return;
    container.scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
    setActiveSection(id);
  };

  const elkCount = logSystems.filter((s) => s.type === "elk").length;
  const chCount = logSystems.filter((s) => s.type === "clickhouse").length;
  const genericCount = logSystems.filter((s) => s.type === "generic").length;
  const llmEnabledCount = llmProviders.filter((p) => p.enabled).length;
  const llmDefaultName = llmProviders.find((p) => p.enabled && p.isDefault)?.name ?? "-";

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1 className="page-header__title">系统设置</h1>
        <p className="page-header__subtitle">管理大模型、日志系统后端、远程主机及其他运行时配置</p>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card__label">模型厂商</div>
          <div className="stat-card__value">{llmProviders.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">已启用模型</div>
          <div className="stat-card__value stat-card__value--success">{llmEnabledCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">默认模型</div>
          <div className="stat-card__value stat-card__value--accent">{llmDefaultName}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">ELK / ClickHouse / Generic</div>
          <div className="stat-card__value stat-card__value--info">
            {elkCount}/{chCount}/{genericCount}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">远程主机</div>
          <div className="stat-card__value stat-card__value--warning">{hosts.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">MCP 端口</div>
          <div className="stat-card__value stat-card__value--accent">{mcpConfig.serverPort}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__label">历史记忆</div>
          <div className="stat-card__value stat-card__value--info">{memories.length}</div>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav">
          <div className="settings-nav__title">设置项</div>
          <ul className="settings-nav__list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  className={["settings-nav__item", activeSection === s.id ? "settings-nav__item--active" : ""].filter(Boolean).join(" ")}
                  onClick={() => scrollTo(s.id)}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div ref={contentRef} className="settings-content">
          {loading ? (
            <Skeleton />
          ) : (
            <>
              <section id="llm-providers" className="settings-section card">
                <div className="settings-section__header">
                  <div>
                    <h3 className="settings-section__title">模型配置</h3>
                    <p className="settings-section__desc">配置各厂商 API Key 后，智能体即可调用对应的大语言模型。支持 OpenAI、DeepSeek、通义千问等主流提供商。</p>
                  </div>
                </div>
                <LlmConfigPanel providers={llmProviders} onChange={setLlmProviders} notify={notify} />
              </section>

              <section id="log-systems" className="settings-section card">
                <div className="settings-section__header">
                  <div>
                    <h3 className="settings-section__title">日志系统后端</h3>
                    <p className="settings-section__desc">配置 ELK / OpenSearch、ClickHouse 或 Generic HTTP 作为日志查询与采集目标。</p>
                  </div>
                  <AddLogSystemMenu notify={notify} onSaved={load} />
                </div>
                <div className="log-system-list">
                  {logSystems.length === 0 && <EmptyState icon="📦" message="暂无日志系统后端" />}
                  {logSystems.map((s) => (
                    <LogSystemCard
                      key={s.id}
                      system={s}
                      onChange={(next) => {
                        setLogSystems((prev) => prev.map((x) => (x.id === next.id ? next : x)));
                      }}
                      onSave={async (next) => {
                        const res = await upsertLogSystem(next, (err) => notify(err.message));
                        if (res) {
                          setLogSystems(res.systems);
                          notify("已保存", "success");
                        }
                      }}
                      onDelete={async (id) => {
                        const res = await deleteLogSystem(id, (err) => notify(err.message));
                        if (res) {
                          setLogSystems(res.systems);
                          notify("已删除", "success");
                        }
                      }}
                      onTest={async (id) => {
                        const res = await testLogSystem(id, (err) => notify(err.message));
                        if (res) {
                          notify(res.reachable ? "连接成功" : `连接失败：${res.error ?? ""}`, res.reachable ? "success" : "error");
                        }
                      }}
                    />
                  ))}
                </div>
              </section>

              <section id="remote-hosts" className="settings-section card">
                <div className="settings-section__header">
                  <div>
                    <h3 className="settings-section__title">远程主机</h3>
                    <p className="settings-section__desc">注册可通过 SSH 或 MCP Agent 访问的远程主机，供 Agent 执行只读诊断命令。</p>
                  </div>
                </div>
                <HostConfigPanel hosts={hosts} onChange={setHosts} notify={notify} />
              </section>

              <section id="mcp-agent" className="settings-section card">
                <div className="settings-section__header">
                  <div>
                    <h3 className="settings-section__title">MCP Agent</h3>
                    <p className="settings-section__desc">配置 MCP gRPC 服务端口与 JWT 签名密钥。密钥需与节点上的 linux-mcp-server 保持一致。</p>
                  </div>
                </div>
                <McpConfigPanel config={mcpConfig} onChange={setMcpConfig} notify={notify} />
              </section>

              <section id="memory-management" className="settings-section card">
                <div className="settings-section__header">
                  <div>
                    <h3 className="settings-section__title">记忆管理</h3>
                    <p className="settings-section__desc">管理跨会话记忆：会话结束时自动沉淀脱敏摘要，新建会话时召回相关历史记忆注入系统提示词。</p>
                  </div>
                </div>
                <MemoryPanel
                  config={memoryConfig}
                  onChange={setMemoryConfig}
                  memories={memories}
                  onMemoriesChange={setMemories}
                  notify={notify}
                />
              </section>

              <section id="appearance" className="settings-section card">
                <AppearanceSection />
              </section>

              <div className="settings-footer">
                <button className="btn btn--secondary btn--sm" onClick={() => contentRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>
                  返回顶部
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AddLogSystemMenu({
  notify,
  onSaved,
}: {
  notify: (msg: string, type?: "error" | "success") => void;
  onSaved: () => Promise<void>;
}) {
  const [type, setType] = useState<LogBackend["type"] | "">("");

  const create = async (t: LogBackend["type"]) => {
    const id = `${t}-${Date.now()}`;
    let system: LogBackend;
    if (t === "elk") {
      system = { id, type: "elk", name: "OpenSearch", enabled: true, node: "http://127.0.0.1:9200", targets: [] };
    } else if (t === "clickhouse") {
      system = { id, type: "clickhouse", name: "ClickHouse", enabled: true, host: "127.0.0.1", port: 8123, database: "logs", username: "default", table: "log_records" };
    } else {
      system = { id, type: "generic", name: "Generic API", enabled: true, url: "http://127.0.0.1:8080/query" };
    }
    const res = await upsertLogSystem(system, (err) => notify(err.message));
    if (res) {
      await onSaved();
      notify("日志后端已创建", "success");
    }
    setType("");
  };

  return (
    <div className="add-log-system">
      <select className="input input--sm" value={type} onChange={(e) => setType(e.target.value as any)}>
        <option value="">+ 新增日志后端</option>
        <option value="elk">ELK / OpenSearch</option>
        <option value="clickhouse">ClickHouse</option>
        <option value="generic">Generic HTTP</option>
      </select>
      {type && (
        <button className="btn btn--primary btn--sm" onClick={() => create(type as LogBackend["type"])}>
          创建
        </button>
      )}
    </div>
  );
}

function LogSystemCard({
  system,
  onChange,
  onSave,
  onDelete,
  onTest,
}: {
  system: LogBackend;
  onChange: (s: LogBackend) => void;
  onSave: (s: LogBackend) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [shipStatus, setShipStatus] = useState<ShipTargetStatus[] | null>(null);

  useEffect(() => {
    if (system.type !== "elk" || !system.id) return;
    let cancelled = false;
    const refresh = () => {
      fetchShipStatus(system.id, () => {}).then((res) => {
        if (!cancelled) setShipStatus(res?.statuses ?? null);
      });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [system.id, system.type]);

  const update = (patch: Partial<LogBackend>) => {
    onChange({ ...system, ...patch } as LogBackend);
  };

  const save = async () => {
    setSaving(true);
    await onSave(system);
    setSaving(false);
  };

  const test = async () => {
    setTesting(true);
    await onTest(system.id);
    setTesting(false);
  };

  const typeLabel = { elk: "ELK / OpenSearch", clickhouse: "ClickHouse", generic: "Generic HTTP" }[system.type];

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <input
            className="input input--inline log-system-card__name"
            value={system.name}
            onChange={(e) => update({ name: e.target.value })}
          />
          <span className="tag">{typeLabel}</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={system.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span className="toggle__track" />
          <span className="toggle__label">{system.enabled ? "启用" : "禁用"}</span>
        </label>
      </div>

      <div className="log-system-card__body">
        {system.type === "elk" && (
          <>
            <div className="form-grid">
              <Field label="节点地址">
                <input className="input" placeholder="http://127.0.0.1:9200" value={system.node} onChange={(e) => update({ node: e.target.value } as Partial<LogBackend>)} />
              </Field>
              <Field label="用户名（可选）">
                <input className="input" placeholder="可选" value={system.username ?? ""} onChange={(e) => update({ username: e.target.value } as Partial<LogBackend>)} />
              </Field>
              <Field label="密码环境变量名（可选）">
                <input className="input" placeholder="如 OPENSEARCH_PASSWORD" value={system.passwordEnv ?? ""} onChange={(e) => update({ passwordEnv: e.target.value } as Partial<LogBackend>)} />
              </Field>
              <Field label="跳过 TLS 验证">
                <label className="checkbox">
                  <input type="checkbox" checked={system.skipTlsVerify ?? false} onChange={(e) => update({ skipTlsVerify: e.target.checked } as Partial<LogBackend>)} />
                  <span>本地/沙箱环境启用</span>
                </label>
              </Field>
            </div>
            <div className="log-system-card__targets">
              <div className="log-system-card__targets-title">采集目标</div>
              {system.targets.map((t, idx) => (
                <div key={idx} className="log-target-row">
                  <input className="input input--sm" placeholder="namespace" value={t.namespace} onChange={(e) => {
                    const targets = [...system.targets];
                    targets[idx] = { ...t, namespace: e.target.value };
                    update({ targets } as Partial<LogBackend>);
                  }} />
                  <input className="input input--sm" placeholder="pod prefix" value={t.podNamePrefix} onChange={(e) => {
                    const targets = [...system.targets];
                    targets[idx] = { ...t, podNamePrefix: e.target.value };
                    update({ targets } as Partial<LogBackend>);
                  }} />
                  <input className="input input--sm" placeholder="index prefix" value={t.indexPrefix} onChange={(e) => {
                    const targets = [...system.targets];
                    targets[idx] = { ...t, indexPrefix: e.target.value };
                    update({ targets } as Partial<LogBackend>);
                  }} />
                  <button className="btn btn--sm btn--danger" onClick={() => {
                    const targets = system.targets.filter((_, i) => i !== idx);
                    update({ targets } as Partial<LogBackend>);
                  }}>删除</button>
                </div>
              ))}
              <button className="btn btn--sm btn--secondary" onClick={() => update({ targets: [...system.targets, { namespace: "", podNamePrefix: "", indexPrefix: "" }] } as Partial<LogBackend>)}>
                + 添加目标
              </button>
            </div>
            <div className="log-system-card__status">
              <div className="log-system-card__targets-title">采集状态</div>
              {shipStatus === null ? (
                <span className="ship-status__hint">尚未获取</span>
              ) : shipStatus.length === 0 ? (
                <span className="ship-status__hint">该后端未配置采集目标</span>
              ) : (
                shipStatus.map((s) => {
                  const failed = Boolean(s.lastError);
                  return (
                    <div key={`${s.target.namespace}|${s.target.podNamePrefix}|${s.target.indexPrefix}`} className="ship-status__row">
                      <span className={`ship-status__dot ${failed ? "ship-status__dot--error" : s.fileCount > 0 ? "ship-status__dot--ok" : "ship-status__dot--idle"}`} />
                      <span className="ship-status__target">
                        {s.target.namespace}/{s.target.podNamePrefix || "(全部)"} → {s.target.indexPrefix}
                      </span>
                      <span className="ship-status__meta">
                        文件 {s.fileCount} · 上次 {s.lastShippedCount} 行 · 累计 {s.totalShipped} 行
                        {s.lastShippedAt ? ` · ${new Date(s.lastShippedAt).toLocaleTimeString()}` : ""}
                      </span>
                      {failed ? (
                        <span className="ship-status__error">错误: {s.lastError}</span>
                      ) : s.warning ? (
                        <span className="ship-status__warning">{s.warning}</span>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {system.type === "clickhouse" && (
          <div className="form-grid form-grid--3">
            <Field label="主机">
              <input className="input" placeholder="127.0.0.1" value={system.host} onChange={(e) => update({ host: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="端口">
              <input className="input" placeholder="8123" value={system.port ?? 8123} onChange={(e) => update({ port: Number(e.target.value) } as Partial<LogBackend>)} />
            </Field>
            <Field label="数据库">
              <input className="input" placeholder="logs" value={system.database} onChange={(e) => update({ database: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="用户名">
              <input className="input" placeholder="default" value={system.username} onChange={(e) => update({ username: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="密码环境变量名（可选）">
              <input className="input" placeholder="如 CLICKHOUSE_PASSWORD" value={system.passwordEnv ?? ""} onChange={(e) => update({ passwordEnv: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="日志表">
              <input className="input" placeholder="log_records" value={system.table} onChange={(e) => update({ table: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="时间字段（可选）">
              <input className="input" placeholder="timestamp" value={system.timestampColumn ?? ""} onChange={(e) => update({ timestampColumn: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="消息字段（可选）">
              <input className="input" placeholder="message" value={system.messageColumn ?? ""} onChange={(e) => update({ messageColumn: e.target.value } as Partial<LogBackend>)} />
            </Field>
          </div>
        )}

        {system.type === "generic" && (
          <div className="form-grid">
            <Field label="查询 URL">
              <input className="input" placeholder="http://127.0.0.1:8080/query" value={system.url} onChange={(e) => update({ url: e.target.value } as Partial<LogBackend>)} />
            </Field>
            <Field label="Query 模板（可选）">
              <textarea className="input textarea" placeholder="支持 {query} 占位符" value={system.queryTemplate ?? ""} onChange={(e) => update({ queryTemplate: e.target.value } as Partial<LogBackend>)} rows={2} />
            </Field>
          </div>
        )}
      </div>

      <div className="log-system-card__actions">
        <button className="btn btn--secondary" onClick={test} disabled={testing}>{testing ? "测试中..." : "连接测试"}</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? "保存中..." : "保存"}</button>
        <button className="btn btn--danger" onClick={() => onDelete(system.id)}>删除</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

function HostConfigPanel({
  hosts,
  onChange,
  notify,
}: {
  hosts: HostEntry[];
  onChange: (hosts: HostEntry[]) => void;
  notify: (msg: string, type?: "error" | "success") => void;
}) {
  const [editing, setEditing] = useState<HostEntry | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [form, setForm] = useState<HostEntry>({
    name: "",
    hostname: "",
    port: 22,
    username: "",
    auth: { type: "password", passwordEnv: "" },
  });

  const resetForm = () => {
    setEditing(null);
    setForm({ name: "", hostname: "", port: 22, username: "", auth: { type: "password", passwordEnv: "" } });
  };

  const save = async () => {
    if (!form.name) {
      notify("请填写主机别名");
      return;
    }
    if (form.auth.type !== "mcp" && (!form.hostname || !form.username)) {
      notify("SSH 主机需要填写地址和用户名");
      return;
    }
    if (form.auth.type === "mcp" && !(form.auth as any).endpoint) {
      notify("MCP 主机需要填写 gRPC endpoint");
      return;
    }
    const entry: HostEntry = { ...form, port: form.port ?? 22 };
    const res = await saveHost(entry, (err) => notify(err.message));
    if (res) {
      onChange(res.hosts);
      resetForm();
      notify("主机已保存", "success");
    }
  };

  const startEdit = (h: HostEntry) => {
    setEditing(h);
    setForm({ ...h });
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`确定删除主机 ${name} 吗？`)) return;
    const res = await deleteHost(name, (err) => notify(err.message));
    if (res) {
      onChange(res.hosts);
      notify("主机已删除", "success");
    }
  };

  const handleTest = async (name: string) => {
    setTesting(name);
    const res = await testHost(name, (err) => notify(err.message));
    setTesting(null);
    if (res) {
      notify(res.reachable ? `主机 ${name} 连接成功` : `主机 ${name} 连接失败：${res.error || ""}`, res.reachable ? "success" : "error");
    }
  };

  const setAuth = (patch: Partial<HostEntry["auth"]>) => {
    setForm({ ...form, auth: { ...form.auth, ...patch } as HostEntry["auth"] });
  };

  return (
    <div className="host-config-panel">
      <div className="host-list">
        {hosts.length === 0 && <EmptyState icon="🖥️" message="暂无远程主机" />}
        {hosts.map((h) => (
          <div key={h.name} className="host-card">
            <div className="host-card__info">
              <span className="host-card__name">{h.name}</span>
              {h.auth.type === "mcp" ? (
                <span className="host-card__addr">{(h.auth as any).endpoint ?? "未配置 endpoint"}</span>
              ) : (
                <span className="host-card__addr">{h.hostname}:{h.port ?? 22}</span>
              )}
              <span className="host-card__meta">认证: {h.auth.type}{h.auth.type !== "mcp" && ` / 用户: ${h.username}`}</span>
            </div>
            <div className="host-card__actions">
              <button className="btn btn--sm btn--secondary" onClick={() => startEdit(h)}>编辑</button>
              <button className="btn btn--sm btn--secondary" onClick={() => handleTest(h.name)} disabled={testing === h.name}>
                {testing === h.name ? "测试中..." : "连接测试"}
              </button>
              <button className="btn btn--sm btn--danger" onClick={() => handleDelete(h.name)}>删除</button>
            </div>
          </div>
        ))}
      </div>

      <div className="host-form card">
        <h4>{editing ? "编辑主机" : "新增主机"}</h4>
        <div className="host-form__grid">
          <Field label="别名">
            <input className="input" placeholder="如 node-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!!editing} />
          </Field>
          <Field label="地址 (IP 或域名)">
            <input className="input" placeholder="10.0.0.1" value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} />
          </Field>
          <Field label="端口">
            <input className="input" type="number" placeholder="22" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
          </Field>
          <Field label="用户名">
            <input className="input" placeholder="root" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
          <Field label="认证方式">
            <select className="input" value={form.auth.type} onChange={(e) => setForm({ ...form, auth: { type: e.target.value as any } })}>
              <option value="password">密码</option>
              <option value="privateKey">私钥</option>
              <option value="agent">SSH Agent</option>
              <option value="mcp">MCP Agent (gRPC)</option>
            </select>
          </Field>
          {form.auth.type === "mcp" && (
            <Field label="MCP gRPC Endpoint">
              <input className="input" placeholder="如 10.0.0.1:8443" value={(form.auth as any).endpoint ?? ""} onChange={(e) => setAuth({ endpoint: e.target.value })} />
            </Field>
          )}
          {form.auth.type === "password" && (
            <>
              <Field label="密码（生产环境建议用环境变量）">
                <input className="input" type="password" placeholder="输入 SSH 密码" value={(form.auth as any).password ?? ""} onChange={(e) => setAuth({ password: e.target.value })} />
              </Field>
              <Field label="或 密码环境变量名">
                <input className="input" placeholder="如 NODE1_SSH_PASSWORD" value={(form.auth as any).passwordEnv ?? ""} onChange={(e) => setAuth({ passwordEnv: e.target.value })} />
              </Field>
            </>
          )}
          {form.auth.type === "privateKey" && (
            <>
              <Field label="私钥内容（推荐：生产环境使用文件路径或环境变量）">
                <textarea
                  className="input textarea"
                  rows={5}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                  value={(form.auth as any).privateKey ?? ""}
                  onChange={(e) => setAuth({ privateKey: e.target.value })}
                />
              </Field>
              <Field label="或 私钥文件路径">
                <input className="input" placeholder="/root/.ssh/id_rsa" value={(form.auth as any).privateKeyPath ?? ""} onChange={(e) => setAuth({ privateKeyPath: e.target.value })} />
              </Field>
              <Field label="或 私钥环境变量名">
                <input className="input" placeholder="如 NODE1_SSH_KEY" value={(form.auth as any).privateKeyEnv ?? ""} onChange={(e) => setAuth({ privateKeyEnv: e.target.value })} />
              </Field>
              <Field label="Passphrase（可选）">
                <input className="input" type="password" placeholder="私钥口令" value={(form.auth as any).passphrase ?? ""} onChange={(e) => setAuth({ passphrase: e.target.value })} />
              </Field>
              <Field label="或 Passphrase 环境变量名（可选）">
                <input className="input" placeholder="如 NODE1_SSH_PASSPHRASE" value={(form.auth as any).passphraseEnv ?? ""} onChange={(e) => setAuth({ passphraseEnv: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <div className="host-form__actions">
          {editing && <button className="btn btn--secondary" onClick={resetForm}>取消</button>}
          <button className="btn btn--primary" onClick={save}>{editing ? "保存修改" : "添加主机"}</button>
        </div>
      </div>
    </div>
  );
}

function McpConfigPanel({
  config,
  onChange,
  notify,
}: {
  config: McpConfig;
  onChange: (c: McpConfig) => void;
  notify: (msg: string, type?: "error" | "success") => void;
}) {
  const [form, setForm] = useState<McpConfig>(config);

  useEffect(() => {
    setForm(config);
  }, [config]);

  const save = async () => {
    const res = await updateMcpConfig(form, (err) => notify(err.message));
    if (res) {
      onChange(form);
      notify("MCP 配置已保存", "success");
    }
  };

  const genSecret = async () => {
    const res = await generateMcpSecret((err) => notify(err.message));
    if (res) {
      setForm({ ...form, jwtSecret: res.secret });
    }
  };

  return (
    <div className="mcp-config">
      <Field label="gRPC 服务端口">
        <input
          className="input"
          type="number"
          value={form.serverPort}
          onChange={(e) => setForm({ ...form, serverPort: Number(e.target.value) })}
        />
      </Field>
      <Field label="MCP JWT Secret">
        <textarea
          className="input textarea"
          rows={3}
          placeholder="至少 32 字节的随机字符串"
          value={form.jwtSecret}
          onChange={(e) => setForm({ ...form, jwtSecret: e.target.value })}
        />
      </Field>
      <div className="mcp-config__actions">
        <button className="btn btn--secondary btn--sm" onClick={genSecret}>
          生成随机密钥
        </button>
        <button className="btn btn--primary btn--sm" onClick={save}>
          保存 MCP 配置
        </button>
      </div>
      <div className="settings-hint">
        <strong>安全提示：</strong>JWT Secret 用于 InfraPilot 后端与节点上的 linux-mcp-server 双向认证。
        本地/沙箱环境可在此填写；生产环境请通过环境变量 <code>MCP_JWT_SECRET</code> 或 K8s Secret 注入，避免明文落盘。
      </div>
    </div>
  );
}

function MemoryPanel({
  config,
  onChange,
  memories,
  onMemoriesChange,
  notify,
}: {
  config: MemoryConfig;
  onChange: (c: MemoryConfig) => void;
  memories: MemoryEntry[];
  onMemoriesChange: (m: MemoryEntry[]) => void;
  notify: (msg: string, type?: "error" | "success") => void;
}) {
  const [form, setForm] = useState<MemoryConfig>(config);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(config);
  }, [config]);

  const save = async () => {
    setSaving(true);
    const res = await updateMemoryConfig(form, (err) => notify(err.message));
    if (res) {
      onChange(res);
      notify("记忆配置已保存", "success");
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除这条历史记忆吗？")) return;
    const res = await deleteMemory(id, (err) => notify(err.message));
    if (res) {
      onMemoriesChange(memories.filter((m) => m.id !== id));
      notify("已删除", "success");
    }
  };

  const clampTopK = (value: number) => Math.max(1, Math.min(10, value));

  return (
    <div className="memory-panel">
      <div className="memory-config card">
        <h4>召回配置</h4>
        <div className="memory-config__fields">
          <label className="toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span className="toggle__track" />
            <span className="toggle__label">启用跨会话记忆召回</span>
          </label>
          <Field label="召回条数 (Top-K)">
            <input
              className="input input--sm"
              type="number"
              min={1}
              max={10}
              value={form.recallTopK}
              onChange={(e) => setForm({ ...form, recallTopK: clampTopK(Number(e.target.value)) })}
              onBlur={save}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </Field>
        </div>
        <div className="memory-config__actions">
          <button className="btn btn--primary btn--sm" onClick={save} disabled={saving}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>

      <div className="memory-list">
        <h4>记忆列表</h4>
        {memories.length === 0 && <EmptyState icon="🧠" message="暂无历史记忆" />}
        {memories.map((m) => (
          <div key={m.id} className="memory-card">
            <div className="memory-card__header">
              <div className="memory-card__title">{m.title}</div>
              <button className="btn btn--sm btn--danger" onClick={() => handleDelete(m.id)}>删除</button>
            </div>
            <div className="memory-card__summary">{m.summary}</div>
            <div className="memory-card__meta">
              <span>创建于 {new Date(m.createdAt).toLocaleString()}</span>
              {m.tags && m.tags.length > 0 && <span className="tag">{m.tags.join(", ")}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const PROVIDER_PRESETS: { type: LlmProviderType; name: string; baseURL: string; models: string; recommendedModel: string }[] = [
  { type: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", models: "GPT-4o / GPT-4 / GPT-3.5 系列", recommendedModel: "gpt-4o" },
  { type: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", models: "DeepSeek V3 / V2.5 / Coder", recommendedModel: "deepseek-chat" },
  { type: "qwen", name: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: "Qwen-Plus / Qwen-Max / Qwen-Turbo", recommendedModel: "qwen-plus" },
  { type: "glm", name: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: "GLM-4 / GLM-4-Flash / GLM-4-Air", recommendedModel: "glm-4" },
  { type: "moonshot", name: "Moonshot", baseURL: "https://api.moonshot.cn/v1", models: "Moonshot v1 系列", recommendedModel: "moonshot-v1-8k" },
  { type: "anthropic", name: "Anthropic Claude", baseURL: "https://api.anthropic.com/v1", models: "Claude 3.5 Sonnet / Opus / Haiku", recommendedModel: "claude-3-5-sonnet-20241022" },
  { type: "google", name: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", models: "Gemini 1.5 Pro / Flash", recommendedModel: "gemini-1.5-pro" },
];

function providerIcon(type: LlmProviderType): string {
  const map: Record<string, string> = {
    openai: "🤖",
    deepseek: "🔎",
    qwen: "☁️",
    glm: "🧠",
    moonshot: "🌙",
    minimax: "Ⓜ️",
    baichuan: "🌊",
    anthropic: "🅰️",
    google: "🌐",
    generic: "🔧",
  };
  return map[type] || "🔧";
}

function providerConfigured(p: LlmProvider): boolean {
  return p.enabled && !!p.apiKey && !!p.baseURL && !!p.recommendedModel;
}

function maskKey(key?: string): string {
  if (!key) return "未设置";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function LlmConfigPanel({
  providers,
  onChange,
  notify,
}: {
  providers: LlmProvider[];
  onChange: (providers: LlmProvider[]) => void;
  notify: (msg: string, type?: "error" | "success") => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [addType, setAddType] = useState<LlmProviderType>("openai");

  const editing = editingId ? providers.find((p) => p.id === editingId) : undefined;

  const saveProvider = async (provider: LlmProvider) => {
    const res = await upsertLlmProvider(provider, (err) => notify(err.message));
    if (res) {
      onChange(res.providers);
      setEditingId(null);
      setIsAdding(false);
      notify("模型配置已保存", "success");
    }
  };

  const toggleEnabled = async (provider: LlmProvider) => {
    await saveProvider({ ...provider, enabled: !provider.enabled });
  };

  const setDefault = async (id: string) => {
    const res = await setDefaultLlmProvider(id, (err) => notify(err.message));
    if (res) {
      onChange(res.providers);
      notify("默认模型已切换", "success");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除该模型配置吗？")) return;
    const res = await deleteLlmProvider(id, (err) => notify(err.message));
    if (res) {
      onChange(res.providers);
      notify("已删除", "success");
    }
  };

  const handleTest = async (id: string) => {
    const res = await testLlmProvider(id, (err) => notify(err.message));
    if (res) {
      notify(res.reachable ? "连接成功" : `连接失败：${res.error ?? ""}`, res.reachable ? "success" : "error");
    }
  };

  return (
    <div className="llm-config">
      <div className="llm-provider-grid">
        {providers.map((p) => (
          <div key={p.id} className={["llm-provider-card", p.isDefault ? "llm-provider-card--default" : "", p.enabled ? "" : "llm-provider-card--disabled"].filter(Boolean).join(" ")}>
            <div className="llm-provider-card__header">
              <div className="llm-provider-card__icon">{providerIcon(p.type)}</div>
              <div className="llm-provider-card__title">
                <div className="llm-provider-card__name">{p.name}</div>
                <div className="llm-provider-card__type">{p.type}</div>
              </div>
              <div className="llm-provider-card__status">
                {p.isDefault && <span className="badge badge--primary">默认模型</span>}
                {providerConfigured(p) ? (
                  <span className="badge badge--success">已配置</span>
                ) : (
                  <span className="badge badge--muted">未配置</span>
                )}
              </div>
            </div>

            <div className="llm-provider-card__body">
              <div className="llm-provider-card__models">{p.models}</div>
              <div className="llm-provider-card__detail">
                <span>推荐模型: <code>{p.recommendedModel || "-"}</code></span>
                <span>API 地址: <code>{p.baseURL}</code></span>
                <span>API Key: <code>{maskKey(p.apiKey)}</code></span>
              </div>
            </div>

            <div className="llm-provider-card__footer">
              <label className="toggle toggle--sm">
                <input type="checkbox" checked={p.enabled} onChange={() => toggleEnabled(p)} />
                <span className="toggle__track" />
                <span className="toggle__label">{p.enabled ? "已启用" : "已禁用"}</span>
              </label>
              <div className="llm-provider-card__actions">
                <button className="btn btn--ghost btn--sm" onClick={() => setEditingId(p.id)}>配置</button>
                <button className="btn btn--ghost btn--sm" onClick={() => handleTest(p.id)}>测试</button>
                {!p.isDefault && p.enabled && (
                  <button className="btn btn--ghost btn--sm" onClick={() => setDefault(p.id)}>设为默认</button>
                )}
                <button className="btn btn--ghost btn--sm btn--danger" onClick={() => handleDelete(p.id)}>删除</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {!isAdding && !editing && (
        <div className="llm-add">
          <select className="input input--sm" value={addType} onChange={(e) => setAddType(e.target.value as LlmProviderType)}>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.type} value={p.type}>{p.name}</option>
            ))}
          </select>
          <button className="btn btn--primary btn--sm" onClick={() => setIsAdding(true)}>+ 添加模型</button>
        </div>
      )}

      {(isAdding || editing) && (
        <LlmProviderForm
          key={editing?.id ?? "new"}
          initial={editing ?? PROVIDER_PRESETS.find((p) => p.type === addType)!}
          onSave={saveProvider}
          onCancel={() => {
            setIsAdding(false);
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

function LlmProviderForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Partial<LlmProvider>;
  onSave: (p: LlmProvider) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<LlmProvider>({
    id: initial.id ?? initial.type ?? "generic",
    type: initial.type ?? "generic",
    name: initial.name ?? "",
    enabled: initial.enabled ?? false,
    isDefault: initial.isDefault ?? false,
    baseURL: initial.baseURL ?? "",
    apiKey: initial.apiKey ?? "",
    models: initial.models ?? "",
    recommendedModel: initial.recommendedModel ?? "",
  });

  return (
    <div className="llm-provider-form card">
      <h4>{initial.id ? "编辑模型配置" : "新增模型配置"}</h4>
      <div className="llm-provider-form__grid">
        <Field label="显示名称">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="厂商类型">
          <select className="input" value={form.type} onChange={(e) => {
            const type = e.target.value as LlmProviderType;
            const preset = PROVIDER_PRESETS.find((p) => p.type === type);
            if (preset) {
              setForm({ ...form, id: type, type, baseURL: preset.baseURL, models: preset.models, recommendedModel: preset.recommendedModel });
            } else {
              setForm({ ...form, id: type, type });
            }
          }}>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.type} value={p.type}>{p.name}</option>
            ))}
            <option value="generic">自定义 (Generic)</option>
          </select>
        </Field>
        <Field label="推荐模型">
          <input className="input" placeholder="gpt-4o" value={form.recommendedModel} onChange={(e) => setForm({ ...form, recommendedModel: e.target.value })} />
        </Field>
        <Field label="模型系列描述">
          <input className="input" value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />
        </Field>
        <Field label="API Base URL">
          <input className="input" value={form.baseURL} onChange={(e) => setForm({ ...form, baseURL: e.target.value })} />
        </Field>
        <Field label="API Key">
          <input className="input" type="password" placeholder="sk-..." value={form.apiKey ?? ""} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <span className="field__hint">将保存在后端 runtime-config.json 中，生产环境建议使用 K8s Secret</span>
        </Field>
      </div>
      <div className="llm-provider-form__actions">
        <button className="btn btn--secondary" onClick={onCancel}>取消</button>
        <button className="btn btn--primary" onClick={() => onSave(form)}>保存</button>
      </div>
    </div>
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

function Skeleton() {
  return (
    <div className="skeleton-list">
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
    </div>
  );
}
