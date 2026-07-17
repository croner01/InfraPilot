import { useEffect, useRef, useState } from "react";
import "./styles/app.css";
import type { TimelineEvent } from "./lib/types";

const API_BASE = "/api";

interface ApprovalPayload {
  approvalId: string;
  skill: string;
  tool: string;
  args: Record<string, unknown>;
  risk: { level: string; reason: string; blastRadius?: string };
  diffPreview?: string;
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [input, setInput] = useState("");
  const [, setPendingApprovals] = useState<ApprovalPayload[]>([]);
  const [podState, setPodState] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 轮询演示Pod状态,用于右侧上下文面板
  useEffect(() => {
    const t = setInterval(() => {
      fetch(`${API_BASE}/demo/pod-state`).then((r) => r.json()).then(setPodState).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  async function startSession() {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "故障排查会话" }),
    });
    const session = await res.json();
    setSessionId(session.id);
    setEvents([]);
    setPendingApprovals([]);

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?sessionId=${session.id}`);
    ws.onmessage = (msg) => {
      const ev: TimelineEvent = JSON.parse(msg.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "approval_request") {
        setPendingApprovals((prev) => [...prev, ev.payload]);
      }
      if (ev.type === "approval_decision") {
        setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== ev.payload.approvalId));
      }
    };
    wsRef.current = ws;
  }

  async function sendMessage() {
    if (!sessionId || !input.trim()) return;
    const message = input.trim();
    setInput("");
    setEvents((prev) => [
      ...prev,
      { id: crypto.randomUUID(), sessionId, type: "user_message", timestamp: new Date().toISOString(), payload: { content: message } },
    ]);
    await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
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

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">🛰️ InfraPilot Agent</div>
        <button className="btn primary" onClick={startSession}>+ 新建排查会话</button>
        <button className="btn ghost" onClick={resetDemo}>重置演示场景(order-api)</button>
        <div className="hint">
          <p>演示场景: order-api 服务存在内存泄漏,会持续 OOMKilled 并 CrashLoopBackOff。</p>
          <p>试着输入: <code>"生产环境有服务一直重启,帮我看看什么原因"</code></p>
        </div>
      </aside>

      <main className="timeline-panel">
        {!sessionId && <div className="empty-state">点击左侧「新建排查会话」开始</div>}
        <div className="timeline" ref={scrollRef}>
          {events.map((ev) => <EventCard key={ev.id} event={ev} onDecide={decideApproval} />)}
        </div>
        {sessionId && (
          <div className="composer">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="描述你遇到的故障现象..."
            />
            <button className="btn primary" onClick={sendMessage}>发送</button>
          </div>
        )}
      </main>

      <aside className="context-panel">
        <h3>关联上下文</h3>
        {podState && (
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
                last state: <span className={podState.lastState.reason === "OOMKilled" ? "text-danger" : ""}>{podState.lastState.reason} (exit {podState.lastState.exitCode})</span>
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
        )}
      </aside>
    </div>
  );
}

function EventCard({ event, onDecide }: { event: TimelineEvent; onDecide: (id: string, approved: boolean) => void }) {
  const { type, payload } = event;

  if (type === "user_message") {
    return <div className="msg user">{payload.content}</div>;
  }
  if (type === "assistant_message") {
    const isRca = payload.content?.includes("根因") || payload.content?.includes("置信度");
    return <div className={`msg assistant ${isRca ? "rca" : ""}`}>{payload.content}</div>;
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
          <div>操作: <code>{payload.skill}.{payload.tool}</code></div>
          {payload.diffPreview && <pre className="diff">{payload.diffPreview}</pre>}
          {payload.risk.blastRadius && <div className="blast">影响范围: {payload.risk.blastRadius}</div>}
        </div>
        <div className="approval-actions">
          <button className="btn approve" onClick={() => onDecide(payload.approvalId, true)}>✅ 批准执行</button>
          <button className="btn reject" onClick={() => onDecide(payload.approvalId, false)}>❌ 拒绝</button>
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
    return null; // 已由 assistant_message 展示完整内容, 避免重复
  }
  return null;
}
