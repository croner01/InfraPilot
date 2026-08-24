import { describe, it, expect, beforeEach } from "vitest";
import { db, listSkillRows, upsertSkillRow, setSkillEnabledRow, deleteSkillRow } from "./db.js";

describe("skills table", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM skills").run();
  });

  it("upserts and lists a skill row", () => {
    upsertSkillRow({ name: "a", dir: "/tmp/a", source: "github:x/y", version: "main", enabled: 1 });
    const rows = listSkillRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("a");
    expect(rows[0].source).toBe("github:x/y");
  });

  it("upsert is idempotent on name", () => {
    upsertSkillRow({ name: "a", dir: "/tmp/a", enabled: 1 });
    upsertSkillRow({ name: "a", dir: "/tmp/a2", enabled: 0 });
    const rows = listSkillRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dir).toBe("/tmp/a2");
    expect(rows[0].enabled).toBe(0);
  });

  it("toggles enabled and deletes", () => {
    upsertSkillRow({ name: "a", dir: "/tmp/a", enabled: 1 });
    setSkillEnabledRow("a", false);
    expect(listSkillRows()[0].enabled).toBe(0);
    deleteSkillRow("a");
    expect(listSkillRows()).toHaveLength(0);
  });
});
