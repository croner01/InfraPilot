/** 列表类工具输出的公共约定：countBy 用于 summary 聚合，capSamples 用于样本截断 */
export function countBy<T extends string>(values: T[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

export function capSamples<T>(samples: T[], limit: number): { samples: T[]; truncated: boolean } {
  return { samples: samples.slice(0, limit), truncated: samples.length > limit };
}
