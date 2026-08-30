import { useEffect, useRef, useState, useCallback } from "react";
import {
  createSession,
  fetchSessionEvents,
  getSession,
  listSessions,
  sendMessage,
  fetchAlerts,
  deleteSession,
  updateSessionTitle,
  decideApproval,
  wsUrl,
} from "./lib/api.js";
import { SessionDetailTabs, type DetailTab } from "./components/SessionDetailTabs.js";
import { KnowledgePage } from "./components/KnowledgePage.js";
import { TopologyPage } from "./components/TopologyPage.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SkillsPage } from "./components/SkillsPage.js";
import type { AgentSession, TimelineEvent, Alert } from "./lib/types.js";
import "./styles/app.css";
import { TopBar } from "./components/console/TopBar.js";
import { SideNav } from "./components/console/SideNav.js";
import { Workspace } from "./components/console/Workspace.js";
import { RightPanel, type PanelTab } from "./components/console/RightPanel.js";
import { ConclusionCard } from "./components/conclusion/ConclusionCard.js";
import { EvidenceList } from "./components/panels/EvidenceList.js";
import { ObjectContext } from "./components/panels/ObjectContext.js";
import { HypothesisTree } from "./components/panels/HypothesisTree.js";
import { AlertCenter } from "./components/alerts/AlertCenter.js";
import { Conversation } from "./components/conversation/Conversation.js";
import { EmptyWorkspace } from "./components/conversation/EmptyWorkspace.js";
import type { ViewKey } from "./lib/view.js";

type MainTab = "timeline" | "evidence" | "plan" | "remediation" | "audit";

function classNames(...arr: (string | false | undefined)[]) {
  return arr.filter(Boolean).join(" ");
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

export default function App() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [mainTab, setMainTab] = useState<MainTab>("timeline");
  const [currentView, setCurrentView] = useState<ViewKey>("alerts");
  const [toasts, setToasts] = useState<{ id: string; message: string; type: "error" | "success" }[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const currentSession = sessions.find((s) => s.id === currentId);

  const RUNNING_STATUSES = new Set(['intake', 'planning', 'executing', 'awaiting_approval', 'reflecting', 'remediating']);
  const STATUS_MESSAGE: Record<string, string> = {
    intake: '正在接收问题…',
    planning: '正在分析问题并制定诊断计划…',
    executing: '正在执行诊断步骤…',
    awaiting_approval: '等待审批…',
    reflecting: '正在综合分析证据…',
    remediating: '正在执行修复…',
  };
  const running = !!currentSession && RUNNING_STATUSES.has(currentSession.status);
  const statusMessage = currentSession ? STATUS_MESSAGE[currentSession.status] : undefined;

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsError, setAlertsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAlerts((err) => {
      if (!cancelled) {
        setAlertsError(err.message);
        setAlertsLoading(false);
      }
    }).then((rows) => {
      if (cancelled || !rows) return;
      setAlerts(rows.alerts);
      setAlertsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const notify = useCallback((message: string, type: "error" | "success" = "error") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const refreshSessions = useCallback(async () => {
    const rows = await listSessions((err) => notify(err.message));
    if (!rows) return;
    const full = await Promise.all(
      rows.map(async (r) => {
        const s = await getSession(r.id);
        return s || { ...r, plan: [], evidence: [], pendingToolCalls: [], executedToolCalls: [], iteration: 0, maxIterations: 20 };
      })
    );
    setSessions(full as AgentSession[]);
  }, [notify]);

  // Load sessions on mount
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // WebSocket connection
  useEffect(() => {
    if (!currentId) return;
    if (wsRef.current) {
      wsRef.current.close();
    }
    setLoading(true);
    const ws = new WebSocket(wsUrl(currentId));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setLoading(false);
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as TimelineEvent;
        setEvents((prev) => [...prev, data]);
        if (["status", "done", "error", "rca_conclusion", "approval_request", "plan_update", "remediation_plan"].includes(data.type)) {
          refreshSessions();
        }
      } catch {
        // ignore non-json
      }
    };
    ws.onclose = () => {
      setConnected(false);
    };
    ws.onerror = () => {
      notify("WebSocket 连接异常");
      setConnected(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [currentId, notify, refreshSessions]);

  // Auto scroll chat
  useEffect(() => {
    if (mainTab === "timeline") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, mainTab]);

  const handleCreate = async () => {
    const s = await createSession("新的故障排查会话", (err) => notify(err.message));
    if (!s) return;
    await refreshSessions();
    setEvents([]);
    setCurrentId(s.id);
    setMainTab("timeline");
  };

  const handleSelect = async (id: string) => {
    setCurrentId(id);
    setMainTab("timeline");
    const [s, events] = await Promise.all([
      getSession(id),
      fetchSessionEvents(id, (err) => notify(err.message)),
    ]);
    if (s) {
      setSessions((prev) => prev.map((x) => (x.id === id ? s : x)));
    }
    if (events) {
      setEvents(events);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除该会话吗？此操作不可恢复，会删除会话、时间线、审批与审计记录。")) return;
    await deleteSession(id, (err) => notify(err.message));
    await refreshSessions();
    if (currentId === id) setCurrentId(null);
  };

  const handleTitleSave = async (id: string, title: string) => {
    await updateSessionTitle(id, title, (err) => notify(err.message));
    await refreshSessions();
  };

  const handleSend = async () => {
    if (!currentId || !input.trim()) return;
    setLoading(true);
    await sendMessage(currentId, input.trim(), (err) => notify(err.message));
    setInput("");
    setLoading(false);
  };

  const handleApprove = async (approvalId: string, approved: boolean) => {
    await decideApproval(approvalId, approved, "demo-user@company.com", (err) => notify(err.message));
  };

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase()) ||
    s.status.toLowerCase().includes(search.toLowerCase())
  );

  const activeSessions = filteredSessions.filter((s) => s.status !== "closed");
  const closedSessions = filteredSessions.filter((s) => s.status === "closed");

  const pendingApprovals = sessions.reduce((count, session) => count + session.pendingToolCalls.length, 0);
  const activeAlerts = alerts.filter((alert) => alert.status === "firing").length;

  const handleInvestigateAlert = (_alertId: string) => {
    setCurrentView("sessions");
    if (!currentId) handleCreate();
  };

  const [rightTab, setRightTab] = useState<PanelTab>("process");
  const [highlightEvidenceId, setHighlightEvidenceId] = useState<string | null>(null);

  const handleCitationClick = (evidenceId: string) => {
    setHighlightEvidenceId(evidenceId);
    setRightTab("evidence");
  };

  return (
    <div className="app">
      <TopBar
        connected={connected}
        pendingApprovals={pendingApprovals}
        activeAlerts={activeAlerts}
        onNewSession={() => {
          setCurrentView("sessions");
          handleCreate();
        }}
      />
      <div className="app__body">
        <SideNav
          activeView={currentView}
          alertCount={activeAlerts}
          onNavigate={setCurrentView}
          activeSessions={activeSessions}
          closedSessions={closedSessions}
          currentId={currentId}
          search={search}
          onSearch={setSearch}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onTitleSave={handleTitleSave}
        />
        <Workspace>
          {currentView === "alerts" && (
            <AlertCenter
              alerts={alerts.map((alert) => ({
                id: alert.id,
                severity: alert.severity,
                title: alert.title,
                source: alert.source,
                startedAt: alert.startedAt,
                status: alert.status,
              }))}
              loading={alertsLoading}
              error={alertsError}
              onInvestigate={handleInvestigateAlert}
            />
          )}
          {currentView === "sessions" &&
            (currentSession ? (
              <>
                <SessionHeader session={currentSession} onTitleSave={handleTitleSave} onDelete={handleDelete} />
                <div className="main__tabs">
                  {[
                    { key: "timeline", label: "时间线" },
                    { key: "evidence", label: "证据链" },
                    { key: "plan", label: "诊断计划" },
                    { key: "remediation", label: "修复方案" },
                    { key: "audit", label: "审计日志" },
                  ].map((t) => (
                    <button
                      key={t.key}
                      className={classNames("main__tab", mainTab === t.key && "main__tab--active")}
                      onClick={() => setMainTab(t.key as MainTab)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="main__content">
                  {mainTab === "timeline" ? (
                    <Conversation
                      events={events}
                      loading={loading && events.length === 0}
                      running={running}
                      statusMessage={statusMessage}
                      renderSpecial={(event) => <EventCard event={event} onApprove={handleApprove} />}
                      chatEndRef={chatEndRef}
                    />
                  ) : (
                    <SessionDetailTabs
                      session={currentSession}
                      tab={mainTab as DetailTab}
                      onTabChange={(t) => setMainTab(t)}
                    />
                  )}
                </div>
                {mainTab === "timeline" && currentSession.rootCause && (
                  <ConclusionCard
                    rootCause={currentSession.rootCause}
                    remediation={currentSession.remediation}
                    onCitationClick={handleCitationClick}
                    onApproveRemediation={() =>
                      notify("整单修复审批将在后续版本接入，当前请使用时间线中的逐操作审批")
                    }
                  />
                )}
                {mainTab === "timeline" && (
                  <div className="composer">
                    <input
                      className="composer__input"
                      placeholder="描述故障现象或输入指令，例如：order-api Pod 反复重启..."
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSend()}
                      disabled={loading}
                    />
                    <button className="composer__send" onClick={handleSend} disabled={!input.trim() || loading}>
                      发送
                    </button>
                  </div>
                )}
              </>
            ) : (
              <EmptyWorkspace onNewSession={handleCreate} />
            ))}
          {currentView === "knowledge" && <KnowledgePage notify={notify} />}
          {currentView === "topology" && <TopologyPage />}
          {currentView === "settings" && <SettingsPage notify={notify} />}
          {currentView === "skills" && <SkillsPage notify={notify} />}
        </Workspace>
        {currentView === "sessions" && currentSession && (
          <RightPanel
            activeTab={rightTab}
            onTabChange={setRightTab}
            process={
              <HypothesisTree
                hypotheses={currentSession.hypotheses ?? []}
                onCitationClick={handleCitationClick}
              />
            }
            evidence={<EvidenceList evidence={currentSession.evidence} highlightId={highlightEvidenceId} />}
            object={
              <ObjectContext
                alerts={alerts}
                onDiagnose={() => {
                  setCurrentView("sessions");
                  if (!currentId) handleCreate();
                }}
              />
            }
          />
        )}
      </div>
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionHeader({
  session,
  onTitleSave,
  onDelete,
}: {
  session: AgentSession;
  onTitleSave: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [copied, setCopied] = useState(false);

  const copyId = () => {
    navigator.clipboard?.writeText(session.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className="session-header">
      <div className="session-header__info">
        {editing ? (
          <input
            className="session-header__title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              setEditing(false);
              onTitleSave(session.id, title);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditing(false);
                onTitleSave(session.id, title);
              }
            }}
            autoFocus
          />
        ) : (
          <h1 className="session-header__title" onClick={() => setEditing(true)} title="点击编辑">
            {session.title}
          </h1>
        )}
        <p className="session-header__desc">
          {session.incidentSummary || "暂无故障摘要，请在下方输入现象开始诊断。"}
        </p>
        <div className="session-header__id">
          <span className="session-header__id-label">会话 ID</span>
          <code className="session-header__id-value">{session.id}</code>
          <button className="btn btn--sm" onClick={copyId}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <div className="session-header__stats">
        <div className="stat-card">
          <div className="stat-card__value">{session.iteration}</div>
          <div className="stat-card__label">迭代轮次</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{session.evidence.length}</div>
          <div className="stat-card__label">证据</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{session.executedToolCalls.length}</div>
          <div className="stat-card__label">已执行工具</div>
        </div>
      </div>
      <div className="session-header__actions">
        <button className="btn btn--danger" onClick={() => onDelete(session.id)}>
          删除会话
        </button>
      </div>
    </div>
  );
}

function EventCard({ event, onApprove }: { event: TimelineEvent; onApprove: (id: string, approved: boolean) => void }) {
  const p = event.payload || {};

  switch (event.type) {
    case "approval_request":
      return (
        <ApprovalCard
          skill={p.skill}
          tool={p.tool}
          args={p.args}
          risk={p.risk}
          diffPreview={p.diffPreview}
          onApprove={() => onApprove(p.approvalId, true)}
          onReject={() => onApprove(p.approvalId, false)}
        />
      );
    case "approval_decision":
      return (
        <div className="timeline-item timeline-item--status">
          <div className="timeline-item__icon">{p.decision === "approved" ? "✅" : "❌"}</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">审批决策</div>
            <div className="timeline-item__text">
              {p.decision === "approved" ? "已批准" : "已拒绝"} {p.approvedBy ? `(${p.approvedBy})` : ""}
            </div>
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
    case "remediation_plan":
      return (
        <div className="timeline-item timeline-item--remediation">
          <div className="timeline-item__icon">🛠️</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">修复方案</div>
            <div className="timeline-item__text">{p.summary}</div>
            {p.steps && (
              <ol className="timeline-item__list">
                {p.steps.map((step: any, i: number) => (
                  <li key={i}>{step.description}</li>
                ))}
              </ol>
            )}
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
    case "rca_conclusion":
      return (
        <div className="timeline-item timeline-item--rca">
          <div className="timeline-item__icon">🎯</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">根因分析结论</div>
            <div className="timeline-item__text timeline-item__text--highlight">{p.content}</div>
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
    case "knowledge_case_added":
      return (
        <div className="timeline-item timeline-item--knowledge">
          <div className="timeline-item__icon">📚</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">知识库沉淀</div>
            <div className="timeline-item__text">{p.title || "已自动保存相似案例"}</div>
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
    case "error":
      return (
        <div className="timeline-item timeline-item--error">
          <div className="timeline-item__icon">⚠</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">运行错误</div>
            <div className="timeline-item__text">{p.message || JSON.stringify(p)}</div>
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
    case "done":
      return (
        <div className="timeline-item timeline-item--done">
          <div className="timeline-item__icon">🏁</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">会话结束</div>
            <div className="timeline-item__text">诊断流程已完成</div>
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
    case "checkpoint_saved":
    case "runner_resumed":
      return null; // internal events, skip visual noise
    default:
      return (
        <div className="timeline-item timeline-item--muted">
          <div className="timeline-item__icon">•</div>
          <div className="timeline-item__body">
            <div className="timeline-item__title">{event.type}</div>
            <pre className="timeline-item__code timeline-item__code--compact">{JSON.stringify(p, null, 2)}</pre>
          </div>
          <div className="timeline-item__time">{formatTime(event.timestamp)}</div>
        </div>
      );
  }
}

function ApprovalCard({
  skill,
  tool,
  args,
  risk,
  diffPreview,
  onApprove,
  onReject,
}: {
  skill: string;
  tool: string;
  args: Record<string, unknown>;
  risk: any;
  diffPreview?: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="approval-card">
      <div className="approval-card__header">
        <span className="approval-card__icon">🔒</span>
        <span className="approval-card__title">高危操作待审批</span>
        <span className={`risk-badge risk-badge--${risk?.level}`}>{risk?.level}</span>
      </div>
      <div className="approval-card__body">
        <div className="approval-card__tool">
          {skill}.{tool}()
        </div>
        <div className="approval-card__reason">{risk?.reason}</div>
        {diffPreview && (
          <div className="approval-card__diff">
            <div className="approval-card__diff-title">变更预览</div>
            <pre>{diffPreview}</pre>
          </div>
        )}
        {args && Object.keys(args).length > 0 && (
          <pre className="approval-card__args">{JSON.stringify(args, null, 2)}</pre>
        )}
      </div>
      <div className="approval-card__actions">
        <button className="btn btn--danger" onClick={onReject}>
          拒绝
        </button>
        <button className="btn btn--primary" onClick={onApprove}>
          批准执行
        </button>
      </div>
    </div>
  );
}
