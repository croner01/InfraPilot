import { v4 as uuidv4 } from "uuid";
import type { Hypothesis } from "../types.js";

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
