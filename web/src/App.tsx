import { useEffect, useMemo, useRef, useState } from "react";
import "./styles/app.css";
import type { TimelineEvent, SessionSummary, ElkConfig, ElkTarget, HostRegistry, HostEntry } from "./lib/types";

const API_BASE = "/api";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function statusText(status: string) {
  const map: Record<string, string> = {
    intake: "待输入",
    planning: "分析中",
    executing: "执行中",
    awaiting_approval: "待审批",
    reflecting: "反思中",
    concluded: "已结论",
    remediating: "修复中",
    closed: "已终止",
  };
  return map[status] ?? status;
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"context" | "elk" | "hosts">("context");
  const [podState, setPodState] = useState<any>(null);
  const [elkConfig, setElkConfig] = useState<ElkConfig>({ node: "", targets: [] });
  const [hostRegistry, setHostRegistry] = useState<HostRegistry>({ hosts: [] });
  const [search, setSearch] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }, [sessions, search]);

  async function refreshSessions() {
    try {
      const res = await fetch(`${API_BASE}/sessions`);
      const list = (await res.json()) as SessionSummary[];
      setSessions(list);
    } catch {
      // ignore
    }
  }

  async function refreshConfig() {
    try {
      const [elkRes, hostsRes] = await Promise.all([fetch(`${API_BASE}/config/elk`), fetch(`${API_BASE}/config/hosts`)]);
      setElkConfig((await elkRes.json()) as ElkConfig);
      setHostRegistry((await hostsRes.json()) as HostRegistry);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refreshSessions();
    refreshConfig();
    const t = setInterval(refreshSessions, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      fetch(`${API_BASE}/demo/pod-state`)
        .then((r) => r.json())
        .then(setPodState)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  function connectWs(id: string) {
    if (wsRef.current) {
      wsRef.current.close();
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?sessionId=${id}`);
    ws.onmessage = (msg) => {
      const ev: TimelineEvent = JSON.parse(msg.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "done" || ev.type === "approval_request" || ev.type === "status") {
        refreshSessions();
      }
    };
    ws.onclose = () => {
      // 自动重连一次
      setTimeout(() => connectWs(id), 1500);
    };
    wsRef.current = ws;
  }

  async function startSession() {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "故障排查会话" }),
      });
      const session = (await res.json()) as SessionSummary;
      setSessionId(session.id);
      setEvents([]);
      connectWs(session.id);
      await refreshSessions();
    } finally {
      setIsLoading(false);
    }
  }

  async function selectSession(id: string) {
    setSessionId(id);
    setEvents([]);
    connectWs(id);
    try {
      const res = await fetch(`${API_BASE}/sessions/${id}`);
      const session = await res.json();
      // 将已有会话的关键状态作为伪事件展示,帮助用户快速理解上下文
      const seed: TimelineEvent[] = [];
      if (session.incidentSummary) {
        seed.push({
          id: generateId(),
          sessionId: id,
          type: "status",
          timestamp: session.createdAt,
          payload: { message: `事件摘要: ${session.incidentSummary}` },
        });
      }
      if (session.executedToolCalls?.length > 0) {
        for (const tc of session.executedToolCalls) {
          seed.push({
            id: generateId(),
            sessionId: id,
            type: "tool_call_result",
            timestamp: tc.finishedAt,
            payload: { skill: tc.skill, tool: tc.tool, result: tc.result },
          });
        }
      }
      if (session.rootCause?.summary) {
        seed.push({
          id: generateId(),
          sessionId: id,
          type: "assistant_message",
          timestamp: session.updatedAt,
          payload: { content: `【根因分析结论】${session.rootCause.summary}` },
        });
      }
      setEvents(seed);
    } catch {
      // ignore
    }
  }

  async function terminateSession(id: string) {
    if (!confirm("确定要终止该会话吗?")) return;
    try {
      await fetch(`${API_BASE}/sessions/${id}`, { method: "DELETE" });
      if (sessionId === id) {
        setSessionId(null);
        setEvents([]);
        wsRef.current?.close();
        wsRef.current = null;
      }
      await refreshSessions();
    } catch {
      // ignore
    }
  }

  async function sendMessage() {
    if (!sessionId || !input.trim()) return;
    const message = input.trim();
    setInput("");
    setEvents((prev) => [
      ...prev,
      { id: generateId(), sessionId, type: "user_message", timestamp: new Date().toISOString(), payload: { content: message } },
    ]);
    setIsLoading(true);
    try {
      await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function decideApproval(approvalId: string, approved: boolean) {
    await fetch(`${API_BASE}/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved, approvedBy: "demo-user@company.com" }),
    });
  }

  async function resetDemo() {
    await fetch(`${API_BASE}/demo/restart-scenario`, { method: "POST" });
  }

  async function addElkTarget(target: ElkTarget) {
    try {
      const res = await fetch(`${API_BASE}/config/elk/targets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });
      if (res.ok) setElkConfig((prev) => ({ ...prev, targets: [...prev.targets, target] }));
    } catch {
      // ignore
    }
  }

  async function saveHost(host: HostEntry) {
    try {
      const res = await fetch(`${API_BASE}/config/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(host),
      });
      if (res.ok) {
        const data = (await res.json()) as HostRegistry;
        setHostRegistry(data);
      }
    } catch {
      // ignore
    }
  }

  async function deleteHost(name: string) {
    try {
      const res = await fetch(`${API_BASE}/config/hosts/${name}`, { method: "DELETE" });
      if (res.ok) {
        const data = (await res.json()) as HostRegistry;
        setHostRegistry(data);
      }
    } catch {
      // ignore
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          <span>InfraPilot Agent</span>
        </div>
        <div className="topbar-actions">
          <button className="btn primary" onClick={startSession} disabled={isLoading}>
            {isLoading ? "创建中..." : "+ 新建排查会话"}
          </button>
          <button className="btn ghost" onClick={resetDemo}>重置演示场景</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="section-title">会话历史</div>
            <input
              className="search-input"
              placeholder="搜索会话..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="session-list">
            {filteredSessions.map((s) => (
              <div
                key={s.id}
                className={`session-card ${s.id === sessionId ? "active" : ""} status-${s.status}`}
                onClick={() => selectSession(s.id)}
              >
                <div className="session-title">{s.title}</div>
                <div className="session-meta">
                  <span className="status-pill">{statusText(s.status)}</span>
                  <span className="time">{formatTime(s.updated_at)}</span>
                </div>
                {s.id === sessionId && (
                  <button
                    className="session-terminate"
                    onClick={(e) => {
                      e.stopPropagation();
                      terminateSession(s.id);
                    }}
                    title="终止会话"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {filteredSessions.length === 0 && <div className="empty-hint">暂无会话</div>}
          </div>
        </aside>

        <main className="timeline-panel">
          {!sessionId && (
            <div className="empty-state">
              <div className="empty-illustration">
                <div className="orbit" />
                <div className="planet" />
              </div>
              <h2>开始一次故障排查</h2>
              <p>点击右上角「新建排查会话」,或从历史会话中选择继续。</p>
              <div className="hint-cards">
                <div className="hint-card">"生产环境 order-api 一直重启"</div>
                <div className="hint-card">"帮我查一下 MySQL 磁盘为什么满了"</div>
                <div className="hint-card">"ELK 最近 ERROR 日志有什么异常"</div>
              </div>
            </div>
          )}
          {sessionId && (
            <>
              <div className="timeline" ref={scrollRef}>
                {events.map((ev) => (
                  <EventCard key={ev.id} event={ev} onDecide={decideApproval} />
                ))}
                {isLoading && events.length > 0 && events[events.length - 1].type === "user_message" && (
                  <div className="typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
              <div className="composer">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  placeholder="描述你遇到的故障现象..."
                  disabled={!sessionId}
                />
                <button className="btn primary" onClick={sendMessage} disabled={!input.trim()}>
                  发送
                </button>
              </div>
            </>
          )}
        </main>

        <aside className="context-panel">
          <div className="tabs">
            <button className={activeTab === "context" ? "active" : ""} onClick={() => setActiveTab("context")}>
              上下文
            </button>
            <button className={activeTab === "elk" ? "active" : ""} onClick={() => setActiveTab("elk")}>
              ELK 配置
            </button>
            <button className={activeTab === "hosts" ? "active" : ""} onClick={() => setActiveTab("hosts")}>
              主机配置
            </button>
          </div>

          {activeTab === "context" && (
            <div className="panel-content">
              {podState ? (
                <div className="pod-card">
                  <div className="pod-header">
                    <span className={`status-dot ${podState.status === "Running" ? "ok" : podState.status === "CrashLoopBackOff" ? "bad" : "warn"}`} />
                    <strong>{podState.podName}</strong>
                  </div>
                  <div className="pod-row">namespace: {podState.namespace}</div>
                  <div className="pod-row">status: <b>{podState.status}</b></div>
                  <div className="pod-row">restarts: {podState.restartCount}</div>
                  <div className="pod-row">memory limit: {podState.resources?.limitsMemoryMb}Mi</div>
                  <div className="pod-row">当前RSS: {podState.currentRssMb}Mi</div>
                  {podState.lastState && (
                    <div className="pod-row">
                      last state:{" "}
                      <span className={podState.lastState.reason === "OOMKilled" ? "text-danger" : ""}>
                        {podState.lastState.reason} (exit {podState.lastState.exitCode})
                      </span>
                    </div>
                  )}
                  <div className="pod-events">
                    {podState.events?.slice(-6).reverse().map((e: any, i: number) => (
                      <div key={i} className={`pod-event ${e.type === "Warning" ? "warn" : ""}`}>
                        <span className="ts">{new Date(e.time).toLocaleTimeString()}</span> {e.reason}: {e.message}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="empty-hint">加载中...</div>
              )}
            </div>
          )}

          {activeTab === "elk" && (
            <ElkConfigPanel config={elkConfig} onAdd={addElkTarget} />
          )}

          {activeTab === "hosts" && (
            <HostsConfigPanel registry={hostRegistry} onSave={saveHost} onDelete={deleteHost} />
          )}
        </aside>
      </div>
    </div>
  );
}

function EventCard({ event, onDecide }: { event: TimelineEvent; onDecide: (id: string, approved: boolean) => void }) {
  const { type, payload } = event;

  if (type === "user_message") {
    return (
      <div className="message-row user">
        <div className="msg user">{payload.content}</div>
      </div>
    );
  }
  if (type === "assistant_message") {
    const isRca = payload.content?.includes("根因") || payload.content?.includes("置信度");
    return (
      <div className="message-row assistant">
        <div className={`msg assistant ${isRca ? "rca" : ""}`}>{payload.content}</div>
      </div>
    );
  }
  if (type === "status") {
    return <div className="event status">⏳ {payload.message}</div>;
  }
  if (type === "tool_call_start") {
    return (
      <div className="event tool-call">
        <span className={`badge risk-${payload.risk.level}`}>{payload.risk.level}</span>
        <code>{payload.skill}.{payload.tool}</code>
        <span className="args">{JSON.stringify(payload.args)}</span>
      </div>
    );
  }
  if (type === "tool_call_result") {
    const ok = payload.result?.success;
    return (
      <div className={`event tool-result ${ok ? "ok" : "fail"}`}>
        {ok ? "✔" : "✘"} {payload.skill}.{payload.tool} 完成 ({payload.result?.durationMs ?? 0}ms)
      </div>
    );
  }
  if (type === "approval_request") {
    return (
      <div className="approval-card">
        <div className="approval-header">
          ⚠️ 需要您批准以下操作 <span className={`badge risk-${payload.risk.level}`}>{payload.risk.level}</span>
        </div>
        <div className="approval-body">
          <div>
            操作: <code>{payload.skill}.{payload.tool}</code>
          </div>
          {payload.diffPreview && <pre className="diff">{payload.diffPreview}</pre>}
          {payload.risk.blastRadius && <div className="blast">影响范围: {payload.risk.blastRadius}</div>}
        </div>
        <div className="approval-actions">
          <button className="btn approve" onClick={() => onDecide(payload.approvalId, true)}>
            ✅ 批准执行
          </button>
          <button className="btn reject" onClick={() => onDecide(payload.approvalId, false)}>
            ❌ 拒绝
          </button>
        </div>
      </div>
    );
  }
  if (type === "approval_decision") {
    return (
      <div className={`event decision ${payload.approved ? "approved" : "rejected"}`}>
        {payload.approved ? "✅ 已批准" : "❌ 已拒绝"} by {payload.approvedBy}
      </div>
    );
  }
  if (type === "rca_conclusion") {
    return null;
  }
  if (type === "knowledge_case_added") {
    return <div className="event knowledge">📚 已沉淀知识案例: {payload.title}</div>;
  }
  if (type === "checkpoint_saved") {
    return null;
  }
  return null;
}

function ElkConfigPanel({ config, onAdd }: { config: ElkConfig; onAdd: (t: ElkTarget) => void }) {
  const [namespace, setNamespace] = useState("");
  const [podPrefix, setPodPrefix] = useState("");
  const [indexPrefix, setIndexPrefix] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!namespace || !podPrefix || !indexPrefix) return;
    onAdd({ namespace, podNamePrefix: podPrefix, indexPrefix });
    setNamespace("");
    setPodPrefix("");
    setIndexPrefix("");
  }

  return (
    <div className="panel-content">
      <div className="config-card">
        <div className="config-row">
          <span className="config-label">OpenSearch Node</span>
          <span className="config-value">{config.node || "未配置"}</span>
        </div>
      </div>
      <div className="section-title">采集目标</div>
      {config.targets.map((t, i) => (
        <div key={i} className="config-card small">
          <div className="config-row"><span className="config-label">namespace</span><span>{t.namespace}</span></div>
          <div className="config-row"><span className="config-label">pod 前缀</span><span>{t.podNamePrefix}</span></div>
          <div className="config-row"><span className="config-label">索引前缀</span><span>{t.indexPrefix}</span></div>
        </div>
      ))}
      <form className="config-form" onSubmit={submit}>
        <input placeholder="namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} />
        <input placeholder="pod 前缀" value={podPrefix} onChange={(e) => setPodPrefix(e.target.value)} />
        <input placeholder="索引前缀" value={indexPrefix} onChange={(e) => setIndexPrefix(e.target.value)} />
        <button className="btn primary" type="submit">添加目标</button>
      </form>
    </div>
  );
}

function HostsConfigPanel({
  registry,
  onSave,
  onDelete,
}: {
  registry: HostRegistry;
  onSave: (h: HostEntry) => void;
  onDelete: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<HostEntry["auth"]["type"]>("privateKey");
  const [secret, setSecret] = useState("");
  const [showForm, setShowForm] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name || !hostname || !username) return;
    const auth: HostEntry["auth"] =
      authType === "privateKey"
        ? { type: "privateKey", privateKeyEnv: secret || undefined }
        : authType === "password"
        ? { type: "password", passwordEnv: secret || undefined }
        : { type: "agent" };
    onSave({ name, hostname, port: Number(port) || 22, username, auth });
    setName("");
    setHostname("");
    setPort("22");
    setUsername("");
    setSecret("");
    setShowForm(false);
  }

  return (
    <div className="panel-content">
      <div className="section-title">已注册主机</div>
      {registry.hosts.map((h) => (
        <div key={h.name} className="config-card small">
          <div className="config-row">
            <span className="config-value">{h.name}</span>
            <button className="btn ghost tiny" onClick={() => onDelete(h.name)}>删除</button>
          </div>
          <div className="config-row"><span className="config-label">地址</span><span>{h.hostname}:{h.port ?? 22}</span></div>
          <div className="config-row"><span className="config-label">用户</span><span>{h.username}</span></div>
          <div className="config-row"><span className="config-label">认证</span><span>{h.auth.type}</span></div>
        </div>
      ))}
      {registry.hosts.length === 0 && <div className="empty-hint">暂无远程主机</div>}
      {!showForm ? (
        <button className="btn ghost" onClick={() => setShowForm(true)}>+ 添加主机</button>
      ) : (
        <form className="config-form" onSubmit={submit}>
          <input placeholder="别名 (如 node-1)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="IP 或域名" value={hostname} onChange={(e) => setHostname(e.target.value)} />
          <input placeholder="端口" value={port} onChange={(e) => setPort(e.target.value)} />
          <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
          <select value={authType} onChange={(e) => setAuthType(e.target.value as HostEntry["auth"]["type"])}>
            <option value="privateKey">私钥 (环境变量名)</option>
            <option value="password">密码 (环境变量名)</option>
            <option value="agent">SSH Agent</option>
          </select>
          {authType !== "agent" && (
            <input placeholder="凭据环境变量名" value={secret} onChange={(e) => setSecret(e.target.value)} />
          )}
          <div className="form-actions">
            <button className="btn ghost" type="button" onClick={() => setShowForm(false)}>取消</button>
            <button className="btn primary" type="submit">保存</button>
          </div>
        </form>
      )}
    </div>
  );
}
