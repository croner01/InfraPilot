// 拓扑图布局计算（纯函数，便于单测）。
//
// 真实集群里 `service` 层动辄 30+ 个节点，若沿单一竖列堆叠，SVG 会被拉成
// 一根两千多像素的长条：既不像拓扑，也没法一屏看完。这里给每列设上限，
// 超出的层横向拆成多个子列，让画布长宽比贴近视口。

import type { TopoNode, TopoNodeKind } from "./api.js";

export const CANVAS_W = 920;
export const CANVAS_H = 430;
export const NODE_W = 148;
export const NODE_H = 46;

const ROW_GAP = 26;
const SUB_GAP = 24;
const LAYER_GAP = 56;
const MARGIN_X = 60;
const MARGIN_Y = 70;

/** 单列最多堆叠的节点数，超出即横向拆列。 */
export const MAX_ROWS_PER_COLUMN = 10;

export const KIND_LAYERS: TopoNodeKind[] = ["ingress", "service", "openstack", "middleware", "data"];

export type TopoLayout = {
  pos: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
};

export function layout(nodes: TopoNode[]): TopoLayout {
  const groups: Partial<Record<TopoNodeKind, TopoNode[]>> = {};
  for (const n of nodes) {
    (groups[n.kind] ??= []).push(n);
  }
  const layers = KIND_LAYERS.map((k) => groups[k] ?? []).filter((g) => g.length > 0);
  const pos: Record<string, { x: number; y: number }> = {};
  if (layers.length === 0) {
    return { pos, width: CANVAS_W, height: CANVAS_H };
  }

  const subW = NODE_W + SUB_GAP;
  const columnX: number[][] = [];
  const rowsPerCol: number[] = [];
  let cursorX = MARGIN_X;

  for (const group of layers) {
    const cols = Math.max(1, Math.ceil(group.length / MAX_ROWS_PER_COLUMN));
    rowsPerCol.push(Math.max(1, Math.ceil(group.length / cols)));
    columnX.push(Array.from({ length: cols }, (_, c) => cursorX + c * subW));
    cursorX += cols * subW + LAYER_GAP;
  }

  const maxRows = Math.max(...rowsPerCol, 1);
  const height = Math.max(CANVAS_H, maxRows * (NODE_H + ROW_GAP) + MARGIN_Y);
  const width = Math.max(CANVAS_W, cursorX - LAYER_GAP + MARGIN_X);

  layers.forEach((group, li) => {
    const xs = columnX[li];
    const rows = rowsPerCol[li];
    const totalH = rows * (NODE_H + ROW_GAP);
    const startY = Math.max(30, (height - totalH) / 2 + 10);
    group.forEach((n, ni) => {
      const col = Math.floor(ni / rows);
      const row = ni % rows;
      pos[n.id] = { x: xs[col], y: startY + row * (NODE_H + ROW_GAP) };
    });
  });

  return { pos, width, height };
}
