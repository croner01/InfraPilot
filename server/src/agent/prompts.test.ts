import { describe, it, expect } from "vitest";
import { buildSkillContext } from "./prompts.js";

describe("buildSkillContext", () => {
  it("renders skill docs with priority and trust notes", () => {
    const ctx = buildSkillContext([
      { name: "ceph-rbd-108", description: "RBD 108 排查", body: "1. ceph osd blacklist pool ls" },
    ]);
    expect(ctx).toContain("当前激活技能");
    expect(ctx).toContain("untrusted_instructions");
    expect(ctx).toContain("## ceph-rbd-108");
    expect(ctx).toContain("ceph osd blacklist pool ls");
  });

  it("returns empty string for no skills", () => {
    expect(buildSkillContext([])).toBe("");
  });
});
