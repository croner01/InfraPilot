import fs from "node:fs";
import path from "node:path";
import type { SkillPackage, SkillFrontmatter } from "./types.js";

export const DEFAULT_SKILLS_DIR = path.join(process.cwd(), "skills");

export function getSkillsDir(): string {
  return process.env.INFRAPILOT_SKILLS_DIR
    ? path.resolve(process.env.INFRAPILOT_SKILLS_DIR)
    : DEFAULT_SKILLS_DIR;
}

export function parseFrontmatter(text: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!text.startsWith("---\n")) {
    throw new Error("SKILL.md 缺少 --- frontmatter 起始标记");
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("SKILL.md frontmatter 未闭合");
  }
  const raw = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  const frontmatter: SkillFrontmatter = { name: "", description: "" };
  for (const line of raw.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (m[1] === "name") frontmatter.name = value;
    else if (m[1] === "description") frontmatter.description = value;
  }
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error("SKILL.md frontmatter 必须包含 name 与 description");
  }
  return { frontmatter, body };
}

function listDir(base: string): string[] {
  try {
    return fs.readdirSync(base).filter((p) => !p.startsWith("."));
  } catch {
    return [];
  }
}

export function loadSkillPackage(dir: string): SkillPackage {
  const skillDir = path.resolve(dir);
  const name = path.basename(skillDir);
  const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  if (frontmatter.name !== name) {
    throw new Error(`技能目录名 ${name} 与 frontmatter.name ${frontmatter.name} 不一致`);
  }
  return {
    name,
    dir: skillDir,
    frontmatter,
    body,
    references: listDir(path.join(skillDir, "references")).map((p) => `references/${p}`),
    scripts: listDir(path.join(skillDir, "scripts")).map((p) => `scripts/${p}`),
    assets: listDir(path.join(skillDir, "assets")).map((p) => `assets/${p}`),
    enabled: true,
  };
}

export function scanSkillPackages(skillsDir: string = getSkillsDir()): SkillPackage[] {
  const out: SkillPackage[] = [];
  for (const entry of listDir(skillsDir)) {
    const full = path.join(skillsDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    try {
      out.push(loadSkillPackage(full));
    } catch (err) {
      console.warn(`[skills] 跳过无效技能包 ${entry}: ${(err as Error).message}`);
    }
  }
  return out;
}
