import { describe, expect, it } from "vitest";

import type { TopoNode, TopoNodeKind } from "./api.js";
import { CANVAS_H, CANVAS_W, MAX_ROWS_PER_COLUMN, NODE_H, NODE_W, layout } from "./topo-layout.js";

const node = (id: string, kind: TopoNodeKind): TopoNode => ({ id, label: id, kind, ns: "default", status: "ok" });

describe("topo layout", () => {
  it("空图回落到默认画布尺寸", () => {
    const { pos, width, height } = layout([]);
    expect(pos).toEqual({});
    expect(width).toBe(CANVAS_W);
    expect(height).toBe(CANVAS_H);
  });

  it("节点少时保持默认高度，不因分层被拉高", () => {
    const nodes = [node("default/ing", "ingress"), node("default/web", "service"), node("default/db", "data")];
    const { height, pos } = layout(nodes);
    expect(height).toBe(CANVAS_H);
    expect(Object.keys(pos)).toHaveLength(3);
  });

  it("单层节点过多时横向拆列，而不是堆成一根长条", () => {
    const nodes = Array.from({ length: 35 }, (_, i) => node(`ns/svc-${i}`, "service"));
    const { pos, height, width } = layout(nodes);

    const xs = new Set(Object.values(pos).map((p) => p.x));
    expect(xs.size).toBe(Math.ceil(35 / MAX_ROWS_PER_COLUMN)); // 4 列
    // 单列不再超过上限，整体高度贴近画布默认高度而不是 35 行
    const rows = new Set(Object.values(pos).map((p) => p.y)).size;
    expect(rows).toBeLessThanOrEqual(MAX_ROWS_PER_COLUMN);
    // 拆列后高度由"行数"决定，而不是 35 个节点一路堆下去
    expect(height).toBeLessThanOrEqual(MAX_ROWS_PER_COLUMN * (NODE_H + 26) + 70);
    expect(height).toBeLessThan(900);
    expect(width).toBeGreaterThanOrEqual(CANVAS_W);
  });

  it("节点两两不重叠且落在画布范围内", () => {
    const nodes = [
      ...Array.from({ length: 23 }, (_, i) => node(`ns/svc-${i}`, "service")),
      ...Array.from({ length: 7 }, (_, i) => node(`ns/data-${i}`, "data")),
      node("ns/ing", "ingress"),
    ];
    const { pos, width, height } = layout(nodes);

    const boxes = Object.values(pos).map((p) => ({ x1: p.x, y1: p.y, x2: p.x + NODE_W, y2: p.y + NODE_H }));
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      expect(a.x1).toBeGreaterThanOrEqual(0);
      expect(a.y1).toBeGreaterThanOrEqual(0);
      expect(a.x2).toBeLessThanOrEqual(width);
      expect(a.y2).toBeLessThanOrEqual(height);
      for (let j = i + 1; j < boxes.length; j++) {
        const b = boxes[j];
        const overlap = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
        expect(overlap).toBe(false);
      }
    }
  });
});
