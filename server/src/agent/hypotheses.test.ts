import { describe, it, expect } from "vitest";
import { mergeHypotheses } from "./hypotheses.js";
import type { Hypothesis } from "../types.js";

describe("mergeHypotheses", () => {
  it("appends new hypotheses and updates existing by statement", () => {
    const existing: Hypothesis[] = [
      { id: "h1", statement: "A", status: "active", evidenceIds: [], toolCallIds: [], updatedAt: "t0" },
    ];
    const merged = mergeHypotheses(existing, [
      { statement: "A", status: "confirmed" },
      { statement: "B", status: "ruled_out" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((h) => h.statement === "A")?.status).toBe("confirmed");
    expect(merged.find((h) => h.statement === "B")?.status).toBe("ruled_out");
    // 不修改原数组
    expect(existing[0].status).toBe("active");
  });
});
