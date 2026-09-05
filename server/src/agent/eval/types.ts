export type EvalCheck =
  | { type: "hasTool"; skill: string; tool: string }
  | { type: "rootCauseMatches"; regex: string }
  | { type: "hypothesisStatus"; statementRegex: string; status: string };

export interface EvalCase {
  id: string;
  message: string;
  checks: EvalCheck[];
}

export interface EvalContext {
  toolsUsed: Array<{ skill: string; tool: string }>;
  rootCauseSummary: string;
  hypotheses: Array<{ statement: string; status: string }>;
}

export interface EvalResult {
  caseId: string;
  checks: Array<{ check: EvalCheck; passed: boolean; reason?: string }>;
  passedAll: boolean;
}
