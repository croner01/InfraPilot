import { describe, it, expect, beforeEach } from "vitest";
import { db, listAlerts } from "../db/db.js";
import { seedAlerts } from "./seedAlerts.js";

describe("seedAlerts", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM alerts").run();
  });

  it("seeds demo alerts and is idempotent", () => {
    expect(seedAlerts()).toBe(3);
    expect(seedAlerts()).toBe(3);
    expect(listAlerts()).toHaveLength(3);
  });
});
