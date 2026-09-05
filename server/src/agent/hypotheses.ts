import { v4 as uuidv4 } from "uuid";
import type { Evidence, Hypothesis } from "../types.js";

export interface HypothesisInput {
  statement: string;
  status: Hypothesis["status"];
}

/** 按 statement 合并假设：同文本更新状态，新文本追加；返回新数组不修改入参 */
export function mergeHypotheses(existing: Hypothesis[], incoming: HypothesisInput[]): Hypothesis[] {
  const result = existing.map((h) => ({ ...h }));
  for (const item of incoming) {
    const found = result.find((h) => h.statement === item.statement);
    if (found) {
      found.status = item.status;
      found.updatedAt = new Date().toISOString();
    } else {
      result.push({
        id: `hyp-${uuidv4()}`,
        statement: item.statement,
        status: item.status,
        evidenceIds: [],
        toolCallIds: [],
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return result;
}

/** 把假设文本里的 证据#N / 证据N 映射为 session.evidence 中第 N 条（1-based）的 id */
export function linkHypothesesToEvidence(hypotheses: Hypothesis[], evidence: Evidence[]): Hypothesis[] {
  return hypotheses.map((h) => {
    const ids = Array.from(h.statement.matchAll(/证据#?(\d+)/g))
      .map((m) => {
        const index = Number(m[1]) - 1;
        return index >= 0 && index < evidence.length ? evidence[index].id : undefined;
      })
      .filter((id): id is string => Boolean(id));
    return ids.length > 0 ? { ...h, evidenceIds: Array.from(new Set([...h.evidenceIds, ...ids])) } : h;
  });
}
