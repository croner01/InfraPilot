import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, loadSkillPackage, scanSkillPackages } from "./loader.js";

describe("skill loader", () => {
  it("parses valid frontmatter and body", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: demo\ndescription: 测试技能\n---\n# Body\n正文内容"
    );
    expect(frontmatter.name).toBe("demo");
    expect(frontmatter.description).toBe("测试技能");
    expect(body).toContain("# Body");
  });

  it("rejects missing description", () => {
    expect(() => parseFrontmatter("---\nname: demo\n---\nx")).toThrow(/description/);
  });

  it("loads package and lists bundled resources", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-"));
    const dir = path.join(base, "test-skill");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: test-skill\ndescription: 描述\n---\n正文");
    fs.mkdirSync(path.join(dir, "references"));
    fs.writeFileSync(path.join(dir, "references", "a.md"), "a");
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "scripts", "check.sh"), "#!/bin/sh\n");
    const p = loadSkillPackage(dir);
    expect(p.name).toBe("test-skill");
    expect(p.references).toEqual(["references/a.md"]);
    expect(p.scripts).toEqual(["scripts/check.sh"]);
  });

  it("rejects directory/frontmatter name mismatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: other\ndescription: 描述\n---\n正文");
    expect(() => loadSkillPackage(dir)).toThrow(/不一致/);
  });

  it("scans a directory and skips invalid packages", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-root-"));
    fs.mkdirSync(path.join(root, "valid-skill"));
    fs.writeFileSync(path.join(root, "valid-skill", "SKILL.md"), "---\nname: valid-skill\ndescription: 描述\n---\n正文");
    fs.mkdirSync(path.join(root, "bad-skill"));
    fs.writeFileSync(path.join(root, "bad-skill", "SKILL.md"), "no frontmatter");
    const packages = scanSkillPackages(root);
    expect(packages.map((p) => p.name)).toEqual(["valid-skill"]);
  });
});
