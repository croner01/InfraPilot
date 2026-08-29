import { describe, it, expect } from "vitest";
import { createSession } from "./sessionStore.js";
import { db } from "../db/db.js";

describe("createSession", () => {
  it("initializes empty hypotheses list", () => {
    const session = createSession("test-hypotheses");
    expect(session.hypotheses).toEqual([]);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
  });
});
