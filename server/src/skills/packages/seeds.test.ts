import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadSkillPackage } from "./loader.js";

describe("builtin seed skills", () => {
  const root = path.join(process.cwd(), "skills");

  it("loads the methodology skill", () => {
    const p = loadSkillPackage(path.join(root, "sre-systematic-debugging"));
    expect(p.name).toBe("sre-systematic-debugging");
    expect(p.body).toMatch(/根因/);
  });

  it("loads the ceph-rbd-108 skill with reference", () => {
    const p = loadSkillPackage(path.join(root, "ceph-rbd-108"));
    expect(p.name).toBe("ceph-rbd-108");
    expect(p.references).toContain("references/pool-blacklist.md");
    expect(p.body).toContain("ceph osd blacklist pool ls");
  });
});
