import { useCallback, useEffect, useState } from "react";
import {
  createSchedule,
  deleteEvalCase,
  deleteSchedule,
  deleteTraceSystem,
  fetchSchedulerStatus,
  fetchTraceSystems,
  judgeSession,
  listEvalCases,
  listEvalRuns,
  listSchedules,
  promoteSession,
  runSchedule,
  testTraceSystem,
  updateSchedule,
  upsertTraceSystem,
  validateCron,
  type EvalCase,
  type EvalRun,
  type JudgementResult,
  type Schedule,
  type SchedulerStatus,
  type TraceBackend,
} from "../../lib/api.js";

type Notify = (msg: string, type?: "error" | "success") => void;

function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <div className="empty-state__message">{message}</div>
    </div>
  );
}

// ============================================================================
// Trace 数据源（Jaeger / Tempo）—— 对应 /api/config/trace-systems
// ============================================================================

const TRACE_TYPES: { value: string; label: string }[] = [
  { value: "jaeger", label: "Jaeger" },
  { value: "tempo", label: "Grafana Tempo" },
  { value: "skywalking", label: "SkyWalking OTLP" },
];

function newTraceBackend(): TraceBackend {
  return {
    id: `trace-${Date.now().toString(36)}`,
    type: "jaeger",
    name: "",
    url: "",
    enabled: true,
  };
}

export function TraceSection({ notify }: { notify: Notify }) {
  const [systems, setSystems] = useState<TraceBackend[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback((next?: TraceBackend[]) => {
    if (next) {
      setSystems(next);
      return;
    }
    fetchTraceSystems((err) => notify(err.message)).then((res) => {
      if (res) setSystems(res.systems);
      setLoading(false);
    });
  }, [notify]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="ds-stack">
      {loading ? (
        <div className="settings-hint">加载中…</div>
      ) : systems.length === 0 ? (
        <EmptyState icon="🧭" message="暂无 Trace 数据源：接入 Jaeger / Tempo 后，Agent 可做调用链级根因分析。" />
      ) : (
        systems.map((s) => (
          <TraceCard key={s.id} system={s} notify={notify} onSaved={reload} />
        ))
      )}
      <TraceNewForm notify={notify} onSaved={reload} />
    </div>
  );
}

function TraceCard({
  system,
  notify,
  onSaved,
}: {
  system: TraceBackend;
  notify: Notify;
  onSaved: (systems: TraceBackend[]) => void;
}) {
  const [draft, setDraft] = useState(system);
  const [busy, setBusy] = useState(false);
  const [services, setServices] = useState<string[] | null>(null);

  useEffect(() => setDraft(system), [system.id]);

  const save = async () => {
    setBusy(true);
    const res = await upsertTraceSystem(draft, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onSaved(res.systems);
      notify("已保存", "success");
    }
  };

  const remove = async () => {
    if (!confirm(`确定删除 Trace 数据源「${system.name}」吗？`)) return;
    const res = await deleteTraceSystem(system.id, (err) => notify(err.message));
    if (res) {
      onSaved(res.systems);
      notify("已删除", "success");
    }
  };

  const test = async () => {
    setBusy(true);
    const res = await testTraceSystem(system.id, (err) => notify(err.message));
    setBusy(false);
    if (!res) return;
    setServices(res.services ?? []);
    notify(`连接成功，发现 ${res.services?.length ?? 0} 个服务`, "success");
  };

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <span className="log-system-card__name">{system.name || system.id}</span>
        </div>
        <div className="log-system-card__status">
          <span className={`status-dot ${system.enabled ? "status-dot--ok" : "status-dot--warn"}`} />
          {system.enabled ? "已启用" : "已停用"}
        </div>
      </div>
      <div className="log-system-card__body">
        <label className="field">
          <span className="field__label">类型</span>
          <select className="input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
            {TRACE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">名称</span>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如 prod-jaeger" />
        </label>
        <label className="field">
          <span className="field__label">地址</span>
          <input className="input" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="http://127.0.0.1:16686" />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span>启用</span>
        </label>
      </div>
      {services && services.length > 0 && (
        <div className="settings-hint">服务：{services.slice(0, 12).join("、")}{services.length > 12 ? ` 等 ${services.length} 个` : ""}</div>
      )}
      <div className="log-system-card__actions">
        <button className="btn btn--sm btn--primary" onClick={save} disabled={busy}>保存</button>
        <button className="btn btn--sm btn--secondary" onClick={test} disabled={busy}>测试连接</button>
        <button className="btn btn--sm btn--ghost" onClick={remove}>删除</button>
      </div>
    </div>
  );
}

function TraceNewForm({ notify, onSaved }: { notify: Notify; onSaved: (systems: TraceBackend[]) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TraceBackend>(newTraceBackend);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!draft.url.trim()) {
      notify("请填写 Trace 数据源地址", "error");
      return;
    }
    setBusy(true);
    const res = await upsertTraceSystem({ ...draft, name: draft.name || draft.url }, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onSaved(res.systems);
      setDraft(newTraceBackend());
      setOpen(false);
      notify("已添加", "success");
    }
  };

  if (!open) {
    return (
      <button className="btn btn--sm btn--secondary" onClick={() => setOpen(true)}>＋ 添加 Trace 数据源</button>
    );
  }
  return (
    <div className="log-system-card">
      <div className="log-system-card__body">
        <label className="field">
          <span className="field__label">类型</span>
          <select className="input" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
            {TRACE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">名称</span>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如 prod-jaeger" />
        </label>
        <label className="field">
          <span className="field__label">地址</span>
          <input className="input" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="http://127.0.0.1:16686" />
        </label>
      </div>
      <div className="log-system-card__actions">
        <button className="btn btn--sm btn--primary" onClick={submit} disabled={busy}>添加</button>
        <button className="btn btn--sm btn--ghost" onClick={() => { setOpen(false); setDraft(newTraceBackend()); }}>取消</button>
      </div>
    </div>
  );
}

// ============================================================================
// 定时任务 —— 对应 /api/schedules
// ============================================================================

const CRON_PRESETS = [
  { label: "每 5 分钟", cron: "*/5 * * * *" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每天 3 点", cron: "0 3 * * *" },
  { label: "每周一 9 点", cron: "0 9 * * 1" },
];

export function SchedulesSection({ notify }: { notify: Notify }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    listSchedules((err) => notify(err.message)).then((res) => res && setSchedules(res.schedules));
    fetchSchedulerStatus((err) => notify(err.message)).then((res) => res && setStatus(res));
    setLoading(false);
  }, [notify]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="ds-stack">
      {status && (
        <div className="settings-hint">
          调度器：{status.running ? "运行中" : "未运行"} · 每 {status.tickSeconds}s 轮询 · 共 {status.count} 个任务
          {status.nextRunAt ? ` · 下次执行 ${new Date(status.nextRunAt).toLocaleString()}` : ""}
        </div>
      )}
      {loading ? (
        <div className="settings-hint">加载中…</div>
      ) : schedules.length === 0 ? (
        <EmptyState icon="⏰" message="暂无定时任务：可配置周期性巡检定式诊断，结果自动生成会话。" />
      ) : (
        schedules.map((s) => (
          <ScheduleCard key={s.id} schedule={s} notify={notify} onChanged={reload} />
        ))
      )}
      <ScheduleNewForm notify={notify} onSaved={reload} />
    </div>
  );
}

function ScheduleCard({ schedule, notify, onChanged }: { schedule: Schedule; notify: Notify; onChanged: () => void }) {
  const [draft, setDraft] = useState(schedule);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(schedule), [schedule.id, schedule.updatedAt]);

  const save = async () => {
    setBusy(true);
    const res = await updateSchedule(schedule.id, {
      name: draft.name,
      cron: draft.cron,
      prompt: draft.prompt,
      enabled: draft.enabled,
    }, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onChanged();
      notify("已保存", "success");
    }
  };

  const remove = async () => {
    if (!confirm(`确定删除定时任务「${schedule.name}」吗？`)) return;
    const res = await deleteSchedule(schedule.id, (err) => notify(err.message));
    if (res) {
      onChanged();
      notify("已删除", "success");
    }
  };

  const runNow = async () => {
    setBusy(true);
    const res = await runSchedule(schedule.id, (err) => notify(err.message));
    setBusy(false);
    if (res?.ok) {
      notify(`已触发，会话 ${res.sessionId ?? ""}`, "success");
      onChanged();
    } else if (res) {
      notify(res.error || "触发失败", "error");
    }
  };

  return (
    <div className="log-system-card">
      <div className="log-system-card__header">
        <div className="log-system-card__title">
          <span className="log-system-card__name">{schedule.name}</span>
        </div>
        <div className="log-system-card__status">
          <span className={`status-dot ${schedule.enabled ? "status-dot--ok" : "status-dot--warn"}`} />
          {schedule.enabled ? "已启用" : "已停用"}
        </div>
      </div>
      <div className="log-system-card__body">
        <label className="field">
          <span className="field__label">名称</span>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field__label">Cron</span>
          <input className="input" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} placeholder="*/5 * * * *" />
        </label>
        <label className="field">
          <span className="field__label">诊断指令</span>
          <textarea className="input textarea" rows={2} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span>启用</span>
        </label>
      </div>
      <div className="settings-hint">
        {schedule.nextRunAt ? `下次 ${new Date(schedule.nextRunAt).toLocaleString()}` : "下次执行时间待计算"}
        {` · 已执行 ${schedule.runCount ?? 0} 次`}
        {schedule.lastRunAt ? ` · 上次 ${new Date(schedule.lastRunAt).toLocaleString()}` : ""}
        {schedule.lastError ? ` · 最近错误：${schedule.lastError}` : ""}
      </div>
      <div className="log-system-card__actions">
        <button className="btn btn--sm btn--primary" onClick={save} disabled={busy}>保存</button>
        <button className="btn btn--sm btn--secondary" onClick={runNow} disabled={busy}>立即执行</button>
        <button className="btn btn--sm btn--ghost" onClick={remove}>删除</button>
      </div>
    </div>
  );
}

function ScheduleNewForm({ notify, onSaved }: { notify: Notify; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("*/5 * * * *");
  const [prompt, setPrompt] = useState("");
  const [nextRun, setNextRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    const res = await validateCron(cron, (err) => notify(err.message));
    setNextRun(res?.nextRun ?? null);
    if (res) notify(`Cron 合法，下次 ${new Date(res.nextRun).toLocaleString()}`, "success");
  };

  const submit = async () => {
    if (!prompt.trim()) {
      notify("请填写诊断指令", "error");
      return;
    }
    setBusy(true);
    const res = await createSchedule({ name, cron, prompt }, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      onSaved();
      setName("");
      setPrompt("");
      setNextRun(null);
      setOpen(false);
      notify("已创建", "success");
    }
  };

  if (!open) {
    return <button className="btn btn--sm btn--secondary" onClick={() => setOpen(true)}>＋ 新建定时任务</button>;
  }
  return (
    <div className="log-system-card">
      <div className="log-system-card__body">
        <label className="field">
          <span className="field__label">名称</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 夜间巡检" />
        </label>
        <label className="field">
          <span className="field__label">Cron</span>
          <input className="input" value={cron} onChange={(e) => { setCron(e.target.value); setNextRun(null); }} placeholder="*/5 * * * *" />
        </label>
        <div className="settings-hint">
          常用：
          {CRON_PRESETS.map((p) => (
            <button key={p.cron} className="btn btn--sm btn--ghost" onClick={() => { setCron(p.cron); setNextRun(null); }}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">诊断指令</span>
          <textarea className="input textarea" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="如：检查所有命名空间 Pod 重启与 OOM 情况" />
        </label>
        {nextRun && <div className="settings-hint">下次执行：{new Date(nextRun).toLocaleString()}</div>}
      </div>
      <div className="log-system-card__actions">
        <button className="btn btn--sm btn--secondary" onClick={check}>校验 Cron</button>
        <button className="btn btn--sm btn--primary" onClick={submit} disabled={busy}>创建</button>
        <button className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  );
}

// ============================================================================
// 评测与回流（LLM-as-judge）—— 对应 /api/eval
// ============================================================================

export function EvalSection({ notify }: { notify: Notify }) {
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [casesDir, setCasesDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState("");
  const [expected, setExpected] = useState("");
  const [allowLlm, setAllowLlm] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<JudgementResult | null>(null);

  const reload = useCallback(() => {
    listEvalCases((err) => notify(err.message)).then((res) => {
      if (res) {
        setCases(res.cases);
        setCasesDir(res.casesDir);
      }
    });
    listEvalRuns(undefined, 50, (err) => notify(err.message)).then((res) => res && setRuns(res.runs));
    setLoading(false);
  }, [notify]);

  useEffect(() => {
    reload();
  }, [reload]);

  const judge = async () => {
    if (!sessionId.trim()) {
      notify("请填写会话 ID", "error");
      return;
    }
    setBusy(true);
    const res = await judgeSession({ sessionId: sessionId.trim(), expected: expected.trim() || undefined, allowLlm }, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      setVerdict(res);
      notify(`评判完成：${res.verdict}（${(res.score * 100).toFixed(0)} 分）`, res.verdict === "pass" ? "success" : "error");
      reload();
    }
  };

  const promote = async () => {
    if (!sessionId.trim()) {
      notify("请填写会话 ID", "error");
      return;
    }
    setBusy(true);
    const res = await promoteSession({ sessionId: sessionId.trim(), expected: expected.trim() || undefined }, (err) => notify(err.message));
    setBusy(false);
    if (res) {
      notify("已回流为回归用例", "success");
      reload();
    }
  };

  const remove = async (id: string) => {
    const res = await deleteEvalCase(id, (err) => notify(err.message));
    if (res) {
      notify("已删除", "success");
      reload();
    }
  };

  return (
    <div className="ds-stack">
      <div className="log-system-card">
        <div className="log-system-card__header">
          <div className="log-system-card__title"><span className="log-system-card__name">LLM-as-judge 评判</span></div>
        </div>
        <div className="log-system-card__body">
          <label className="field">
            <span className="field__label">会话 ID</span>
            <input className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder="粘贴诊断会话 ID" />
          </label>
          <label className="field">
            <span className="field__label">金标准结论（可选）</span>
            <input className="input" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="期望的根因结论，用于关键词比对" />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={allowLlm} onChange={(e) => setAllowLlm(e.target.checked)} />
            <span>调用 LLM 评分（关闭则用启发式评分）</span>
          </label>
        </div>
        <div className="log-system-card__actions">
          <button className="btn btn--sm btn--primary" onClick={judge} disabled={busy}>评判</button>
          <button className="btn btn--sm btn--secondary" onClick={promote} disabled={busy}>回流为用例</button>
        </div>
      </div>

      {verdict && (
        <div className="log-system-card">
          <div className="log-system-card__header">
            <div className="log-system-card__title"><span className="log-system-card__name">评判结果</span></div>
            <div className="log-system-card__status">
              <span className={`status-dot ${verdict.verdict === "pass" ? "status-dot--ok" : "status-dot--err"}`} />
              {verdict.verdict} · {(verdict.score * 100).toFixed(0)} 分
            </div>
          </div>
          <div className="log-system-card__body">
            <div className="settings-hint">{verdict.rationale}</div>
            {verdict.strengths && verdict.strengths.length > 0 && <div className="settings-hint">优点：{verdict.strengths.join("；")}</div>}
            {verdict.weaknesses && verdict.weaknesses.length > 0 && <div className="settings-hint">不足：{verdict.weaknesses.join("；")}</div>}
            <div className="settings-hint">模式：{verdict.mode} · 幻觉风险：{verdict.hallucination_risk ?? "-"}</div>
          </div>
        </div>
      )}

      <div className="log-system-card">
        <div className="log-system-card__header">
          <div className="log-system-card__title"><span className="log-system-card__name">回归用例（{cases.length}）</span></div>
          {casesDir && <div className="log-system-card__status">{casesDir}</div>}
        </div>
        {loading ? (
          <div className="settings-hint">加载中…</div>
        ) : cases.length === 0 ? (
          <EmptyState icon="🧪" message="暂无用例：可评判会话后「回流为用例」，或用 CLI 导入。" />
        ) : (
          <table className="usage-table">
            <thead>
              <tr><th>名称</th><th>来源</th><th>问题</th><th>操作</th></tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td className="usage-table__title">{c.case?.name || c.id}</td>
                  <td>{c.origin}</td>
                  <td>{c.case?.message ?? "—"}</td>
                  <td>
                    <button className="btn btn--sm btn--ghost" onClick={() => remove(c.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="log-system-card">
        <div className="log-system-card__header">
          <div className="log-system-card__title"><span className="log-system-card__name">评测记录（{runs.length}）</span></div>
        </div>
        {runs.length === 0 ? (
          <div className="settings-hint">暂无评测记录</div>
        ) : (
          <table className="usage-table">
            <thead>
              <tr><th>时间</th><th>用例</th><th>结果</th><th>分数</th><th>会话</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                  <td className="usage-table__title">{r.case_id}</td>
                  <td>
                    <span className={`status-dot ${r.passed ? "status-dot--ok" : "status-dot--err"}`} />
                    {r.passed ? "通过" : "未通过"}
                  </td>
                  <td>{(r.score * 100).toFixed(0)}</td>
                  <td>{r.session_id ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
