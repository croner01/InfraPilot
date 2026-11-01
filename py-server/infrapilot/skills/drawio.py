"""Draw.io Skill —— 对应 `server/src/skills/drawio/tools.ts`。

根据日志/依赖关系生成 draw.io 流程图（.drawio），并可导出 PNG/SVG/PDF。
导出优先复用 Node 版导出脚本（server/src/skills/drawio/scripts/drawio-to-png.mjs），
保持与 Node 版一致的 draw.io CLI / headless viewer 回退行为。
"""

from __future__ import annotations

import asyncio
import math
import os
import time
from pathlib import Path
from typing import Any, Optional

from ..models import ToolDef, ToolExecutionResult
from ..settings import DATA_DIR
from ..util import kill_quietly

DIAGRAMS_DIR = (DATA_DIR / "diagrams").resolve()
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
EXPORT_SCRIPT = _REPO_ROOT / "server" / "src" / "skills" / "drawio" / "scripts" / "drawio-to-png.mjs"

TOOLS: list[ToolDef] = [
    ToolDef(
        name="generate_flowchart",
        skill="drawio",
        risk="readonly",
        description="根据日志调用/依赖关系生成 draw.io 流程图(mxfie格式),输出 .drawio 文件路径。",
        parameters={
            "type": "object",
            "properties": {
                "log_relations": {
                    "type": "array",
                    "description": "日志关系边列表,每个元素包含 source(源服务/组件)、target(目标服务/组件)、relation(关系标签)",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string", "description": "源节点名称"},
                            "target": {"type": "string", "description": "目标节点名称"},
                            "relation": {"type": "string", "description": "关系描述,如调用、写入、触发"},
                        },
                        "required": ["source", "target", "relation"],
                    },
                },
                "output_path": {"type": "string", "description": "输出 .drawio 文件路径,建议使用绝对路径"},
                "title": {"type": "string", "description": "流程图标题"},
            },
            "required": ["log_relations", "output_path"],
            "additionalProperties": False,
        },
    ),
    ToolDef(
        name="export_diagram",
        skill="drawio",
        risk="low",
        description="将 .drawio 文件导出为 PNG/SVG/PDF。若系统已安装 draw.io CLI,优先使用 CLI 渲染;否则使用 headless 浏览器查看器渲染(仅 PNG)。",
        parameters={
            "type": "object",
            "properties": {
                "input_path": {"type": "string", "description": "输入 .drawio 文件路径"},
                "output_path": {"type": "string", "description": "输出文件路径"},
                "format": {"type": "string", "enum": ["png", "svg", "pdf"], "description": "导出格式"},
            },
            "required": ["input_path", "output_path", "format"],
            "additionalProperties": False,
        },
    ),
]


def _normalize_diagram_path(input_path: str) -> str:
    """强制把 drawio 相关文件落到 DIAGRAMS_DIR 下，避免 Agent 指定 /tmp 等路径导致下载失败。"""
    normalized = (DIAGRAMS_DIR / input_path).resolve()
    if str(normalized).startswith(str(DIAGRAMS_DIR)):
        return str(normalized)
    base = os.path.basename(input_path) or f"diagram-{int(time.time())}.drawio"
    return str(DIAGRAMS_DIR / base)


def _escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


_NODE_STYLES = [
    (
        ["mysql", "postgres", "db", "database", "clickhouse", "elk", "opensearch", "redis", "mongo", "tidb", "mariadb"],
        {"icon": "🗄️", "fill": "#fff2cc", "gradient": "#ffd966", "stroke": "#d6b656", "fontColor": "#5c4813"},
    ),
    (
        ["api", "gateway", "nginx", "ingress", "lb", "loadbalancer", "proxy"],
        {"icon": "🌐", "fill": "#e1d5e7", "gradient": "#b4a7d6", "stroke": "#9673a6", "fontColor": "#4a3b5c"},
    ),
    (
        ["vm", "nova", "compute", "hypervisor", "qemu", "libvirt", "ec2", "instance"],
        {"icon": "🖥️", "fill": "#d5e8d4", "gradient": "#97d077", "stroke": "#82b366", "fontColor": "#324d26"},
    ),
    (
        ["k8s", "kube", "pod", "container", "docker", "scheduler", "conductor"],
        {"icon": "☸️", "fill": "#dae8fc", "gradient": "#7ea6e0", "stroke": "#6c8ebf", "fontColor": "#2a4360"},
    ),
    (
        ["network", "neutron", "switch", "router", "vpc", "subnet"],
        {"icon": "🔀", "fill": "#f8cecc", "gradient": "#ea9999", "stroke": "#b85450", "fontColor": "#5c2626"},
    ),
    (
        ["storage", "cinder", "volume", "ceph", "s3", "nfs"],
        {"icon": "💾", "fill": "#e6f3ff", "gradient": "#9fc5e8", "stroke": "#6fa8dc", "fontColor": "#264766"},
    ),
    (
        ["message", "kafka", "mq", "queue", "rabbitmq", "rocketmq"],
        {"icon": "📨", "fill": "#ffe6cc", "gradient": "#f6b26b", "stroke": "#e69138", "fontColor": "#5c3a15"},
    ),
    (
        ["user", "client", "keystone", "auth", "login", "sso"],
        {"icon": "👤", "fill": "#f3e5f5", "gradient": "#ce93d8", "stroke": "#ab47bc", "fontColor": "#4a235a"},
    ),
]


def _detect_node_style(node_name: str) -> dict[str, str]:
    lower = node_name.lower()
    for words, style in _NODE_STYLES:
        if any(word in lower for word in words):
            return style
    return {"icon": "⚙️", "fill": "#f5f5f5", "gradient": "#e0e0e0", "stroke": "#999999", "fontColor": "#333333"}


def _build_mx_file(relations: list[dict[str, Any]], title: Optional[str]) -> str:
    node_order: list[str] = []
    node_set: set[str] = set()
    for rel in relations:
        for key in ("source", "target"):
            node = rel.get(key)
            if node not in node_set:
                node_set.add(node)
                node_order.append(node)

    nodes = node_order
    cols = max(1, math.ceil(math.sqrt(len(nodes))))
    cell_width, cell_height, h_gap, v_gap = 180, 90, 100, 90

    node_cells = []
    for i, node in enumerate(nodes):
        col = i % cols
        row = i // cols
        x = 40 + col * (cell_width + h_gap)
        y = 90 + row * (cell_height + v_gap)
        style = _detect_node_style(node)
        label = f"{style['icon']} {_escape_xml(node)}"
        node_cells.append(
            f'    <mxCell id="node-{i}" value="{label}" style="rounded=1;whiteSpace=wrap;html=1;'
            f"fillColor={style['fill']};gradientColor={style['gradient']};gradientDirection=north;"
            f"strokeColor={style['stroke']};strokeWidth=2;arcSize=14;fontSize=13;fontColor={style['fontColor']};"
            'fontStyle=1;shadow=1;glass=0;spacing=8;" vertex="1" parent="1">\n'
            f'      <mxGeometry x="{x}" y="{y}" width="{cell_width}" height="{cell_height}" as="geometry"/>\n'
            "    </mxCell>"
        )

    node_index = {n: i for i, n in enumerate(nodes)}
    edge_cells = []
    for i, rel in enumerate(relations):
        source_idx = node_index.get(rel.get("source"), 0)
        target_idx = node_index.get(rel.get("target"), 0)
        edge_cells.append(
            f'    <mxCell id="edge-{i}" value="{_escape_xml(str(rel.get("relation") or ""))}" style="'
            "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#5b9bd5;strokeWidth=2;fontColor=#333333;"
            "fontSize=11;labelBackgroundColor=#ffffff;labelBorderColor=#e5e7eb;endArrow=block;endFill=1;"
            f'startArrow=none;startFill=0;" edge="1" source="node-{source_idx}" target="node-{target_idx}" parent="1">\n'
            '      <mxGeometry relative="1" as="geometry"/>\n'
            "    </mxCell>"
        )

    title_cell = (
        f'    <mxCell id="title" value="{_escape_xml(title)}" style="text;html=1;align=center;'
        'verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=#1f2937;" vertex="1" parent="1">\n'
        '      <mxGeometry x="40" y="25" width="600" height="40" as="geometry"/>\n'
        "    </mxCell>"
        if title
        else ""
    )

    diagram_height = 90 + math.ceil(len(nodes) / cols) * (cell_height + v_gap) + 40
    diagram_width = 40 + cols * (cell_width + h_gap)
    page_width = max(1169, diagram_width)
    page_height = max(827, diagram_height)

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<mxfile host="InfraPilot" version="0.1.0">\n'
        '  <diagram id="flowchart-1" name="Page-1">\n'
        f'    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1"'
        f' fold="1" page="1" pageScale="1" pageWidth="{page_width}" pageHeight="{page_height}" math="0" shadow="0">\n'
        "      <root>\n"
        '        <mxCell id="0"/>\n'
        '        <mxCell id="1" parent="0"/>\n'
        f"{title_cell}\n"
        + "\n".join(node_cells)
        + "\n"
        + "\n".join(edge_cells)
        + "\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>"
    )


async def _run_export_script(fmt: str, input_path: str, output_path: str) -> None:
    if not EXPORT_SCRIPT.exists():
        raise RuntimeError(f"未找到 Node 导出脚本: {EXPORT_SCRIPT}")
    process = await asyncio.create_subprocess_exec(
        "node",
        str(EXPORT_SCRIPT),
        f"--format={fmt}",
        input_path,
        output_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await process.communicate()
    except BaseException:
        # 会话被中断：终止导出进程，避免 node 脚本在后台挂住
        kill_quietly(process)
        raise
    if process.returncode != 0:
        raise RuntimeError((stderr or b"").decode("utf-8", "replace")[:500] or f"导出脚本退出码 {process.returncode}")


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    try:
        if tool == "generate_flowchart":
            relations = args.get("log_relations")
            if not isinstance(relations, list) or not relations:
                return _err("log_relations 不能为空数组", started)
            if not args.get("output_path"):
                return _err("output_path 不能为空", started)
            safe_output = _normalize_diagram_path(str(args["output_path"]))
            xml = _build_mx_file(relations, args.get("title"))
            Path(safe_output).parent.mkdir(parents=True, exist_ok=True)
            Path(safe_output).write_text(xml, encoding="utf-8")
            nodes = {n for rel in relations for n in (rel.get("source"), rel.get("target"))}
            return _ok({"output_path": safe_output, "node_count": len(nodes), "edge_count": len(relations)}, started)

        if tool == "export_diagram":
            input_path, output_path, fmt = args.get("input_path"), args.get("output_path"), args.get("format")
            if not input_path or not output_path or not fmt:
                return _err("input_path, output_path, format 均为必填", started)
            safe_input = _normalize_diagram_path(str(input_path))
            safe_output = _normalize_diagram_path(str(output_path))
            Path(safe_output).parent.mkdir(parents=True, exist_ok=True)
            await _run_export_script(str(fmt), safe_input, safe_output)
            return _ok({"input_path": safe_input, "output_path": safe_output, "format": fmt}, started)

        return _err(f"未知的 drawio 工具: {tool}", started)
    except Exception as err:  # noqa: BLE001
        return _err(f"Draw.io 技能执行失败: {err}", started)


def _ok(data: Any, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=True, data=data, durationMs=_ms(started))


def _err(error: str, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=False, error=error, durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)


def sanitize_diagram_path(input_path: str) -> str:
    """仅允许 DIAGRAMS_DIR 内的路径，防止目录遍历（对应 Node api.ts::sanitizeDiagramPath）。"""
    normalized = (DIAGRAMS_DIR / input_path).resolve()
    if not str(normalized).startswith(str(DIAGRAMS_DIR)):
        raise ValueError("非法文件路径")
    return str(normalized)
