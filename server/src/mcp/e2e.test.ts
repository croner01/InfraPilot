// 必须在静态导入前设置 proto 路径与 JWT secret（客户端与服务端需一致）
process.env.MCP_PROTO_PATH = "/root/InfraPilot/server/proto/linux_diagnostic.proto";
process.env.MCP_JWT_SECRET = "e2e-test-secret";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { grpcMcpClient } from "./grpcClient.js";
import type { McpEndpoint } from "./types.js";

const describeE2e = process.env.RUN_MCP_E2E === "true" ? describe : describe.skip;

function startStandaloneServer(): Promise<{ process: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const tsx = path.resolve("node_modules/.bin/tsx");
    const child = spawn(tsx, ["src/index.ts"], {
      env: {
        ...process.env,
        MCP_SERVER_MODE: "true",
        MCP_SERVER_PORT: "0",
        MCP_JWT_SECRET: "e2e-test-secret",
      },
      cwd: process.cwd(),
    });

    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on :(\d+)/);
      if (match && !child.killed) {
        resolve({ process: child, port: Number(match[1]) });
      }
    });

    child.stderr?.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on :(\d+)/);
      if (match && !child.killed) {
        resolve({ process: child, port: Number(match[1]) });
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`standalone MCP server exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!child.killed) child.kill();
      reject(new Error("timeout waiting for standalone MCP server to start"));
    }, 30000);
  });
}

describeE2e("linux-mcp-server standalone E2E", () => {
  let child: ChildProcess;
  let port: number;
  let endpoint: McpEndpoint;

  beforeAll(async () => {
    ({ process: child, port } = await startStandaloneServer());
    endpoint = { host: "e2e-node", transport: "grpc", grpcTarget: `127.0.0.1:${port}` };
  }, 40000);

  afterAll(() => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  });

  it("health returns ok", async () => {
    const res = await grpcMcpClient.health(endpoint);
    expect(res.ok).toBe(true);
  });

  it("GetCpuUsage returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "get_cpu_usage",
      args: { host: "local", top_n: 3 },
      caller: "e2e",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("usage_percent");
  });
});
