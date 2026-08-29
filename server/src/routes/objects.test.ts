import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";

vi.mock("../skills/elk/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/elk/tools.js")>();
  return {
    ...actual,
    executeElkTool: vi.fn(),
  };
});

import { executeElkTool } from "../skills/elk/tools.js";
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

describe("objects API", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
  });

  it("returns mapped logs for a pod", async () => {
    vi.mocked(executeElkTool).mockResolvedValue({
      success: true,
      data: { logs: [{ "@timestamp": "2026-08-25T10:24:31Z", level: "ERROR", message: "Memory limit exceeded" }] },
      durationMs: 12,
    } as any);

    const res = await callRoute(app, "GET", "/api/objects/order-service/order-api/logs?since=30m&limit=20");
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([
      { timestamp: "2026-08-25T10:24:31Z", level: "ERROR", message: "Memory limit exceeded" },
    ]);
    expect(executeElkTool).toHaveBeenCalledWith(
      "search_logs",
      expect.objectContaining({ namespace: "order-service", service: "order-api", since: "30m", limit: 20 })
    );
  });

  it("returns 500 when elk tool fails", async () => {
    vi.mocked(executeElkTool).mockResolvedValue({ success: false, error: "elk down", durationMs: 3 } as any);
    const res = await callRoute(app, "GET", "/api/objects/order-service/order-api/logs");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("elk down");
  });
});
