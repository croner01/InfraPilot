import { useState } from "react";
import { exportDrawioDiagram, generateDrawioFlowchart, type LogRelation, downloadDrawioUrl } from "../lib/api.js";
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
        <p className="page-header__subtitle">扩展 AI Agent 的可观测与可视化能力</p>
      </div>
      <div className="main__content">
        <DrawioFlowchartSkill notify={notify} />
      </div>
    </div>
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
