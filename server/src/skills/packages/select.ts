import { skillStore, ALWAYS_ON_SKILLS, MAX_SKILLS_PER_TURN } from "./registry.js";
import type { SkillPackage } from "./types.js";

export interface SkillDoc {
  name: string;
  description: string;
  body: string;
}

export function toSkillDoc(p: SkillPackage): SkillDoc {
  return { name: p.name, description: p.frontmatter.description, body: p.body };
}

/**
 * 按轮选择技能：always-on 方法论技能 + 本轮召回的相关技能 +
 * 上一轮仍与当前 query 相关的技能（去重、预算截断）。
 */
export async function selectSkillsForTurn(query: string, previous: string[]): Promise<SkillPackage[]> {
  await skillStore.init();
  const recalled = await skillStore.recall(query, 3);
  const positive = recalled.filter((r) => r.score > 0);
  const byName = new Map(skillStore.list().map((p) => [p.name, p]));

  const alwaysOn = ALWAYS_ON_SKILLS.map((n) => byName.get(n))
    .filter((p): p is SkillPackage => !!p && p.enabled);
  const relevant = new Set<string>([
    ...alwaysOn.map((p) => p.name),
    ...positive.map((r) => r.name),
  ]);

  const ordered: Array<SkillPackage | undefined> = [
    ...alwaysOn,
    ...previous.map((n) => byName.get(n)).filter((p): p is SkillPackage => !!p && p.enabled && relevant.has(p.name)),
    ...positive.map((r) => byName.get(r.name)).filter((p): p is SkillPackage => !!p && p.enabled),
  ];

  const merged: SkillPackage[] = [];
  const seen = new Set<string>();
  for (const p of ordered) {
    if (!p || seen.has(p.name)) continue;
    seen.add(p.name);
    merged.push(p);
    if (merged.length >= MAX_SKILLS_PER_TURN) break;
  }
  return merged;
}
