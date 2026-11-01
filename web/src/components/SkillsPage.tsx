import { useCallback, useEffect, useState } from "react";
import {
  approveFactoryDraft,
  exportDrawioDiagram,
  generateFactoryDraft,
  generateDrawioFlowchart,
  installSkill,
  listCuratedSkills,
  listFactoryPending,
  listFactorySessions,
  listSkills,
  rejectFactoryDraft,
  setSkillEnabled,
  uninstallSkill,
  type CuratedSkill,
  type FactoryDraft,
  type FactorySession,
  type LogRelation,
  type SkillPackageInfo,
  downloadDrawioUrl,
} from "../lib/api.js";
import { DrawioImageViewer } from "./DrawioImageViewer.js";

type NotifyFn = (msg: string, type?: "error" | "success") => void;

interface SkillsPageProps {
  notify: NotifyFn;
}

type SkillTab = "market" | "installed" | "factory" | "drawio";

const TABS: Array<{ key: SkillTab; label: string; desc: string }> = [
  { key: "market", label: "技能市场", desc: "安装开源 SKILL.md 技能包" },
  { key: "installed", label: "已安装技能", desc: "启停与卸载" },
  { key: "factory", label: "Skill Factory", desc: "从诊断会话自主生成技能" },
  { key: "drawio", label: "流程图生成", desc: "依赖关系导出 draw.io" },
];

export function SkillsPage({ notify }: SkillsPageProps) {
  const [tab, setTab] = useState<SkillTab>("market");
  return (
    <div className="skills-page">
      <div className="page-header">
        <h1 className="page-header__title">技能中心</h1>
        <p className="page-header__subtitle">安装开源技能、管理已装技能，并支持从诊断会话自主沉淀新技能</p>
      </div>
      <div className="skills-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`skills-tab${tab === t.key ? " skills-tab--active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            <span className="skills-tab__label">{t.label}</span>
            <span className="skills-tab__desc">{t.desc}</span>
          </button>
        ))}
      </div>
      <div className="main__content">
        {tab === "market" && <SkillMarketSection notify={notify} />}
        {tab === "installed" && <SkillPackagesSection notify={notify} />}
        {tab === "factory" && <SkillFactorySection notify={notify} />}
        {tab === "drawio" && <DrawioFlowchartSkill notify={notify} />}
      </div>
    </div>
  );
}

/* ================= 技能市场 ================= */

/** 开源技能生态索引（前端演示；后端可扩展远程索引源） */
const ECO_SOURCES: Array<{
  repo: string;
  label: string;
  desc: string;
  skills: Array<{ path: string; name: string; description: string }>;
}> = [
  {
    repo: "anthropics/skills",
    label: "anthropics/skills",
    desc: "Anthropic 官方技能仓库",
    skills: [
      { path: "skills/pdf", name: "pdf", description: "PDF 阅读与文本抽取，报告归档场景" },
      { path: "skills/docx", name: "docx", description: "Word 文档生成，诊断报告导出" },
      { path: "skills/xlsx", name: "xlsx", description: "Excel 表格处理，指标报表生成" },
      { path: "skills/pptx", name: "pptx", description: "PPT 生成，复盘汇报材料" },
    ],
  },
  {
    repo: "openai/skills",
    label: "openai/skills",
    desc: "OpenAI 官方实验性技能",
    skills: [
      { path: "skills/.experimental/ceph-rbd-108", name: "ceph-rbd-108", description: "Ceph RBD 存储故障排查" },
      { path: "skills/.experimental/k8s-pending-pod", name: "k8s-pending-pod", description: "K8s Pod Pending 根因排查" },
    ],
  },
];

function SkillMarketSection({ notify }: { notify: NotifyFn }) {
  const [curated, setCurated] = useState<CuratedSkill[]>([]);
  const [repo, setRepo] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<string>("");

  useEffect(() => {
    listCuratedSkills((err) => notify(err.message)).then((res) => {
      if (res) setCurated(res.skills);
    });
  }, []);

  const fill = (r: string, p: string) => {
    setRepo(r);
    setSkillPath(p);
  };

  const handleInstall = async () => {
    if (!repo.trim() || !skillPath.trim()) {
      notify("请填写 repo 与 path");
      return;
    }
    setInstalling(true);
    // 模拟安装阶段提示（真实安装仍走后端 git sparse-checkout）
    const steps = ["克隆仓库…", "校验 SKILL.md…", "复制技能文件…", "刷新注册表…"];
    let i = 0;
    setProgress(steps[0]);
    const timer = window.setInterval(() => {
      i = Math.min(i + 1, steps.length - 1);
      setProgress(steps[i]);
    }, 400);
    const res = await installSkill(
      { repo: repo.trim(), path: skillPath.trim(), ref: ref.trim() || undefined, token: token.trim() || undefined },
      (err) => notify(err.message),
    );
    window.clearInterval(timer);
    setInstalling(false);
    setProgress("");
    if (res) {
      notify(`${res.name} 安装成功，下一轮诊断自动生效`, "success");
      setRepo("");
      setSkillPath("");
      setRef("");
      setToken("");
    }
  };

  return (
    <>
      <section className="skill-card">
        <div className="skill-card__header">
          <div className="skill-card__icon">🛒</div>
          <div>
            <h2 className="skill-card__title">开源技能生态</h2>
            <p className="skill-card__desc">点击卡片快速填入安装参数；支持任意 GitHub 仓库中的 SKILL.md 技能包。</p>
          </div>
        </div>
        <div className="skill-card__body">
          {ECO_SOURCES.map((src) => (
            <div key={src.repo} className="eco-source">
              <div className="eco-source__head">
                <span className="eco-source__repo">{src.label}</span>
                <span className="eco-source__desc">{src.desc}</span>
              </div>
              <div className="eco-grid">
                {src.skills.map((s) => {
                  const installed = curated.some((c) => c.repo === src.repo && c.path === s.path);
                  return (
                    <div key={s.path} className="eco-card" onClick={() => fill(src.repo, s.path)} title="点击填入安装表单">
                      <div className="eco-card__top">
                        <span className="eco-card__name">{s.name}</span>
                        {installed ? <span className="tag">已收录</span> : <span className="tag tag--accent">可安装</span>}
                      </div>
                      <p className="eco-card__desc">{s.description}</p>
                      <code className="eco-card__path">{s.path}</code>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="settings-hint">
            需要更多来源？直接在下方表单填写 <code>repo / path</code> 安装社区技能；安全扫描与签名校验为规划能力。
          </div>
        </div>
      </section>

      <section className="skill-card">
        <div className="skill-card__header">
          <div className="skill-card__icon">⬇️</div>
          <div>
            <h2 className="skill-card__title">安装技能包</h2>
            <p className="skill-card__desc">从 GitHub 仓库安装（git sparse-checkout），安装后默认启用。</p>
          </div>
        </div>
        <div className="skill-card__body">
          {curated.length > 0 && (
            <div className="curated-list">
              {curated.map((c) => (
                <button key={`${c.repo}/${c.path}`} className="curated-chip" onClick={() => fill(c.repo, c.path)} title={c.description}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <div className="install-form">
            <div className="install-form__row">
              <input className="input" placeholder="repo，如 anthropics/skills" value={repo} onChange={(e) => setRepo(e.target.value)} />
              <input className="input" placeholder="path，如 skills/pdf" value={skillPath} onChange={(e) => setSkillPath(e.target.value)} />
            </div>
            <div className="install-form__row">
              <input className="input" placeholder="ref（可选，默认 main）" value={ref} onChange={(e) => setRef(e.target.value)} />
              <input className="input" placeholder="token（可选，私有仓库）" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
            <div className="install-form__actions">
              <button className="btn btn--primary" onClick={handleInstall} disabled={installing}>
                {installing ? "安装中..." : "安装"}
              </button>
              {installing && progress && <span className="install-progress">{progress}</span>}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ================= Skill Factory（自主生成） ================= */

function SkillFactorySection({ notify }: { notify: NotifyFn }) {
  const [step, setStep] = useState(1);
  const [sessions, setSessions] = useState<FactorySession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [generating, setGenerating] = useState(false);
  const [pending, setPending] = useState<FactoryDraft[]>([]);

  const loadSessions = useCallback(async () => {
    const res = await listFactorySessions((err) => notify(err.message));
    if (res) setSessions(res.sessions);
  }, [notify]);

  const loadPending = useCallback(async () => {
    const res = await listFactoryPending((err) => notify(err.message));
    if (res) setPending(res.drafts);
  }, [notify]);

  useEffect(() => {
    void loadSessions();
    void loadPending();
  }, [loadSessions, loadPending]);

  const generate = async () => {
    if (!sessionId) return;
    setGenerating(true);
    const res = await generateFactoryDraft(sessionId, (err) => notify(err.message));
    setGenerating(false);
    if (!res) return;
    setName(res.name);
    setContent(res.content);
    setStep(2);
    notify("已从会话时间线提取 playbook，生成预览", "success");
  };

  const submitDraft = async () => {
    if (!name.trim()) {
      notify("请填写技能名称");
      return;
    }
    const res = await approveFactoryDraft(name.trim(), content, (err) => notify(err.message));
    if (!res) return;
    notify(`技能 ${res.name} 已入库`, "success");
    setStep(3);
    void loadPending();
  };

  const discardDraft = async (draftName: string) => {
    const res = await rejectFactoryDraft(draftName, (err) => notify(err.message));
    if (!res) return;
    notify("草稿已丢弃", "success");
    void loadPending();
  };

  return (
    <section className="skill-card">
      <div className="skill-card__header">
        <div className="skill-card__icon">🏭</div>
        <div>
          <h2 className="skill-card__title">Skill Factory — 自主生成技能</h2>
          <p className="skill-card__desc">
            从历史诊断会话中提取时间线与结论，由 LLM 生成标准化 SKILL.md playbook，人工审核后入库供后续诊断召回。
          </p>
        </div>
        <div className="factory-steps">
          {["选择会话", "生成预览", "审核入库"].map((s, i) => (
            <span key={s} className={`factory-step${step > i ? " factory-step--done" : ""}${step === i + 1 ? " factory-step--active" : ""}`}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
      </div>
      <div className="skill-card__body">
        {step === 1 && (
          <>
            <div className="factory-session-list">
              {sessions.length === 0 && <div className="settings-hint">暂无已得出结论的会话，先完成一次诊断后再来沉淀。</div>}
              {sessions.map((s) => (
                <label key={s.id} className={`factory-session${sessionId === s.id ? " factory-session--selected" : ""}`}>
                  <input
                    type="radio"
                    name="factory-session"
                    checked={sessionId === s.id}
                    onChange={() => setSessionId(s.id)}
                  />
                  <div className="factory-session__main">
                    <div className="factory-session__title">{s.title}</div>
                    <div className="factory-session__meta">
                      结论：{s.concluded?.summary ?? "—"} · {s.planSteps ?? 0} 步 · 工具 {(s.tools ?? []).join(" / ") || "—"}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="skill-card__actions">
              <button className="btn btn--primary" disabled={!sessionId || generating} onClick={generate}>
                {generating ? "提取时间线并生成中…" : "下一步：生成 SKILL.md 预览"}
              </button>
            </div>
          </>
        )}
        {step >= 2 && (
          <>
            <div className="form-group">
              <label className="form-label">技能名称（skill 标识）</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">SKILL.md 内容（可编辑）</label>
              <textarea className="factory-editor" value={content} onChange={(e) => setContent(e.target.value)} rows={16} spellCheck={false} />
            </div>
            <div className="skill-card__actions">
              <button className="btn" onClick={() => setStep(1)}>← 上一步</button>
              <span className="factory-hint">提交后由 Policy Engine 校验工具名与 allowlist，通过后写入技能库。</span>
              <button className="btn btn--primary" onClick={submitDraft}>提交审核入库</button>
            </div>
          </>
        )}
        {pending.length > 0 && (
          <div className="factory-session-list" style={{ marginTop: 12 }}>
            <div className="settings-hint">待审核草稿：</div>
            {pending.map((d) => (
              <div key={d.name} className="factory-session">
                <div className="factory-session__main">
                  <div className="factory-session__title">{d.name}</div>
                </div>
                <button className="btn btn--sm btn--danger-ghost" onClick={() => discardDraft(d.name)}>丢弃</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SkillPackagesSection({ notify }: { notify: NotifyFn }) {
  const [skills, setSkills] = useState<SkillPackageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const res = await listSkills((err) => notify(err.message));
    if (res) setSkills(res.skills);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleToggle = async (s: SkillPackageInfo) => {
    setBusy(s.name);
    const res = await setSkillEnabled(s.name, !s.enabled, (err) => notify(err.message));
    if (res) {
      notify(`${s.name} 已${s.enabled ? "禁用" : "启用"}`, "success");
      await load();
    }
    setBusy(null);
  };

  const handleUninstall = async (s: SkillPackageInfo) => {
    if (!window.confirm(`确认卸载技能 ${s.name}？`)) return;
    setBusy(s.name);
    const res = await uninstallSkill(s.name, (err) => notify(err.message));
    if (res) {
      notify(`${s.name} 已卸载`, "success");
      await load();
    }
    setBusy(null);
  };

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <section className="skill-card skill-packages">
      <div className="skill-card__header">
        <div className="skill-card__icon">🧩</div>
        <div>
          <h2 className="skill-card__title">已安装技能包</h2>
          <p className="skill-card__desc">
            共 {skills.length} 个，启用 {enabledCount} 个。诊断时按相关性自动召回并注入指令。
          </p>
        </div>
      </div>
      <div className="skill-card__body">
        {loading ? (
          <div className="empty-hint">加载中...</div>
        ) : skills.length === 0 ? (
          <div className="empty-hint">暂无已安装技能包，可在「技能市场」安装。</div>
        ) : (
          <div className="skill-package-grid">
            {skills.map((s) => {
              const builtin = s.name.startsWith("sre-");
              return (
                <div key={s.name} className={`skill-package-card${s.enabled ? "" : " skill-package-card--disabled"}`}>
                  <div className="skill-package-card__header">
                    <span className="chip">{s.enabled ? "启用" : "禁用"}</span>
                    {builtin && <span className="chip chip--builtin">内置</span>}
                  </div>
                  <h3 className="skill-package-card__title">{s.name}</h3>
                  <p className="skill-package-card__desc">{s.description}</p>
                  <div className="skill-package-card__meta">
                    <span>references {s.references.length}</span>
                    <span>scripts {s.scripts.length}</span>
                    {s.version && <span>{s.version}</span>}
                  </div>
                  <div className="skill-package-card__actions">
                    <label className="toggle">
                      <input type="checkbox" checked={s.enabled} disabled={busy === s.name} onChange={() => handleToggle(s)} />
                      <span className="toggle__track" />
                      <span className="toggle__label">{s.enabled ? "启用" : "禁用"}</span>
                    </label>
                    {!builtin && (
                      <button className="btn btn--sm btn--danger-ghost" disabled={busy === s.name} onClick={() => handleUninstall(s)}>
                        卸载
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/* ================= Draw.io 流程图 ================= */

function DrawioFlowchartSkill({ notify }: { notify: NotifyFn }) {
  const [title, setTitle] = useState("日志调用关系流程图");
  const [relations, setRelations] = useState<LogRelation[]>([
    { source: "order-api", target: "payment-service", relation: "调用支付" },
    { source: "payment-service", target: "mysql", relation: "写入订单" },
    { source: "order-api", target: "redis", relation: "缓存读取" },
  ]);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState<"png" | "svg" | "pdf" | null>(null);
  const [result, setResult] = useState<{ xml: string; outputPath: string; nodeCount: number; edgeCount: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const addRelation = () => {
    setRelations([...relations, { source: "", target: "", relation: "" }]);
  };

  const updateRelation = (index: number, field: keyof LogRelation, value: string) => {
    const next = [...relations];
    next[index] = { ...next[index], [field]: value };
    setRelations(next);
  };

  const removeRelation = (index: number) => {
    const next = [...relations];
    next.splice(index, 1);
    setRelations(next);
  };

  const handleGenerate = async () => {
    const valid = relations.filter((r) => r.source.trim() && r.target.trim());
    if (valid.length === 0) {
      notify("请至少填写一条有效的日志关系");
      return;
    }
    setLoading(true);
    setResult(null);
    setPreview(null);
    const res = await generateDrawioFlowchart(valid, title.trim() || undefined, (err) => notify(err.message));
    if (!res) {
      setLoading(false);
      return;
    }
    setResult({
      xml: res.xml,
      outputPath: res.output_path,
      nodeCount: res.node_count,
      edgeCount: res.edge_count,
    });
    // 自动生成 PNG 预览
    const pngRes = await exportDrawioDiagram(res.output_path, "png", (err) => notify(err.message));
    setLoading(false);
    if (pngRes) {
      setPreview(`data:image/png;base64,${pngRes.data}`);
    }
  };

  const downloadFromBase64 = (base64: string, filename: string, mime: string) => {
    const link = document.createElement("a");
    link.href = `data:${mime};base64,${base64}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExport = async (format: "png" | "svg" | "pdf") => {
    if (!result) return;
    setExportLoading(format);
    const res = await exportDrawioDiagram(result.outputPath, format, (err) => notify(err.message));
    setExportLoading(null);
    if (!res) return;
    const mime = format === "png" ? "image/png" : format === "svg" ? "image/svg+xml" : "application/pdf";
    const filename = res.output_path.split("/").pop() || `diagram.${format}`;
    downloadFromBase64(res.data, filename, mime);
    if (format === "png" || format === "svg") {
      setPreview(`data:${mime};base64,${res.data}`);
    }
  };

  return (
    <div className="skill-card">
      <div className="skill-card__header">
        <div className="skill-card__icon">📊</div>
        <div>
          <h2 className="skill-card__title">Draw.io 流程图</h2>
          <p className="skill-card__desc">根据日志调用/依赖关系自动生成 draw.io 流程图,并导出为 PNG/SVG/PDF。</p>
        </div>
      </div>

      <div className="skill-card__body">
        <div className="form-group">
          <label className="form-label">流程图标题</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如: 订单核心链路调用关系"
          />
        </div>

        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label">日志关系</label>
            <button className="btn btn--sm btn--ghost" onClick={addRelation}>+ 添加关系</button>
          </div>
          <div className="relation-list">
            {relations.map((rel, i) => (
              <div key={i} className="relation-row">
                <input className="input input--sm" placeholder="源节点" value={rel.source} onChange={(e) => updateRelation(i, "source", e.target.value)} />
                <span className="relation-arrow">→</span>
                <input className="input input--sm" placeholder="目标节点" value={rel.target} onChange={(e) => updateRelation(i, "target", e.target.value)} />
                <input className="input input--sm" placeholder="关系标签" value={rel.relation} onChange={(e) => updateRelation(i, "relation", e.target.value)} />
                <button className="btn btn--sm btn--danger-ghost" onClick={() => removeRelation(i)}>删除</button>
              </div>
            ))}
          </div>
        </div>

        <div className="skill-card__actions">
          <button className="btn btn--primary" onClick={handleGenerate} disabled={loading}>
            {loading ? "生成并预览中..." : "生成流程图"}
          </button>
        </div>

        {result && (
          <div className="skill-card__result">
            <div className="result-meta">
              <span>节点: <strong>{result.nodeCount}</strong></span>
              <span>边: <strong>{result.edgeCount}</strong></span>
            </div>

            {preview && (
              <DrawioImageViewer
                src={preview}
                alt={title || "流程图预览"}
                className="preview-frame"
                caption="点击预览可全屏缩放"
              />
            )}

            <div className="download-actions">
              <a className="btn btn--secondary btn--sm" href={downloadDrawioUrl(result.outputPath)} download>
                下载 .drawio
              </a>
              {(["png", "svg", "pdf"] as const).map((fmt) => (
                <button
                  key={fmt}
                  className="btn btn--secondary btn--sm"
                  onClick={() => handleExport(fmt)}
                  disabled={exportLoading === fmt}
                >
                  {exportLoading === fmt ? "导出中..." : `下载 ${fmt.toUpperCase()}`}
                </button>
              ))}
            </div>

            <details className="xml-preview">
              <summary>查看 mxGraph XML</summary>
              <pre>{result.xml}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
