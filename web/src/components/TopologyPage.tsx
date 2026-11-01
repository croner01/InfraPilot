import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchTopology, type TopoEdge, type TopoNode, type TopoNodeKind } from "../lib/api.js";
import { NODE_H, NODE_W, layout } from "../lib/topo-layout.js";
import "./topology.css";

/**
 * 服务拓扑页
 * 数据来源：GET /api/topology（K8s Namespace → Deployment/StatefulSet → Service → Ingress 聚合）。
 */

type NotifyFn = (msg: string, type?: "error" | "success") => void;

interface TopologyPageProps {
  notify?: NotifyFn;
  /** 一键诊断：由 App 建会话并注入节点上下文 */
  onDiagnose?: (ns: string, name: string, kind: string) => void;
}


const KIND_META: Record<TopoNodeKind, { label: string; color: string }> = {
  ingress: { label: "入口", color: "#0891b2" },
  service: { label: "业务服务", color: "#2563eb" },
  openstack: { label: "OpenStack 组件", color: "#7c3aed" },
  data: { label: "数据存储", color: "#d97706" },
  middleware: { label: "中间件", color: "#16a34a" },
};

const STATUS_COLOR: Record<TopoNode["status"], string> = {
  ok: "#16a34a",
  warn: "#d97706",
  err: "#dc2626",
  idle: "#94a3b8",
};

// idle = 未部署副本（desired=0），是"没启用"而非"出故障"，用中性灰且不参与异常计数。
const STATUS_LABEL: Record<TopoNode["status"], string> = {
  ok: "● 正常运行",
  warn: "● 存在告警",
  err: "● 异常",
  idle: "○ 未部署副本",
};

const NODE_STROKE: Record<TopoNode["status"], string> = {
  ok: "#d0d5dd",
  warn: "#d97706",
  err: "#dc2626",
  idle: "#cbd5e1",
};

const ZOOM_LEVELS = [1, 1.5] as const;

export function TopologyPage({ notify, onDiagnose }: TopologyPageProps) {
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const prevZoomRef = useRef(zoom);
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState(false);
  const [selected, setSelected] = useState<TopoNode | null>(null);
  const [nsFilter, setNsFilter] = useState<string>("all");
  const [nodes, setNodes] = useState<TopoNode[]>([]);
  const [edges, setEdges] = useState<TopoEdge[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const load = useCallback(
    async (namespace?: string) => {
      setScanning(true);
      const res = await fetchTopology(namespace, (err) => notify?.(err.message));
      setScanning(false);
      if (!res) return;
      setNodes(res.nodes);
      setEdges(res.edges);
      setGeneratedAt(res.generatedAt ?? null);
      setDiscovered(true);
      setSelected(null);
    },
    [notify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const namespaces = useMemo(() => ["all", ...Array.from(new Set(nodes.map((n) => n.ns)))], [nodes]);
  const visibleNodes = useMemo(
    () => (nsFilter === "all" ? nodes : nodes.filter((n) => n.ns === nsFilter || n.kind === "ingress")),
    [nodes, nsFilter],
  );
  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleNodes.some((n) => n.id === e.from) && visibleNodes.some((n) => n.id === e.to)),
    [edges, visibleNodes],
  );
  const { pos, width, height } = useMemo(() => layout(visibleNodes), [visibleNodes]);

  // 切缩放档位时按比例挪动滚动位置，让画面中心留在原处，不会突然跳到左上角。
  useEffect(() => {
    const el = canvasRef.current;
    const prev = prevZoomRef.current;
    prevZoomRef.current = zoom;
    if (!el || prev === zoom) return;
    const ratio = zoom / prev;
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
  }, [zoom]);

  const handleDiscover = () => {
    void load(nsFilter === "all" ? undefined : nsFilter);
  };

  const errCount =
    visibleEdges.filter((e) => e.status === "err").length + visibleNodes.filter((n) => n.status === "err").length;

  return (
    <div className="topology-page">
      <div className="page-header">
        <h1 className="page-header__title">
          服务拓扑
          {generatedAt && <span className="topo-mock-tag">实时数据</span>}
        </h1>
        <p className="page-header__subtitle">
          自动发现 K8s 服务依赖关系：Namespace → Workload → Service → 数据层；Trace 数据源（Jaeger/Tempo）接入后可呈现调用链级拓扑。
        </p>
      </div>

      <div className="topo-toolbar">
        <button className="btn btn--primary btn--sm" onClick={handleDiscover} disabled={scanning}>
          {scanning ? "发现中…" : "⟳ 自动发现"}
        </button>
        <div className="topo-metrics">
          <span className="topo-metric">
            <b>{visibleNodes.length}</b>节点
          </span>
          <span className="topo-metric">
            <b>{visibleEdges.length}</b>调用边
          </span>
          <span className={`topo-metric${errCount > 0 ? " topo-metric--danger" : ""}`}>
            <b>{errCount}</b>异常
          </span>
        </div>
        <div className="topo-toolbar__spacer" />
        <div className="topo-zoom" role="group" aria-label="画布缩放">
          {ZOOM_LEVELS.map((z) => (
            <button
              key={z}
              className={`topo-zoom__btn${zoom === z ? " topo-zoom__btn--active" : ""}`}
              aria-pressed={zoom === z}
              title={`${z}× 缩放`}
              onClick={() => setZoom(z)}
            >
              {z}×
            </button>
          ))}
        </div>
        <button className="btn btn--sm" onClick={() => notify?.("导出将复用 drawio Skill（生成 .drawio / PNG）")}>
          导出拓扑
        </button>
      </div>

      <div className="topo-toolbar__ns">
        {namespaces.map((ns) => (
          <button
            key={ns}
            className={`chip${nsFilter === ns ? " chip--active" : ""}`}
            onClick={() => setNsFilter(ns)}
          >
            {ns === "all" ? "全部命名空间" : ns}
          </button>
        ))}
      </div>

      <div className="topo-workbench">
        <div ref={canvasRef} className="topo-canvas-card">
          {scanning && (
            <div className="topo-scanline">
              <div className="topo-scanline__bar" />
              <div className="topo-scanline__text">正在聚合 k8s API：Namespace / Deployment / Pod / Service / Endpoint…</div>
            </div>
          )}
          {discovered ? (
            <svg viewBox={`0 0 ${width} ${height}`} className="topo-svg" style={{ width: `${zoom * 100}%` }}>
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6" fill="none" stroke="#8a93a6" strokeWidth="1.4" />
                </marker>
                <marker id="arrow-err" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6" fill="none" stroke="#dc2626" strokeWidth="1.4" />
                </marker>
              </defs>
              {/* 边 */}
              {visibleEdges.map((e) => {
                const a = pos[e.from];
                const b = pos[e.to];
                if (!a || !b) return null;
                const x1 = a.x + NODE_W / 2;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x + NODE_W / 2;
                const y2 = b.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;
                const err = e.status === "err";
                return (
                  <g key={`${e.from}->${e.to}`} className="topo-edge" onClick={() => setSelected(nodes.find((n) => n.id === e.to) ?? null)}>
                    <path
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={err ? "#dc2626" : "#b6bdcb"}
                      strokeWidth={err ? 2 : 1.4}
                      strokeDasharray={err ? "6 4" : undefined}
                      markerEnd={err ? "url(#arrow-err)" : "url(#arrow)"}
                      className={err ? "topo-edge__path topo-edge__path--err" : "topo-edge__path"}
                    />
                    {e.label && (
                      <text x={mx} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize="10" fill={err ? "#dc2626" : "#8a93a6"}>
                        {e.label}
                      </text>
                    )}
                  </g>
                );
              })}
              {/* 节点 */}
              {visibleNodes.map((n) => {
                const p = pos[n.id];
                if (!p) return null;
                const meta = KIND_META[n.kind];
                const isSel = selected?.id === n.id;
                return (
                  <g key={n.id} className="topo-node" onClick={() => setSelected(n)}>
                    <rect
                      x={p.x}
                      y={p.y}
                      width={NODE_W}
                      height={NODE_H}
                      rx="9"
                      fill="#fff"
                      stroke={isSel ? "#2563eb" : NODE_STROKE[n.status]}
                      strokeWidth={isSel ? 2.2 : n.status === "err" ? 1.8 : 1.2}
                      strokeDasharray={n.status === "idle" ? "4 3" : undefined}
                    />
                    <rect x={p.x} y={p.y} width="5" height={NODE_H} rx="2.5" fill={meta.color} />
                    <circle cx={p.x + NODE_W - 14} cy={p.y + 13} r="4.5" fill={STATUS_COLOR[n.status]} />
                    <text x={p.x + 14} y={p.y + 19} fontSize="12" fontWeight="700" fill="#1a2233">
                      {n.label.length > 15 ? n.label.slice(0, 14) + "…" : n.label}
                    </text>
                    <text x={p.x + 14} y={p.y + 35} fontSize="9.5" fill="#8a93a6">
                      {n.ns} · {n.replicas ?? meta.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          ) : (
            !scanning && <div className="topo-empty">点击「自动发现」开始扫描集群拓扑</div>
          )}
          <div className="topo-legend">
            {Object.entries(KIND_META).map(([k, m]) => (
              <span key={k} className="topo-legend__item">
                <i style={{ background: m.color }} />
                {m.label}
              </span>
            ))}
            <span className="topo-legend__item"><i style={{ background: "#16a34a" }} />正常</span>
            <span className="topo-legend__item"><i style={{ background: "#d97706" }} />告警</span>
            <span className="topo-legend__item"><i style={{ background: "#dc2626" }} />异常链路</span>
            <span className="topo-legend__item"><i style={{ background: "#94a3b8" }} />未部署</span>
          </div>
        </div>

        <aside className="topo-detail">
          {selected ? (
            <>
              <div className="topo-detail__head">
                <div className="topo-detail__title">{selected.label}</div>
                <span className="topo-detail__kind" style={{ color: KIND_META[selected.kind].color }}>
                  {KIND_META[selected.kind].label}
                </span>
              </div>
              <div className={`topo-detail__status topo-detail__status--${selected.status}`}>
                {STATUS_LABEL[selected.status]}
              </div>
              {selected.alert && <div className="topo-detail__alert">⚠ {selected.alert}</div>}
              <div className="topo-detail__rows">
                <div className="topo-detail__row"><b>命名空间</b><span>{selected.ns}</span></div>
                {selected.replicas && <div className="topo-detail__row"><b>副本</b><span>{selected.replicas}</span></div>}
                {selected.labels &&
                  Object.entries(selected.labels).map(([k, v]) => (
                    <div key={k} className="topo-detail__row"><b>{k}</b><span className="topo-detail__mono">{v}</span></div>
                  ))}
              </div>
              <div className="topo-detail__actions">
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => {
                    if (onDiagnose) onDiagnose(selected.ns, selected.label, KIND_META[selected.kind].label);
                    else notify?.(`已创建诊断会话：${selected.label}`);
                  }}
                >
                  一键诊断
                </button>
                <button className="btn btn--sm" onClick={() => notify?.(`可在「数据源」工作台检索 ${selected.ns}/${selected.label} 的日志`)}>
                  查看日志
                </button>
              </div>
            </>
          ) : (
            <div className="topo-detail__empty">点击拓扑节点查看详情、关联告警与快捷操作</div>
          )}
        </aside>
      </div>
    </div>
  );
}
