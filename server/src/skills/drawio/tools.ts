// ============================================================================
// Draw.io Skill — 根据日志关系生成流程图并导出为 PNG/SVG/PDF
//
// 参考 GitHub awesome-copilot 的 drawio skill:
// https://github.com/github/awesome-copilot/tree/main/skills/drawio
// 导出脚本 drawio-to-png.mjs 来自上述仓库,支持 draw.io CLI 与 headless viewer
// 两种渲染后端,优先使用本地 draw.io CLI。
// ============================================================================

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { ToolDef, ToolExecutionResult } from "../../types.js";

const execFileAsync = promisify(execFile);

export interface LogRelation {
  source: string;
  target: string;
  relation: string;
}

export const drawioTools: ToolDef[] = [
  {
    name: "generate_flowchart",
    skill: "drawio",
    risk: "readonly",
    description: "根据日志调用/依赖关系生成 draw.io 流程图(mxfie格式),输出 .drawio 文件路径。",
    parameters: {
      type: "object",
      properties: {
        log_relations: {
          type: "array",
          description: "日志关系边列表,每个元素包含 source(源服务/组件)、target(目标服务/组件)、relation(关系标签)",
          items: {
            type: "object",
            properties: {
              source: { type: "string", description: "源节点名称" },
              target: { type: "string", description: "目标节点名称" },
              relation: { type: "string", description: "关系描述,如调用、写入、触发" },
            },
            required: ["source", "target", "relation"],
          },
        },
        output_path: {
          type: "string",
          description: "输出 .drawio 文件路径,建议使用绝对路径",
        },
        title: {
          type: "string",
          description: "流程图标题",
        },
      },
      required: ["log_relations", "output_path"],
      additionalProperties: false,
    },
  },
  {
    name: "export_diagram",
    skill: "drawio",
    risk: "low",
    description: "将 .drawio 文件导出为 PNG/SVG/PDF。若系统已安装 draw.io CLI,优先使用 CLI 渲染;否则使用 headless 浏览器查看器渲染(仅 PNG)。",
    parameters: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "输入 .drawio 文件路径" },
        output_path: { type: "string", description: "输出文件路径" },
        format: {
          type: "string",
          enum: ["png", "svg", "pdf"],
          description: "导出格式",
        },
      },
      required: ["input_path", "output_path", "format"],
      additionalProperties: false,
    },
  },
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXPORT_SCRIPT = join(__dirname, "scripts", "drawio-to-png.mjs");
const DIAGRAMS_DIR = resolve(process.cwd(), "data", "diagrams");

/** 将所有 drawio 相关文件强制落到 DIAGRAMS_DIR 下，避免 Agent 指定 /tmp 等路径导致下载失败 */
function normalizeDiagramPath(inputPath: string): string {
  const normalized = resolve(DIAGRAMS_DIR, inputPath);
  if (normalized.startsWith(DIAGRAMS_DIR)) {
    return normalized;
  }
  return join(DIAGRAMS_DIR, basename(inputPath) || `diagram-${Date.now()}.drawio`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface NodeStyle {
  icon: string;
  fill: string;
  gradient: string;
  stroke: string;
  fontColor: string;
}

function detectNodeStyle(nodeName: string): NodeStyle {
  const lower = nodeName.toLowerCase();
  const contains = (words: string[]) => words.some((w) => lower.includes(w));

  if (contains(["mysql", "postgres", "db", "database", "clickhouse", "elk", "opensearch", "redis", "mongo", "tidb", "mariadb"])) {
    return { icon: "🗄️", fill: "#fff2cc", gradient: "#ffd966", stroke: "#d6b656", fontColor: "#5c4813" };
  }
  if (contains(["api", "gateway", "nginx", "ingress", "lb", "loadbalancer", "proxy"])) {
    return { icon: "🌐", fill: "#e1d5e7", gradient: "#b4a7d6", stroke: "#9673a6", fontColor: "#4a3b5c" };
  }
  if (contains(["vm", "nova", "compute", "hypervisor", "qemu", "libvirt", "ec2", "instance"])) {
    return { icon: "🖥️", fill: "#d5e8d4", gradient: "#97d077", stroke: "#82b366", fontColor: "#324d26" };
  }
  if (contains(["k8s", "kube", "pod", "container", "docker", "scheduler", "conductor"])) {
    return { icon: "☸️", fill: "#dae8fc", gradient: "#7ea6e0", stroke: "#6c8ebf", fontColor: "#2a4360" };
  }
  if (contains(["network", "neutron", "switch", "router", "vpc", "subnet"])) {
    return { icon: "🔀", fill: "#f8cecc", gradient: "#ea9999", stroke: "#b85450", fontColor: "#5c2626" };
  }
  if (contains(["storage", "cinder", "volume", "ceph", "s3", "nfs"])) {
    return { icon: "💾", fill: "#e6f3ff", gradient: "#9fc5e8", stroke: "#6fa8dc", fontColor: "#264766" };
  }
  if (contains(["message", "kafka", "mq", "queue", "rabbitmq", "rocketmq"])) {
    return { icon: "📨", fill: "#ffe6cc", gradient: "#f6b26b", stroke: "#e69138", fontColor: "#5c3a15" };
  }
  if (contains(["user", "client", "keystone", "auth", "login", "sso"])) {
    return { icon: "👤", fill: "#f3e5f5", gradient: "#ce93d8", stroke: "#ab47bc", fontColor: "#4a235a" };
  }
  // 默认服务节点
  return { icon: "⚙️", fill: "#f5f5f5", gradient: "#e0e0e0", stroke: "#999999", fontColor: "#333333" };
}


function buildMxFile(
  relations: LogRelation[],
  title?: string
): string {
  // 收集节点并去重,保留出现顺序
  const nodeOrder: string[] = [];
  const nodeSet = new Set<string>();
  for (const rel of relations) {
    if (!nodeSet.has(rel.source)) {
      nodeSet.add(rel.source);
      nodeOrder.push(rel.source);
    }
    if (!nodeSet.has(rel.target)) {
      nodeSet.add(rel.target);
      nodeOrder.push(rel.target);
    }
  }

  const nodes = nodeOrder;
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const cellWidth = 180;
  const cellHeight = 90;
  const hGap = 100;
  const vGap = 90;

  const nodeCells = nodes
    .map((node, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = 40 + col * (cellWidth + hGap);
      const y = 90 + row * (cellHeight + vGap);
      const style = detectNodeStyle(node);
      const label = `${style.icon} ${escapeXml(node)}`;
      return `    <mxCell id="node-${i}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${style.fill};gradientColor=${style.gradient};gradientDirection=north;strokeColor=${style.stroke};strokeWidth=2;arcSize=14;fontSize=13;fontColor=${style.fontColor};fontStyle=1;shadow=1;glass=0;spacing=8;" vertex="1" parent="1">
      <mxGeometry x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" as="geometry"/>
    </mxCell>`;
    })
    .join("\n");

  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n, i));

  const edgeCells = relations
    .map((rel, i) => {
      const sourceIdx = nodeIndex.get(rel.source) ?? 0;
      const targetIdx = nodeIndex.get(rel.target) ?? 0;
      return `    <mxCell id="edge-${i}" value="${escapeXml(rel.relation)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#5b9bd5;strokeWidth=2;fontColor=#333333;fontSize=11;labelBackgroundColor=#ffffff;labelBorderColor=#e5e7eb;endArrow=block;endFill=1;startArrow=none;startFill=0;" edge="1" source="node-${sourceIdx}" target="node-${targetIdx}" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>`;
    })
    .join("\n");

  const titleCell = title
    ? `    <mxCell id="title" value="${escapeXml(title)}" style="text;html=1;align=center;verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=#1f2937;" vertex="1" parent="1">
      <mxGeometry x="40" y="25" width="600" height="40" as="geometry"/>
    </mxCell>`
    : "";

  const diagramHeight = 90 + Math.ceil(nodes.length / cols) * (cellHeight + vGap) + 40;
  const diagramWidth = 40 + cols * (cellWidth + hGap);

  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="InfraPilot" version="0.1.0">
  <diagram id="flowchart-1" name="Page-1">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.max(1169, diagramWidth)}" pageHeight="${Math.max(827, diagramHeight)}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${titleCell}
${nodeCells}
${edgeCells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

export async function executeDrawioTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();

  try {
    switch (tool) {
      case "generate_flowchart": {
        const { log_relations, output_path, title } = args as {
          log_relations: LogRelation[];
          output_path: string;
          title?: string;
        };
        if (!Array.isArray(log_relations) || log_relations.length === 0) {
          return { success: false, error: "log_relations 不能为空数组", durationMs: Date.now() - start };
        }
        if (!output_path) {
          return { success: false, error: "output_path 不能为空", durationMs: Date.now() - start };
        }
        const safeOutputPath = normalizeDiagramPath(output_path);
        const xml = buildMxFile(log_relations, title);
        const dir = dirname(safeOutputPath);
        if (dir && !existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(safeOutputPath, xml, "utf-8");
        return {
          success: true,
          data: { output_path: safeOutputPath, node_count: new Set(log_relations.flatMap((r) => [r.source, r.target])).size, edge_count: log_relations.length },
          durationMs: Date.now() - start,
        };
      }

      case "export_diagram": {
        const { input_path, output_path, format } = args as {
          input_path: string;
          output_path: string;
          format: "png" | "svg" | "pdf";
        };
        if (!input_path || !output_path || !format) {
          return { success: false, error: "input_path, output_path, format 均为必填", durationMs: Date.now() - start };
        }
        const safeInputPath = normalizeDiagramPath(input_path);
        const safeOutputPath = normalizeDiagramPath(output_path);
        const outDir = dirname(safeOutputPath);
        if (outDir && !existsSync(outDir)) {
          mkdirSync(outDir, { recursive: true });
        }
        await execFileAsync("node", [EXPORT_SCRIPT, `--format=${format}`, safeInputPath, safeOutputPath]);
        return { success: true, data: { input_path: safeInputPath, output_path: safeOutputPath, format }, durationMs: Date.now() - start };
      }

      default:
        return { success: false, error: `未知的 drawio 工具: ${tool}`, durationMs: Date.now() - start };
    }
  } catch (err: any) {
    return { success: false, error: `Draw.io 技能执行失败: ${err?.message ?? String(err)}`, durationMs: Date.now() - start };
  }
}
