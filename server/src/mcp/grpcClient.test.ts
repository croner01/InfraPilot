import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Metadata } from "@grpc/grpc-js";

const mockGetLinuxDiagnosticClient = vi.fn();
const mockSignJwt = vi.fn();
const mockCreateClientCredentials = vi.fn();

vi.mock("./protoLoader.js", () => ({
  getLinuxDiagnosticClient: (...args: any[]) => mockGetLinuxDiagnosticClient(...args),
}));

vi.mock("./auth.js", () => ({
  signMcpJwt: (...args: any[]) => mockSignJwt(...args),
  createClientCredentials: (...args: any[]) => mockCreateClientCredentials(...args),
  loadTlsConfigFromEnv: vi.fn(() => ({})),
}));

import { grpcMcpClient } from "./grpcClient.js";

describe("GrpcMcpClient", () => {
  let lastMetadata: Metadata | undefined;

  function createFakeClient(responseOverrides: Record<string, any> = {}, errorFor?: string) {
    const methods = [
      "GetCpuUsage",
      "GetMemoryInfo",
      "GetDiskUsage",
      "GetNetworkStats",
      "GetProcessInfo",
      "TailSyslog",
      "RestartService",
      "KillProcess",
      "Health",
    ];

    const client: any = {};
    for (const method of methods) {
      client[method] = vi.fn((_req: any, meta: Metadata, _opts: any, cb: Function) => {
        lastMetadata = meta;
        if (errorFor === method) {
          cb({ message: `${method} failed`, code: 14 });
          return;
        }
        cb(null, responseOverrides[method] ?? { success: true });
      });
    }
    return client;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    lastMetadata = undefined;
    mockSignJwt.mockReturnValue("test-jwt-token");
    mockCreateClientCredentials.mockReturnValue({});
  });

  it("health checks endpoint with JWT metadata", async () => {
    mockGetLinuxDiagnosticClient.mockReturnValue(createFakeClient({ Health: { ok: true, version: "0.2.0" } }));

    const res = await grpcMcpClient.health({ host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" });

    expect(res.ok).toBe(true);
    expect(res.version).toBe("0.2.0");
    expect(lastMetadata?.get("authorization")[0]).toBe("Bearer test-jwt-token");
  });

  it("returns ok=false when health RPC fails", async () => {
    mockGetLinuxDiagnosticClient.mockReturnValue(createFakeClient({}, "Health"));

    const res = await grpcMcpClient.health({ host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Health failed");
  });

  it("calls GetCpuUsage for get_cpu_usage tool", async () => {
    const fakeClient = createFakeClient({ GetCpuUsage: { success: true, usage_percent: 7.5, top_processes: [] } });
    mockGetLinuxDiagnosticClient.mockReturnValue(fakeClient);

    const res = await grpcMcpClient.call(
      { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      { tool: "get_cpu_usage", args: { host: "node-1", top_n: 3 }, caller: "linux-skill" }
    );

    expect(fakeClient.GetCpuUsage).toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ usage_percent: 7.5 });
  });

  it("calls RestartService for restart_service tool", async () => {
    const fakeClient = createFakeClient({ RestartService: { success: true, stdout: "restarted", exit_code: 0 } });
    mockGetLinuxDiagnosticClient.mockReturnValue(fakeClient);

    const res = await grpcMcpClient.call(
      { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      { tool: "restart_service", args: { host: "node-1", service_name: "nginx" }, caller: "linux-skill" }
    );

    expect(fakeClient.RestartService).toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("restarted");
  });

  it("returns error for unsupported tool", async () => {
    mockGetLinuxDiagnosticClient.mockReturnValue(createFakeClient());

    const res = await grpcMcpClient.call(
      { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      { tool: "unknown_tool", args: { host: "node-1" }, caller: "linux-skill" }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("不支持的 MCP 工具");
  });

  it("returns error when gRPC call fails", async () => {
    mockGetLinuxDiagnosticClient.mockReturnValue(createFakeClient({}, "GetMemoryInfo"));

    const res = await grpcMcpClient.call(
      { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      { tool: "get_memory_info", args: { host: "node-1" }, caller: "linux-skill" }
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("GetMemoryInfo failed");
  });
});
