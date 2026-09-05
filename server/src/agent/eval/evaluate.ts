import type { EvalCase, EvalContext, EvalResult } from "./types.js";

export function evaluateCase(evalCase: EvalCase, ctx: EvalContext): EvalResult {
  const results = evalCase.checks.map((check) => {
    switch (check.type) {
      case "hasTool":
        return ctx.toolsUsed.some((t) => t.skill === check.skill && t.tool === check.tool);
      case "rootCauseMatches":
        return new RegExp(check.regex, "i").test(ctx.rootCauseSummary);
      case "hypothesisStatus":
        return ctx.hypotheses.some(
          (h) => new RegExp(check.statementRegex, "i").test(h.statement) && h.status === check.status,
        );
      default:
        return false;
    }
  });

  return {
    caseId: evalCase.id,
    checks: evalCase.checks.map((check, i) => ({ check, passed: results[i], reason: results[i] ? undefined : "未命中" })),
    passedAll: results.every(Boolean),
  };
}
