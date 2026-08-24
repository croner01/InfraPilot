import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../db/db.js";
import { skillStore } from "./registry.js";

describe("skill registry", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM skills").run();
  });

  it("indexes enabled skills from INFRAPILOT_SKILLS_DIR", async () => {
    await skillStore.init();
    const names = skillStore.list().map((p) => p.name);
    expect(names).toContain("sre-systematic-debugging");
    expect(names).toContain("ceph-rbd-108");
  });

  it("recalls ceph skill for rbd 108 query", async () => {
    const r = await skillStore.recall("mariadb rbd 108 Cannot send after transport endpoint shutdown", 3);
    expect(r.map((x) => x.name)).toContain("ceph-rbd-108");
  });

  it("excludes disabled skills from recall", async () => {
    await skillStore.setEnabled("ceph-rbd-108", false);
    const r = await skillStore.recall("mariadb rbd 108 Cannot send after transport endpoint shutdown", 3);
    expect(r.map((x) => x.name)).not.toContain("ceph-rbd-108");
  });
});
