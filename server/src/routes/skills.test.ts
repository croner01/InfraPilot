import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { db } from "../db/db.js";
import { skillsRouter } from "./skills.js";

/** 不监听端口，直接以函数方式调用 express app（沙箱禁止 listen） */
function callRoute(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = { method, url, body, headers: {}, params: {}, query: {} } as any;
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

describe("skills API", () => {
  let app: express.Express;

  beforeEach(() => {
    db.prepare("DELETE FROM skills").run();
    app = express();
    app.use(express.json());
    app.use("/api/skills", skillsRouter);
  });

  it("lists installed skills", async () => {
    const res = await callRoute(app, "GET", "/api/skills");
    expect(res.status).toBe(200);
    expect(res.body.skills.map((s: { name: string }) => s.name)).toContain("ceph-rbd-108");
  });

  it("returns curated skills", async () => {
    const res = await callRoute(app, "GET", "/api/skills/curated");
    expect(res.status).toBe(200);
    expect(res.body.skills.length).toBeGreaterThan(0);
    expect(res.body.skills[0].repo).toBeTruthy();
  });

  it("toggles skill enabled state", async () => {
    const res = await callRoute(app, "PATCH", "/api/skills/ceph-rbd-108", { enabled: false });
    expect(res.status).toBe(200);
    const listRes = await callRoute(app, "GET", "/api/skills");
    expect(listRes.body.skills.find((s: { name: string }) => s.name === "ceph-rbd-108")?.enabled).toBe(false);
  });
});
