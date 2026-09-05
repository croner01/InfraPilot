import { describe, it, expect } from "vitest";
import { mergeHypotheses, linkHypothesesToEvidence } from "./hypotheses.js";
import type { Evidence, Hypothesis } from "../types.js";

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

describe("linkHypothesesToEvidence", () => {
  it("maps evidence#N markers to evidence ids", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "内存 limit 过小（证据#1 与 证据#2 支撑）", status: "confirmed", evidenceIds: [], toolCallIds: [], updatedAt: "t" },
    ];
    const evidence: Evidence[] = [
      { id: "ev-oom", type: "k8s_event", content: {}, confidence: 0.9, collectedAt: "t", summary: "OOM" },
      { id: "ev-mem", type: "metric", content: {}, confidence: 0.8, collectedAt: "t", summary: "4095Mi" },
    ];
    expect(linkHypothesesToEvidence(hypotheses, evidence)[0].evidenceIds).toEqual(["ev-oom", "ev-mem"]);
  });
});
