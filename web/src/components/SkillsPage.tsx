import { useEffect, useState } from "react";
import {
  exportDrawioDiagram,
  generateDrawioFlowchart,
  installSkill,
  listCuratedSkills,
  listSkills,
  setSkillEnabled,
  uninstallSkill,
  type CuratedSkill,
  type LogRelation,
  type SkillPackageInfo,
  downloadDrawioUrl,
} from "../lib/api.js";
import { DrawioImageViewer } from "./DrawioImageViewer.js";

type NotifyFn = (msg: string, type?: "error" | "success") => void;

interface SkillsPageProps {
  notify: NotifyFn;
}

export function SkillsPage({ notify }: SkillsPageProps) {
  return (
    <div className="skills-page">
      <div className="page-header">
        <h1 className="page-header__title">技能中心</h1>
        <p className="page-header__subtitle">技能包管理：安装开源 SKILL.md、启停诊断方法论，扩展 AI Agent 能力</p>
      </div>
      <div className="main__content">
        <SkillPackagesSection notify={notify} />
        <InstallSkillSection notify={notify} />
        <DrawioFlowchartSkill notify={notify} />
      </div>
    </div>
  );
}

function InstallSkillSection({ notify }: { notify: NotifyFn }) {
  const [curated, setCurated] = useState<CuratedSkill[]>([]);
  const [repo, setRepo] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    listCuratedSkills((err) => notify(err.message)).then((res) => {
      if (res) setCurated(res.skills);
    });
  }, []);

  const fill = (c: CuratedSkill) => {
    setRepo(c.repo);
    setSkillPath(c.path);
  };

  const handleInstall = async () => {
    if (!repo.trim() || !skillPath.trim()) {
      notify("请填写 repo 与 path");
      return;
    }
    setInstalling(true);
    const res = await installSkill(
      {
        repo: repo.trim(),
        path: skillPath.trim(),
        ref: ref.trim() || undefined,
        token: token.trim() || undefined,
      },
      (err) => notify(err.message)
    );
    if (res) {
      notify(`${res.name} 安装成功，下一轮诊断自动生效`, "success");
      setRepo("");
      setSkillPath("");
      setRef("");
      setToken("");
    }
    setInstalling(false);
  };

  return (
    <section className="skill-card">
      <div className="skill-card__header">
        <div className="skill-card__icon">⬇️</div>
        <div>
          <h2 className="skill-card__title">安装技能包</h2>
          <p className="skill-card__desc">从 GitHub 仓库安装开源 SKILL.md 技能（git sparse-checkout），安装后默认启用。</p>
        </div>
      </div>
      <div className="skill-card__body">
        {curated.length > 0 && (
          <div className="curated-list">
            {curated.map((c) => (
              <button key={`${c.repo}/${c.path}`} className="curated-chip" onClick={() => fill(c)} title={c.description}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="install-form">
          <div className="install-form__row">
            <input
              className="input"
              placeholder="repo，如 openai/skills"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
            <input
              className="input"
              placeholder="path，如 skills/.experimental/ceph-rbd-108"
              value={skillPath}
              onChange={(e) => setSkillPath(e.target.value)}
            />
          </div>
          <div className="install-form__row">
            <input className="input" placeholder="ref（可选，默认 main）" value={ref} onChange={(e) => setRef(e.target.value)} />
            <input className="input" placeholder="token（可选，私有仓库）" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div>
            <button className="btn btn--primary" onClick={handleInstall} disabled={installing}>
              {installing ? "安装中..." : "安装"}
            </button>
          </div>
        </div>
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
          <div className="empty-hint">暂无已安装技能包，可在下方安装。</div>
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
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={busy === s.name}
                        onChange={() => handleToggle(s)}
                      />
                      <span className="toggle__track" />
                      <span className="toggle__label">{s.enabled ? "启用" : "禁用"}</span>
                    </label>
                    {!builtin && (
                      <button
                        className="btn btn--sm btn--danger-ghost"
                        disabled={busy === s.name}
                        onClick={() => handleUninstall(s)}
                      >
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
                <input
                  className="input input--sm"
                  placeholder="源节点"
                  value={rel.source}
                  onChange={(e) => updateRelation(i, "source", e.target.value)}
                />
                <span className="relation-arrow">→</span>
                <input
                  className="input input--sm"
                  placeholder="目标节点"
                  value={rel.target}
                  onChange={(e) => updateRelation(i, "target", e.target.value)}
                />
                <input
                  className="input input--sm"
                  placeholder="关系标签"
                  value={rel.relation}
                  onChange={(e) => updateRelation(i, "relation", e.target.value)}
                />
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
