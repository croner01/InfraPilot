import { describe, it, expect, beforeEach } from "vitest";
import { db, insertAlert, listAlerts, getAlert } from "./db.js";

describe("alerts store", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM alerts").run();
  });

  it("inserts and reads back an alert", () => {
    insertAlert({
      id: "a1",
      severity: "p0",
      title: "order-api Pod CrashLoopBackOff",
      source: "order-service/order-api · Prometheus",
      service: "order-api",
      status: "firing",
      started_at: "2026-08-25T10:24:00Z",
      session_id: null,
    });
    const row = getAlert("a1");
    expect(row?.severity).toBe("p0");
    expect(row?.status).toBe("firing");
    expect(row?.title).toBe("order-api Pod CrashLoopBackOff");
  });

  it("lists alerts with status and severity filters", () => {
    insertAlert({
      id: "a1",
      severity: "p0",
      title: "t1",
      source: "s",
      service: "svc1",
      status: "firing",
      started_at: "2026-08-25T10:24:00Z",
      session_id: null,
    });
    insertAlert({
      id: "a2",
      severity: "p1",
      title: "t2",
      source: "s",
      service: "svc2",
      status: "acknowledged",
      started_at: "2026-08-25T09:00:00Z",
      session_id: null,
    });
    expect(listAlerts({ status: "firing" })).toHaveLength(1);
    expect(listAlerts({ severity: "p1" })).toHaveLength(1);
    expect(listAlerts()).toHaveLength(2);
  });
});
