import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSkillsDir, loadSkillPackage } from "./loader.js";
import { refreshSkillStore, skillStore } from "./registry.js";
import { upsertSkillRow } from "../../db/db.js";

const execFileAsync = promisify(execFile);

export interface InstallOptions {
  repo: string;
  path: string;
  ref?: string;
  token?: string;
}

export interface CuratedSkill {
  name: string;
  repo: string;
  path: string;
  description: string;
}

function curatedPath(): string {
  return fileURLToPath(new URL("./curated-skills.json", import.meta.url));
}

export function listCuratedSkills(): CuratedSkill[] {
  try {
    return JSON.parse(fs.readFileSync(curatedPath(), "utf8")) as CuratedSkill[];
  } catch {
    return [];
  }
}

/** 校验并把 src 下的技能复制到 target；返回技能名 */
export function copySkillIntoPlace(src: string, target: string): string {
  if (fs.existsSync(target)) throw new Error(`技能 ${path.basename(target)} 已存在，先卸载或手动覆盖`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(src, target, { recursive: true });
  loadSkillPackage(target); // 校验失败会抛错
  return path.basename(target);
}

export async function installFromGitHub(opts: InstallOptions): Promise<string> {
  const ref = opts.ref ?? "main";
  const destName = path.basename(opts.path);
  const target = path.join(getSkillsDir(), destName);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-install-"));
  try {
    const repoUrl = opts.token
      ? `https://x-access-token:${opts.token}@github.com/${opts.repo}.git`
      : `https://github.com/${opts.repo}.git`;
    await execFileAsync("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "-b", ref, repoUrl, tmp]);
    await execFileAsync("git", ["-C", tmp, "sparse-checkout", "set", opts.path]);
    const src = path.join(tmp, opts.path);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) {
      throw new Error(`路径 ${opts.path} 下没有 SKILL.md`);
    }
    copySkillIntoPlace(src, target);
    upsertSkillRow({
      name: destName,
      dir: target,
      source: `github:${opts.repo}:${opts.path}`,
      version: ref,
      enabled: 1,
    });
    await refreshSkillStore();
    return destName;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function uninstallSkill(name: string): Promise<void> {
  if (name.startsWith("sre-")) throw new Error(`内置技能 ${name} 禁止卸载`);
  const p = skillStore.get(name);
  if (!p) throw new Error(`技能 ${name} 未安装`);
  fs.rmSync(p.dir, { recursive: true, force: true });
  await skillStore.remove(name);
}
