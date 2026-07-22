// 必须在静态导入前设置 proto 路径，确保 protoLoader 能找到 proto 文件
process.env.MCP_PROTO_PATH = "/root/InfraPilot/server/proto/linux_diagnostic.proto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as grpc from "@grpc/grpc-js";
import { proto, getLinuxDiagnosticClient } from "../protoLoader.js";
import { linuxDiagnosticService } from "./service.js";
import { grpcMcpClient } from "../grpcClient.js";
import { signMcpJwt } from "../auth.js";
import type { McpEndpoint } from "../types.js";

function startTestServer(): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(proto.infrapilot.linux.LinuxDiagnostic.service, linuxDiagnosticService);
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      resolve({ server, port });
    });
  });
}

describe("linux-mcp-server service integration", () => {
  let server: grpc.Server;
  let port: number;
  let target: string;
  let endpoint: McpEndpoint;

  beforeAll(async () => {
    ({ server, port } = await startTestServer());
    target = `127.0.0.1:${port}`;
    endpoint = { host: "test-node", transport: "grpc", grpcTarget: target };
  }, 30000);

  afterAll(() => {
    return new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
  });

  it("Health requires no auth", async () => {
    const res = await grpcMcpClient.health(endpoint);
    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.2.0");
  });

  it("GetCpuUsage with valid token returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "get_cpu_usage",
      args: { host: "local", top_n: 3 },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("usage_percent");
    expect(res.data).toHaveProperty("top_processes");
  });

  it("GetMemoryInfo with valid token returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "get_memory_info",
      args: { host: "local" },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("total_mb");
    expect(res.data).toHaveProperty("used_mb");
    expect(res.data).toHaveProperty("available_mb");
  });

  it("GetDiskUsage with valid token returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "get_disk_usage",
      args: { host: "local" },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("disks");
  });

  it("GetNetworkStats with valid token returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "get_network_stats",
      args: { host: "local" },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("interfaces");
  });

  it("GetProcessInfo with valid token returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "get_process_info",
      args: { host: "local", name_pattern: "node" },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("processes");
  });

  it("TailSyslog with valid token returns structured data", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "tail_syslog",
      args: { host: "local", lines: 5 },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("lines");
  });

  it("RestartService rejects services outside allowlist", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "restart_service",
      args: { host: "local", service_name: "mysql" },
      caller: "test",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许重启列表中");
  });

  it("KillProcess rejects disallowed signals", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "kill_process",
      args: { host: "local", pid: 1234, signal: "SIGKILL" },
      caller: "test",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("信号");
  });

  it("RunCommand executes allowed command", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "run_command",
      args: { host: "local", command: "uname", args: ["-a"] },
      caller: "test",
    });
    expect(res.success).toBe(true);
    expect(res.stdout).toBeTruthy();
  });

  it("RunCommand rejects disallowed command", async () => {
    const res = await grpcMcpClient.call(endpoint, {
      tool: "run_command",
      args: { host: "local", command: "rm", args: ["-rf", "/tmp"] },
      caller: "test",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在白名单中");
  });

  it("returns UNAUTHENTICATED when token is missing", async () => {
    const client = getLinuxDiagnosticClient(target, grpc.credentials.createInsecure());
    return new Promise<void>((resolve, reject) => {
      client.GetCpuUsage({}, new grpc.Metadata(), { deadline: Date.now() + 5000 }, (err: any) => {
        try {
          expect(err).toBeDefined();
          expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("returns PERMISSION_DENIED when token scope does not match", async () => {
    const client = getLinuxDiagnosticClient(target, grpc.credentials.createInsecure());
    const meta = new grpc.Metadata();
    const token = signMcpJwt({ sessionId: "test", tools: ["get_memory_info"] });
    meta.add("authorization", `Bearer ${token}`);

    return new Promise<void>((resolve, reject) => {
      client.GetCpuUsage({}, meta, { deadline: Date.now() + 5000 }, (err: any) => {
        try {
          expect(err).toBeDefined();
          expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("returns UNAUTHENTICATED when token is invalid", async () => {
    const client = getLinuxDiagnosticClient(target, grpc.credentials.createInsecure());
    const meta = new grpc.Metadata();
    meta.add("authorization", "Bearer invalid-token");

    return new Promise<void>((resolve, reject) => {
      client.GetCpuUsage({}, meta, { deadline: Date.now() + 5000 }, (err: any) => {
        try {
          expect(err).toBeDefined();
          expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});
