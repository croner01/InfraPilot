import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { db } from "../db/db.js";
import { seedAlerts } from "../demo/seedAlerts.js";
import { apiRouter } from "./api.js";

/** 不监听端口，直接以函数方式调用 express app（沙箱禁止 listen） */
function callRoute(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const [path, queryString] = url.split("?");
    const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
    const req = { method, url: path, body, headers: {}, params: {}, query } as any;
    let statusCode = 200;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: any) {
        resolve({ status: statusCode, body: data });
        return res;
      },
      send() {
        resolve({ status: statusCode, body: undefined });
        return res;
      },
      setHeader() {
        return res;
      },
    } as any;
    app(req, res, (err: unknown) => (err ? reject(err) : resolve({ status: statusCode, body: undefined })));
  });
}

describe("alerts API", () => {
  let app: express.Express;

  beforeEach(() => {
    db.prepare("DELETE FROM alerts").run();
    seedAlerts();
    app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
  });

  it("lists seeded alerts with camelCase fields", async () => {
    const res = await callRoute(app, "GET", "/api/alerts");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(3);
    expect(res.body.alerts[0].startedAt).toBeTruthy();
    expect(res.body.alerts[0].severity).toBe("p0");
  });

  it("filters by status", async () => {
    const res = await callRoute(app, "GET", "/api/alerts?status=firing");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(2);
    expect(res.body.alerts.every((a: { status: string }) => a.status === "firing")).toBe(true);
  });

  it("filters by severity", async () => {
    const res = await callRoute(app, "GET", "/api/alerts?severity=p2");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].id).toBe("alert-node08-disk");
  });
});
