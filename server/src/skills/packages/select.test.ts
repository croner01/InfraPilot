import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../db/db.js";
import { selectSkillsForTurn } from "./select.js";

describe("per-turn skill selection", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM skills").run();
  });

  it("always includes the methodology skill", async () => {
    const sel = await selectSkillsForTurn("随便看看", []);
    expect(sel.map((p) => p.name)).toContain("sre-systematic-debugging");
  });

  it("keeps still-relevant previous skills and drops stale ones", async () => {
    const first = await selectSkillsForTurn("mariadb rbd 108 挂载失败", []);
    expect(first.map((p) => p.name)).toContain("ceph-rbd-108");

    const second = await selectSkillsForTurn("mariadb rbd 108 挂载失败", first.map((p) => p.name));
    expect(second.map((p) => p.name)).toContain("ceph-rbd-108");

    const third = await selectSkillsForTurn("画一张 OpenStack 架构拓扑图", second.map((p) => p.name));
    expect(third.map((p) => p.name)).not.toContain("ceph-rbd-108");
    expect(third.map((p) => p.name)).toContain("sre-systematic-debugging");
  });
});
