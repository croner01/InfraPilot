import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../db/db.js";
import { executeSkillsTool } from "./tools.js";

describe("skills tools", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM skills").run();
  });

  it("lists installed skills", async () => {
    const r = await executeSkillsTool("list_installed", {});
    expect(r.success).toBe(true);
    const names = (r.data as { skills: Array<{ name: string }> }).skills.map((s) => s.name);
    expect(names).toContain("ceph-rbd-108");
  });

  it("reads a reference inside the skill dir", async () => {
    const r = await executeSkillsTool("read_reference", {
      skill_name: "ceph-rbd-108",
      file: "pool-blacklist.md",
    });
    expect(r.success).toBe(true);
    expect((r.data as { content: string }).content).toContain("pool_blacklist");
  });

  it("blocks path traversal", async () => {
    const r = await executeSkillsTool("read_reference", {
      skill_name: "ceph-rbd-108",
      file: "../SKILL.md",
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/非法/);
  });
});
