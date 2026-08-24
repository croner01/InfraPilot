import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { installFromGitHub, copySkillIntoPlace, uninstallSkill, listCuratedSkills } from "./installer.js";
import { listSkillRows } from "../../db/db.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

describe("skill installer", () => {
  const testTmp = path.join(os.tmpdir(), "skill-install-test");
  const testDest = path.join(os.tmpdir(), "skill-install-dest");
  const cloneSrc = path.join(testTmp, "skills", "fixture-skill");

  beforeEach(() => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], cb?: (err: Error | null, stdout?: string) => void) => {
        if (cb) cb(null, "");
      }
    );
    fs.rmSync(testTmp, { recursive: true, force: true });
    fs.rmSync(testDest, { recursive: true, force: true });
    fs.mkdirSync(cloneSrc, { recursive: true });
    fs.writeFileSync(path.join(cloneSrc, "SKILL.md"), "---\nname: fixture-skill\ndescription: 测试\n---\n正文");
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(testTmp);
    process.env.INFRAPILOT_SKILLS_DIR = testDest;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.INFRAPILOT_SKILLS_DIR;
    fs.rmSync(testTmp, { recursive: true, force: true });
    fs.rmSync(testDest, { recursive: true, force: true });
  });

  it("copies a validated skill into place", () => {
    copySkillIntoPlace(cloneSrc, path.join(testDest, "fixture-skill"));
    expect(fs.existsSync(path.join(testDest, "fixture-skill", "SKILL.md"))).toBe(true);
  });

  it("installs from a github repo via git sparse checkout", async () => {
    await installFromGitHub({ repo: "acme/repo", path: "skills/fixture-skill", ref: "main" });
    expect(fs.existsSync(path.join(testDest, "fixture-skill", "SKILL.md"))).toBe(true);
    expect(listSkillRows().map((r) => r.name)).toContain("fixture-skill");
    expect(execFile).toHaveBeenCalled();
  });

  it("aborts when the skill already exists", async () => {
    fs.mkdirSync(path.join(testDest, "fixture-skill"), { recursive: true });
    await expect(installFromGitHub({ repo: "acme/repo", path: "skills/fixture-skill" })).rejects.toThrow(/已存在/);
  });

  it("lists curated skills from JSON", () => {
    const curated = listCuratedSkills();
    expect(Array.isArray(curated)).toBe(true);
    expect(curated[0]).toHaveProperty("repo");
    expect(curated[0]).toHaveProperty("path");
  });

  it("forbids uninstalling builtin skills", async () => {
    await expect(uninstallSkill("sre-systematic-debugging")).rejects.toThrow(/禁止卸载/);
  });
});
