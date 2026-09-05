import { describe, it, expect } from "vitest";
import { evaluateCase } from "./evaluate.js";
import type { EvalCase, EvalContext } from "./types.js";

const ctx: EvalContext = {
  toolsUsed: [{ skill: "k8s", tool: "list_pods" }, { skill: "k8s", tool: "top_pods" }],
  rootCauseSummary: "节点驱逐与容器 OOM(4Gi) 共同导致 Kafka 崩溃, emptyDir 加剧",
  hypotheses: [{ statement: "emptyDir 导致数据丢失", status: "confirmed" }],
};

describe("evaluateCase", () => {
  it("passes when tools, summary and hypotheses match", () => {
    const c: EvalCase = {
      id: "c1",
      message: "kafka 无法启动",
      checks: [
        { type: "hasTool", skill: "k8s", tool: "top_pods" },
        { type: "rootCauseMatches", regex: "OOM|Evicted|emptyDir" },
        { type: "hypothesisStatus", statementRegex: "emptyDir", status: "confirmed" },
      ],
    };
    const r = evaluateCase(c, ctx);
    expect(r.passedAll).toBe(true);
  });

  it("fails on missing evidence", () => {
    const c: EvalCase = {
      id: "c2",
      message: "x",
      checks: [{ type: "hasTool", skill: "k8s", tool: "get_deployment" }],
    };
    expect(evaluateCase(c, ctx).passedAll).toBe(false);
  });
});
