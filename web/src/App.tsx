import { useEffect, useRef, useState, useCallback } from "react";
import {
  createSession,
  cancelSession,
  addSessionAllowlist,
  fetchSessionAllowlist,
  removeSessionAllowlist,
  fetchSessionEvents,
  fetchSessionUsage,
  fetchLlmProviders,
  getSession,
  listSessions,
  sendMessage,
  fetchAlerts,
  syncAlerts,
  fetchServiceHealth,
  updateAlert,
  logout,
  clearAuthToken,
  getAuthToken,
  fetchMe,
  deleteSession,
  updateSessionTitle,
  decideApproval,
  wsUrl,
} from "./lib/api.js";
import type { OnError, SessionAllowEntry } from "./lib/api.js";
import { ArtifactsPanel, AuditPanel, PlanPanel, RemediationPanel } from "./components/panels/SessionPanels.js";
import { KnowledgePage } from "./components/KnowledgePage.js";
import { TopologyPage } from "./components/TopologyPage.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SkillsPage } from "./components/SkillsPage.js";
import { DataSourcesPage } from "./components/DataSourcesPage.js";
import { UsagePage } from "./components/UsagePage.js";
import type { AgentSession, TimelineEvent, Alert, ServiceHealth } from "./lib/types.js";
import "./styles/app.css";
import { TopBar } from "./components/console/TopBar.js";
import { SideNav } from "./components/console/SideNav.js";
import { SessionColumn } from "./components/console/SessionColumn.js";
import { Workspace } from "./components/console/Workspace.js";
import { RightPanel, type PanelTab } from "./components/console/RightPanel.js";
import { ConclusionCard } from "./components/conclusion/ConclusionCard.js";
import { EvidenceList } from "./components/panels/EvidenceList.js";
import { AlertCenter } from "./components/alerts/AlertCenter.js";
import { LoginPage, UserMenu, loadStoredUser, clearStoredUser, type CurrentUser } from "./components/LoginPage.js";
import { Conversation } from "./components/conversation/Conversation.js";
import { ExecutionTrackPanel } from "./components/conversation/ExecutionTrackPanel.js";
import { EmptyWorkspace } from "./components/conversation/EmptyWorkspace.js";
import type { ViewKey } from "./lib/view.js";
import { progressFromEvents } from "./lib/progress.js";
import { mergeTimeline } from "./lib/timeline.js";
import {
  RUNNING_SESSION_STATUSES,
  sessionStatusClass,
  sessionStatusText,
} from "./lib/session-status.js";

const UI_STATE_KEY = "infrapilot.uiState";

interface PersistedUiState {
  currentId?: string | null;
  currentView?: ViewKey;
  rightTab?: PanelTab;
  rightPanelOpen?: boolean;
  sessionListOpen?: boolean;
}

/** 刷新后恢复上次打开的会话与面板状态（后端短暂 502 时也不至于「会话丢失」） */
function loadUiState(): PersistedUiState {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    return raw ? (JSON.parse(raw) as PersistedUiState) : {};
  } catch {
    return {};
  }
}

function classNames(...arr: (string | false | undefined)[]) {
  return arr.filter(Boolean).join(" ");
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

export default function App() {
  const [storedUi] = useState<PersistedUiState>(loadUiState);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(storedUi.currentId ?? null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connected, setConnected] = useState(false);
  const [currentView, setCurrentView] = useState<ViewKey>(storedUi.currentView ?? "alerts");
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: string; message: string; type: "error" | "success" }[]>([]);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(() => loadStoredUser());

  // 启动校验登录态：localStorage 的 currentUser 只是界面标记，真正决定权限的是 token。
  // 二者一旦脱钩（token 过期/被 401 清掉）会出现「界面已登录、接口 401」的假登录态，
  // 这里用 GET /auth/me 复核一次，失败就清干净回到登录页。
  useEffect(() => {
    if (!loadStoredUser()) return;
    if (!getAuthToken()) {
      clearStoredUser();
      setCurrentUser(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetchMe();
      if (!cancelled && !res) {
        clearStoredUser();
        setCurrentUser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

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
  // 进度取「事件流 / 会话状态」中更靠后的阶段：事件实时到达，状态可能滞后一轮刷新
  const sessionProgress = progressFromEvents(events, currentSession?.status);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [servicesSource, setServicesSource] = useState<string>("none");

  // 先展示本地已有的告警，再同步 Prometheus 真实 firing 告警；同步变更有更新时再刷新一次
  const refreshAlerts = useCallback(async () => {
    setAlertsLoading(true);
    const initial = await fetchAlerts((err) => {
      setAlertsError(err.message);
      setAlertsLoading(false);
    });
    if (initial) {
      setAlerts(initial.alerts);
      setAlertsError(null);
    }
    setAlertsLoading(false);
    const synced = await syncAlerts().catch(() => undefined);
    if (synced?.ok && (synced.created > 0 || synced.resolved > 0)) {
      const refreshed = await fetchAlerts();
      if (refreshed) setAlerts(refreshed.alerts);
    }
  }, []);

  useEffect(() => {
    void refreshAlerts();
  }, [refreshAlerts]);

  const refreshServiceHealth = useCallback(async () => {
    setServicesLoading(true);
    const res = await fetchServiceHealth((err) => {
      setServicesError(err.message);
      setServicesLoading(false);
    });
    if (res) {
      setServices(res.services ?? []);
      setServicesSource(res.source);
      setServicesError(res.error ?? null);
    }
    setServicesLoading(false);
  }, []);

  useEffect(() => {
    if (currentView !== "alerts") return;
    void refreshServiceHealth();
  }, [currentView, refreshServiceHealth]);

  const notify = useCallback((message: string, type: "error" | "success" = "error") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const loadAllSessions = useCallback(async (onError?: OnError) => {
    const rows = await listSessions(onError);
    if (!rows) return undefined;
    return (await Promise.all(
      rows.map(async (r) => {
        const s = await getSession(r.id);
        return s || { ...r, plan: [], evidence: [], pendingToolCalls: [], executedToolCalls: [], iteration: 0, maxIterations: 20 };
      })
    )) as AgentSession[];
  }, []);

  const refreshSessions = useCallback(async () => {
    const full = await loadAllSessions((err) => notify(err.message));
    if (full) setSessions(full);
  }, [loadAllSessions, notify]);

  // Load sessions on mount：后端 Recreate 滚动重启期间会短暂 502，做有限重试而非直接丢掉会话
  useEffect(() => {
    let cancelled = false;
    const attempt = async (n: number) => {
      const full = await loadAllSessions(() => {});
      if (cancelled) return;
      if (!full && n < 4) {
        setTimeout(() => { void attempt(n + 1); }, 1200 * (n + 1));
        return;
      }
      if (full) setSessions(full);
      else notify("后端暂时不可用，会话列表加载失败，请稍后重试");
    };
    void attempt(0);
    return () => { cancelled = true; };
  }, [loadAllSessions, notify]);

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
        // 切换会话时旧连接可能仍有迟到事件，按 sessionId 丢弃，避免串场
        if (data.sessionId && data.sessionId !== currentId) return;
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

  // Auto scroll chat —— 只滚动对话容器，避免把 Workspace（含顶栏折叠开关）一起滚上去
  useEffect(() => {
    if (!running) return;
    const el = chatScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [events, running]);

  // 恢复上次打开的会话：刷新后重新拉取详情与时间线
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !currentId) return;
    restoredRef.current = true;
    let cancelled = false;
    void (async () => {
      const [s, evts] = await Promise.all([getSession(currentId), fetchSessionEvents(currentId)]);
      if (cancelled) return;
      if (s) setSessions((prev) => prev.map((x) => (x.id === s.id ? s : x)));
      if (evts) setEvents((prev) => mergeTimeline(evts, prev, currentId));
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  // 会话已不存在（被删除）时清理选择，避免停留在空白页
  useEffect(() => {
    if (!currentId || sessions.length === 0) return;
    if (!sessions.some((s) => s.id === currentId)) setCurrentId(null);
  }, [sessions, currentId]);

  const handleCreate = async () => {
    const s = await createSession("新的故障排查会话", (err) => notify(err.message));
    if (!s) return;
    await refreshSessions();
    setEvents([]);
    setCurrentId(s.id);
  };

  const handleSelect = async (id: string) => {
    setCurrentId(id);
    // 先清空，避免历史事件返回前串显上一个会话的内容
    setEvents([]);
    const [s, events] = await Promise.all([
      getSession(id),
      fetchSessionEvents(id, (err) => notify(err.message)),
    ]);
    if (s) {
      setSessions((prev) => prev.map((x) => (x.id === id ? s : x)));
    }
    if (events) {
      // 拉取期间 WebSocket 可能已推来新事件，合并而不是覆盖
      setEvents((prev) => mergeTimeline(events, prev, id));
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
    // 后端会用首个问题给占位标题命名，这里立即拉一次会话，顶栏/清单同步显示真实标题
    void refreshSessions();
  };

  /** 停止执行：真正打断后端进行中的 Agent 轮次（LLM 流式 / 工具调用），而不只是改状态。 */
  const handleStop = async () => {
    if (!currentId || stopping) return;
    setStopping(true);
    const res = await cancelSession(currentId, (err) => notify(err.message));
    setStopping(false);
    if (!res) return;
    // 乐观更新：立刻收起「思考中」，再拉取服务端权威状态与时间线
    if (res.changed) {
      setSessions((prev) => prev.map((s) => (s.id === currentId ? { ...s, status: "closed" as const } : s)));
    }
    const [s, evts] = await Promise.all([getSession(currentId), fetchSessionEvents(currentId)]);
    if (s) setSessions((prev) => prev.map((x) => (x.id === s.id ? s : x)));
    if (evts) setEvents(evts);
    if (!res.changed) notify("任务已经结束，无需中断");
    else if (res.interrupted) notify("已中断当前任务", "success");
    else notify("已停止当前任务", "success");
  };

  const handleApprove = async (approvalId: string, approved: boolean) => {
    // 用户隔离演示：viewer 角色无审批权限（后端 RBAC 上线后由服务端强制校验）
    if (currentUser?.role === "viewer") {
      notify("当前角色为只读观察，无审批权限", "error");
      return;
    }
    const decidedBy = currentUser?.username ?? "demo-user";
    await decideApproval(approvalId, approved, decidedBy, (err) => notify(err.message));
  };

  /** 「始终允许」：会话级免审批白名单（仅 medium 风险，写入后端并全程审计）。 */
  const [sessionAllowlist, setSessionAllowlist] = useState<Set<string>>(new Set());
  const [allowEntries, setAllowEntries] = useState<SessionAllowEntry[]>([]);
  const [openPill, setOpenPill] = useState<"approval" | "readonly" | null>(null);
  const [llmModel, setLlmModel] = useState("deepseek-v4-flash");

  const applyAllowlist = useCallback((entries: SessionAllowEntry[]) => {
    setAllowEntries(entries);
    setSessionAllowlist(new Set(entries.map((e) => `${e.skill}.${e.tool}`)));
  }, []);

  useEffect(() => {
    if (!currentId) {
      applyAllowlist([]);
      return;
    }
    fetchSessionAllowlist(currentId).then((res) => {
      if (res) applyAllowlist(res.allowlist);
    });
  }, [currentId, applyAllowlist]);

  // 底部模型 pill：展示系统设置中默认 Provider 的模型，保持与配置同源
  useEffect(() => {
    fetchLlmProviders().then((res) => {
      const provider =
        res?.providers.find((p) => p.enabled && p.isDefault) ?? res?.providers.find((p) => p.enabled);
      if (provider?.recommendedModel) setLlmModel(provider.recommendedModel);
    });
  }, []);

  // 点击空白处收起底部选项弹层
  useEffect(() => {
    if (!openPill) return;
    const close = () => setOpenPill(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openPill]);

  const handleAlwaysAllow = async (skill: string, tool: string) => {
    if (!currentId) return;
    const res = await addSessionAllowlist(currentId, skill, tool, (err) => notify(err.message));
    if (!res) return;
    applyAllowlist(res.allowlist);
    notify(`本会话内 ${skill}.${tool} 后续调用免审批（当前 ${res.allowlist.length} 项）`, "success");
  };

  const handleRemoveAllow = async (skill: string, tool: string) => {
    if (!currentId) return;
    const res = await removeSessionAllowlist(currentId, skill, tool, (err) => notify(err.message));
    if (!res) return;
    applyAllowlist(res.allowlist);
    notify(`已移除免审批：${skill}.${tool}`, "success");
  };

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase()) ||
    s.status.toLowerCase().includes(search.toLowerCase())
  );

  const activeSessions = filteredSessions.filter((s) => s.status !== "closed");
  const closedSessions = filteredSessions.filter((s) => s.status === "closed");

  const pendingApprovals = sessions.reduce((count, session) => count + session.pendingToolCalls.length, 0);
  const activeAlerts = alerts.filter((alert) => alert.status === "firing").length;

  const handleInvestigateAlert = async (alertId: string) => {
    const alert = alerts.find((a) => a.id === alertId);
    if (!alert) return;
    // 用会话/消息 API 注入告警上下文，并把新会话关联回告警（PATCH /api/alerts/:id）
    setCurrentView("sessions");
    const s = await createSession(`诊断: ${alert.title}`, (err) => notify(err.message), alert.service);
    if (!s) return;
    await refreshSessions();
    setEvents([]);
    setCurrentId(s.id);
    const context = [
      `【告警上下文】${alert.title}`,
      `- 级别: ${alert.severity.toUpperCase()} · 状态: ${alert.status}`,
      `- 服务/对象: ${alert.service}`,
      `- 来源: ${alert.source}`,
      alert.count && alert.count > 1 ? `- 累计触发: ${alert.count} 次` : "",
      alert.labels ? `- 标签: ${Object.entries(alert.labels).map(([k, v]) => `${k}=${v}`).join(", ")}` : "",
      alert.annotations?.description ? `- 描述: ${alert.annotations.description}` : "",
      "",
      "请开始诊断：先确认现象（Pod 状态 / 事件 / 日志），再采集证据并给出根因假设。变更类操作请走审批流程。",
    ].filter(Boolean).join("\n");
    setLoading(true);
    await sendMessage(s.id, context, (err) => notify(err.message));
    setLoading(false);
    // 关联告警与会话，并置为「诊断中」（AlertList 据此展示「查看会话」）
    const linked = await updateAlert(alertId, { status: "diagnosing", sessionId: s.id }, (err) => notify(err.message));
    if (linked) setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...linked.alert } : a)));
  };

  /** 标记确认/解决：调用 PATCH /api/alerts/:id（后端统一返回 camelCase Alert） */
  const patchAlertStatus = async (alertId: string, status: "acknowledged" | "resolved") => {
    const res = await updateAlert(alertId, { status }, (err) => notify(err.message));
    if (!res) return;
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, ...res.alert } : a)));
    notify(status === "acknowledged" ? "告警已确认" : "告警已解决", "success");
  };

  const handleAcknowledgeAlert = (alertId: string) => {
    void patchAlertStatus(alertId, "acknowledged");
  };

  const handleResolveAlert = (alertId: string) => {
    void patchAlertStatus(alertId, "resolved");
  };

  const handleOpenAlertSession = (sessionId: string) => {
    setCurrentView("sessions");
    handleSelect(sessionId);
  };

  /** 拓扑节点「一键诊断」：建会话并注入节点上下文 */
  const handleDiagnoseObject = async (ns: string, name: string, kind: string) => {
    setCurrentView("sessions");
    const s = await createSession(`诊断: ${ns}/${name}`, (err) => notify(err.message), `${kind} ${ns}/${name}`);
    if (!s) return;
    await refreshSessions();
    setEvents([]);
    setCurrentId(s.id);
    setLoading(true);
    await sendMessage(
      s.id,
      `【拓扑节点】${kind} ${ns}/${name}\n请先确认该对象的状态、副本与最近事件，再结合日志/指标定位根因。变更类操作请走审批流程。`,
      (err) => notify(err.message),
    );
    setLoading(false);
  };

  /** 服务健康卡片「一键诊断」：建会话并注入 Deployment 上下文 */
  const handleDiagnoseService = async (service: ServiceHealth) => {
    const target = service.namespace ? `${service.namespace}/${service.name}` : service.name;
    setCurrentView("sessions");
    const s = await createSession(`诊断: ${target}`, (err) => notify(err.message), target);
    if (!s) return;
    await refreshSessions();
    setEvents([]);
    setCurrentId(s.id);
    setLoading(true);
    await sendMessage(
      s.id,
      [
        `【服务健康】${target}`,
        `- 健康状态: ${service.status}`,
        `- ${service.metricLabel}: ${service.metricValue}`,
        service.meta ? `- 概览: ${service.meta}` : "",
        "",
        "请开始诊断：先确认该 Deployment 的期望/可用副本与最近事件，再拉取 Pod 日志与指标，给出根因假设。变更类操作请走审批流程。",
      ].filter(Boolean).join("\n"),
      (err) => notify(err.message),
    );
    setLoading(false);
  };

  const [rightTab, setRightTab] = useState<PanelTab>(storedUi.rightTab ?? "track");
  const [sessionListOpen, setSessionListOpen] = useState(storedUi.sessionListOpen ?? true);
  const [rightPanelOpen, setRightPanelOpen] = useState(storedUi.rightPanelOpen ?? true);
  const [highlightEvidenceId, setHighlightEvidenceId] = useState<string | null>(null);

  // 持久化 UI 状态（会话选择 / 视图 / 右栏），刷新后原样恢复
  useEffect(() => {
    try {
      localStorage.setItem(
        UI_STATE_KEY,
        JSON.stringify({ currentId, currentView, rightTab, rightPanelOpen, sessionListOpen }),
      );
    } catch {
      // localStorage 不可用时忽略（隐私模式等）
    }
  }, [currentId, currentView, rightTab, rightPanelOpen, sessionListOpen]);

  const handleCitationClick = (evidenceId: string) => {
    setHighlightEvidenceId(evidenceId);
    setRightTab("evidence");
  };

  // 认证门禁（前端演示版）：未登录先展示登录页
  if (!currentUser) {
    return (
      <LoginPage
        onLogin={(u) => {
          localStorage.setItem("infrapilot.currentUser", JSON.stringify(u));
          setCurrentUser(u);
          notify(`欢迎，${u.displayName}（${u.role}）`, "success");
        }}
      />
    );
  }

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
        userMenu={
          currentUser && (
            <UserMenu
              user={currentUser}
              onLogout={() => {
                void logout();
                clearAuthToken();
                clearStoredUser();
                setCurrentUser(null);
                notify("已退出登录");
              }}
            />
          )
        }
      />
      <div className="app__body">
        <SideNav activeView={currentView} alertCount={activeAlerts} onNavigate={setCurrentView} />
        {currentView === "sessions" && (
          <SessionColumn
            activeSessions={activeSessions}
            closedSessions={closedSessions}
            currentId={currentId}
            search={search}
            onSearch={setSearch}
            onSelect={handleSelect}
            onDelete={handleDelete}
            onTitleSave={handleTitleSave}
            onNew={handleCreate}
            onCollapse={() => setSessionListOpen(false)}
            onExpand={() => setSessionListOpen(true)}
            collapsed={!sessionListOpen}
          />
        )}
        <Workspace>
          {currentView === "alerts" && (
            <AlertCenter
              alerts={alerts}
              loading={alertsLoading}
              error={alertsError}
              services={services}
              servicesLoading={servicesLoading}
              servicesError={servicesError}
              servicesSource={servicesSource}
              onInvestigate={handleInvestigateAlert}
              onDiagnoseService={handleDiagnoseService}
              onAcknowledge={handleAcknowledgeAlert}
              onResolve={handleResolveAlert}
              onOpenSession={handleOpenAlertSession}
            />
          )}
          {currentView === "sessions" &&
            (currentSession ? (
              <>
                <SessionHeader
                  session={currentSession}
                  onTitleSave={handleTitleSave}
                  onDelete={handleDelete}
                  sessionListOpen={sessionListOpen}
                  onToggleSessionList={() => setSessionListOpen((v) => !v)}
                  rightPanelOpen={rightPanelOpen}
                  onToggleRightPanel={() => setRightPanelOpen((v) => !v)}
                />
                <div className="main__content main__content--chat" ref={chatScrollRef}>
                  <Conversation
                    events={events}
                    loading={loading && events.length === 0}
                    running={running}
                    statusMessage={statusMessage}
                    progress={sessionProgress}
                    footer={
                      currentSession.rootCause ? (
                        <ConclusionCard
                          rootCause={currentSession.rootCause}
                          remediation={currentSession.remediation}
                          sessionStatus={currentSession.status}
                          onCitationClick={handleCitationClick}
                        />
                      ) : null
                    }
                    renderSpecial={(event) => (
                      <EventCard
                        event={event}
                        onApprove={handleApprove}
                        onAlwaysAllow={handleAlwaysAllow}
                        allowlist={sessionAllowlist}
                      />
                    )}
                    chatEndRef={chatEndRef}
                  />
                </div>
                <div className="composer">
                    <div className="composer__row">
                      <input
                        className="composer__input"
                        placeholder="任务执行中，输入内容可实时引导智能体（回车追加，如：先看下 15 点前的变更记录）…"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                          }
                        }}
                        disabled={loading}
                      />
                      {running ? (
                        <button
                          type="button"
                          className="composer__stop"
                          title={stopping ? "正在中断…" : "停止执行"}
                          aria-label="停止执行"
                          disabled={stopping}
                          onClick={() => void handleStop()}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
                            <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
                          </svg>
                        </button>
                      ) : (
                        <button className="composer__send" onClick={handleSend} disabled={!input.trim() || loading}>
                          发送
                        </button>
                      )}
                    </div>
                    <div className="composer__opts">
                      <span className="composer__pill-wrap">
                        <button
                          type="button"
                          className={classNames("composer__pill", openPill === "approval" && "composer__pill--open")}
                          aria-expanded={openPill === "approval"}
                          title="查看审批策略与本会话已放行的技能"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => setOpenPill(openPill === "approval" ? null : "approval")}
                        >
                          <span className="composer__dot" style={{ background: "var(--warn)" }} />
                          审批 · 需确认
                          <span className="composer__caret">▾</span>
                        </button>
                        {openPill === "approval" && (
                          <div className="composer__pop" role="dialog" onPointerDown={(e) => e.stopPropagation()}>
                            <div className="composer__pop-title">审批策略</div>
                            <p className="composer__pop-note">
                              medium 及以上风险的变更操作必须人工确认，经 Command Gateway 校验审批哈希后执行。
                            </p>
                            <div className="composer__pop-title">
                              本会话已放行（{allowEntries.length}）
                            </div>
                            {allowEntries.length === 0 ? (
                              <p className="composer__pop-empty">
                                暂无免审批技能。审批卡中点击「始终允许」可将该技能加入本会话白名单。
                              </p>
                            ) : (
                              <ul className="composer__pop-list">
                                {allowEntries.map((entry) => (
                                  <li key={`${entry.skill}.${entry.tool}`}>
                                    <code>
                                      {entry.skill}.{entry.tool}
                                    </code>
                                    <button
                                      type="button"
                                      onClick={() => void handleRemoveAllow(entry.skill, entry.tool)}
                                      title="移出本会话白名单"
                                    >
                                      移除
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </span>
                      <span className="composer__pill-wrap">
                        <button
                          type="button"
                          className={classNames("composer__pill", openPill === "readonly" && "composer__pill--open")}
                          aria-expanded={openPill === "readonly"}
                          title="查看执行策略"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => setOpenPill(openPill === "readonly" ? null : "readonly")}
                        >
                          <span className="composer__dot" style={{ background: "var(--success)" }} />
                          只读 · 自动
                          <span className="composer__caret">▾</span>
                        </button>
                        {openPill === "readonly" && (
                          <div className="composer__pop" role="dialog" onPointerDown={(e) => e.stopPropagation()}>
                            <div className="composer__pop-title">执行策略</div>
                            <ul className="composer__pop-policy">
                              <li>
                                <b>只读</b> 查询类技能自动执行，不打断诊断节奏
                              </li>
                              <li>
                                <b>变更</b> medium 及以上风险需人工审批，可在审批卡选择「始终允许」
                              </li>
                              <li>
                                <b>审计</b> 每次调用经网关落库，含审批哈希与脱敏输出
                              </li>
                            </ul>
                          </div>
                        )}
                      </span>
                      <span className="composer__pill-wrap">
                        <button
                          type="button"
                          className="composer__pill"
                          title="前往系统设置 · 模型配置"
                          onClick={() => {
                            setOpenPill(null);
                            setSettingsSection("llm-providers");
                            setCurrentView("settings");
                          }}
                        >
                          <span className="composer__dot" style={{ background: "var(--accent-primary)" }} />
                          {llmModel}
                          <span className="composer__caret">▸</span>
                        </button>
                      </span>
                      <span className="composer__spacer" />
                      <span className="composer__hint">Enter 发送 · Shift+Enter 换行</span>
                    </div>
                </div>
              </>
            ) : (
              <EmptyWorkspace onNewSession={handleCreate} />
            ))}
          {currentView === "knowledge" && <KnowledgePage notify={notify} />}
          {currentView === "topology" && <TopologyPage notify={notify} onDiagnose={handleDiagnoseObject} />}
          {currentView === "settings" && (
            <SettingsPage
              notify={notify}
              requestedSection={settingsSection}
              onSectionConsumed={() => setSettingsSection(null)}
            />
          )}
          {currentView === "skills" && <SkillsPage notify={notify} />}
          {currentView === "usage" && <UsagePage notify={notify} />}
          {currentView === "datasources" && (
            <DataSourcesPage
              notify={notify}
              onOpenSettings={(section) => {
                setSettingsSection(section);
                setCurrentView("settings");
              }}
            />
          )}
        </Workspace>
        {currentView === "sessions" && currentSession && (
          <RightPanel
            activeTab={rightTab}
            onTabChange={setRightTab}
            collapsed={!rightPanelOpen}
            onToggleCollapse={() => setRightPanelOpen((v) => !v)}
            counts={{
              evidence: currentSession.evidence.length,
              audit: currentSession.executedToolCalls.length,
              plan: currentSession.plan.length,
              remediation: currentSession.remediation?.steps.length,
            }}
            track={
              <ExecutionTrackPanel
                events={events}
                running={running}
                session={currentSession}
                progress={sessionProgress}
              />
            }
            evidence={<EvidenceList evidence={currentSession.evidence} highlightId={highlightEvidenceId} />}
            audit={<AuditPanel session={currentSession} events={events} />}
            plan={<PlanPanel session={currentSession} onCitationClick={handleCitationClick} />}
            remediation={<RemediationPanel remediation={currentSession.remediation} status={currentSession.status} />}
            artifacts={<ArtifactsPanel sessionId={currentSession.id} />}
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
  sessionListOpen,
  onToggleSessionList,
  rightPanelOpen,
  onToggleRightPanel,
}: {
  session: AgentSession;
  onTitleSave: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  sessionListOpen: boolean;
  onToggleSessionList: () => void;
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [copied, setCopied] = useState(false);
  const [usage, setUsage] = useState<{ totalTokens: number; cost: number } | null>(null);

  useEffect(() => {
    let active = true;
    fetchSessionUsage(session.id).then((res) => {
      if (active && res) setUsage({ totalTokens: res.totalTokens, cost: res.cost });
    });
    return () => {
      active = false;
    };
  }, [session.id]);

  const copyId = () => {
    navigator.clipboard?.writeText(session.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const skills = Array.from(new Set(session.executedToolCalls.map((call) => call.skill).filter(Boolean)));

  return (
    <div className="session-bar">
      <button
        type="button"
        className="session-bar__btn session-bar__btn--icon"
        onClick={onToggleSessionList}
        title={sessionListOpen ? "折叠会话列表" : "展开会话列表"}
        aria-label="折叠或展开会话列表"
      >
        ☰
      </button>
      <div className="session-bar__lead">
        {editing ? (
          <input
            className="session-bar__title-input"
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
          <h1 className="session-bar__title" onClick={() => setEditing(true)} title="点击编辑标题">
            {session.title}
          </h1>
        )}
        <span className={`session-bar__status ui-status ${sessionStatusClass[session.status] ?? ""}`}>
          {RUNNING_SESSION_STATUSES.has(session.status) && <span className="session-bar__pulse" />}
          {sessionStatusText[session.status] ?? session.status}
        </span>
        {skills.length > 0 && (
          <span className="session-bar__tags" title="本会话已调用的技能">
            {skills.slice(0, 4).map((skill) => (
              <span key={skill} className="session-bar__tag">
                {skill}
              </span>
            ))}
          </span>
        )}
        {session.incidentSummary && (
          <span className="session-bar__summary" title={session.incidentSummary}>
            {session.incidentSummary}
          </span>
        )}
      </div>

      <div className="session-bar__stats" title={`累计成本 $${usage ? usage.cost.toFixed(4) : "—"}`}>
        <span className="session-bar__stat">
          <b>{session.iteration}</b>
          <span>迭代</span>
        </span>
        <span className="session-bar__stat">
          <b>{session.evidence.length}</b>
          <span>证据</span>
        </span>
        <span className="session-bar__stat">
          <b>{session.executedToolCalls.length}</b>
          <span>工具</span>
        </span>
        <span className="session-bar__stat">
          <b>{usage ? (usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : usage.totalTokens) : "—"}</b>
          <span>tokens</span>
        </span>
      </div>

      <div className="session-bar__actions">
        <button
          type="button"
          className="session-bar__btn"
          onClick={onToggleRightPanel}
          title={rightPanelOpen ? "折叠执行跟踪" : "展开执行跟踪"}
        >
          {rightPanelOpen ? "跟踪 \u25b8" : "跟踪 \u25c2"}
        </button>
        <button type="button" className="session-bar__btn" onClick={copyId} title={`复制会话 ID：${session.id}`}>
          {copied ? "已复制" : "#ID"}
        </button>
        <button
          type="button"
          className="session-bar__btn session-bar__btn--danger"
          onClick={() => onDelete(session.id)}
          title="删除会话"
          aria-label="删除会话"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function EventCard({
  event,
  onApprove,
  onAlwaysAllow,
  allowlist,
}: {
  event: TimelineEvent;
  onApprove: (id: string, approved: boolean) => void;
  onAlwaysAllow: (skill: string, tool: string) => void;
  allowlist: Set<string>;
}) {
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
          approvalId={p.approvalId}
          requestedAt={event.timestamp}
          onApprove={() => onApprove(p.approvalId, true)}
          onReject={() => onApprove(p.approvalId, false)}
          onAlwaysAllow={() => onAlwaysAllow(p.skill, p.tool)}
          allowed={allowlist.has(`${p.skill}.${p.tool}`)}
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
      return null; // 结论面板中已展示修复方案，避免重复
    case "rca_conclusion":
      return null; // 由悬浮结论面板展示，避免重复与样式孤儿
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
  approvalId,
  requestedAt,
  onApprove,
  onReject,
  onAlwaysAllow,
  allowed,
}: {
  skill: string;
  tool: string;
  args: Record<string, unknown>;
  risk: any;
  diffPreview?: string;
  approvalId?: string;
  requestedAt?: string;
  onApprove: () => void;
  onReject: () => void;
  onAlwaysAllow: () => void;
  allowed?: boolean;
}) {
  const elapsed = useApprovalElapsed(requestedAt);

  return (
    <div className="approval-card">
      <div className="approval-card__header">
        <span className="approval-card__icon">🔒</span>
        <span className="approval-card__title">需要人工确认 — 变更类操作待审批</span>
        <span className={`risk-badge risk-badge--${risk?.level}`}>{risk?.level}</span>
        {requestedAt && <span className="approval-card__timer">已等待 {elapsed} 秒</span>}
      </div>
      <div className="approval-card__body">
        <div className="approval-card__tool">
          {skill}.{tool}()
        </div>
        {approvalId && <div className="approval-card__call-id">call_id: {approvalId}</div>}
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
        <span className="approval-card__hint">批准后自动执行并回读验证</span>
        <span className="composer__spacer" />
        <button className="btn btn--danger" onClick={onReject}>
          拒绝
        </button>
        <button className="btn btn--approve" onClick={onApprove}>
          批准执行
        </button>
        {risk?.level === "medium" && (
          <button
            className="btn btn--sm approval-card__always"
            onClick={onAlwaysAllow}
            disabled={allowed}
            title="本会话内该工具后续调用免审批（仅 medium 风险）"
          >
            {allowed ? "已在白名单" : "始终允许"}
          </button>
        )}
      </div>
    </div>
  );
}

/** 审批卡「已等待 N 秒」实时计时（对齐原型 approval__timer） */
function useApprovalElapsed(requestedAt?: string): number {
  const calc = () => (requestedAt ? Math.max(0, Math.round((Date.now() - new Date(requestedAt).getTime()) / 1000)) : 0);
  const [elapsed, setElapsed] = useState(calc);
  useEffect(() => {
    if (!requestedAt) return;
    setElapsed(calc);
    const timer = setInterval(() => setElapsed(calc), 1000);
    return () => clearInterval(timer);
  }, [requestedAt]);
  return elapsed;
}
