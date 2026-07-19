import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./grpcClient.js", () => ({
  grpcMcpClient: {
    health: vi.fn(),
    call: vi.fn(),
  },
}));

vi.mock("../skills/linux/remoteExecutor.js", () => ({
  executeOnHost: vi.fn(),
}));

vi.mock("./discovery.js", () => ({
  discoverTransport: vi.fn(),
  isReadonlyTool: vi.fn(),
}));

import { grpcMcpClient } from "./grpcClient.js";
import { executeOnHost } from "../skills/linux/remoteExecutor.js";
import { discoverTransport, isReadonlyTool } from "./discovery.js";
import { executeLinuxToolOnHost } from "./client.js";

const mockHealth = grpcMcpClient.health as ReturnType<typeof vi.fn>;
const mockCall = grpcMcpClient.call as ReturnType<typeof vi.fn>;
const mockDiscover = discoverTransport as ReturnType<typeof vi.fn>;
const mockReadonly = isReadonlyTool as ReturnType<typeof vi.fn>;
const mockExecuteOnHost = executeOnHost as ReturnType<typeof vi.fn>;

describe("MCP Client Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes local host through SSH fallback (local execution)", async () => {
    mockExecuteOnHost.mockResolvedValue({
      success: true,
      stdout: "local top output",
      stderr: "",
      durationMs: 10,
    });

    const res = await executeLinuxToolOnHost({
      tool: "get_cpu_usage",
      args: { host: "local" },
      caller: "linux-skill",
    });

    expect(res.success).toBe(true);
    expect(res.stdout).toBe("local top output");
    expect(res.data).toMatchObject({ transport: "ssh_proxy" });
    expect(mockExecuteOnHost).toHaveBeenCalledWith(
      "local",
      "sh",
      ["-c", "top -b -n 1 | head -n 15"],
      expect.objectContaining({ caller: "linux-skill" })
    );
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("uses gRPC when MCP endpoint is healthy", async () => {
    mockDiscover.mockReturnValue({
      host: "node-1",
      mcpEnabled: true,
      mcpEndpoint: { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      sshFallback: true,
    });
    mockHealth.mockResolvedValue({ ok: true, version: "0.2.0" });
    mockCall.mockResolvedValue({ success: true, data: { usage_percent: 5 }, durationMs: 20 });

    const res = await executeLinuxToolOnHost({
      tool: "get_cpu_usage",
      args: { host: "node-1" },
      caller: "linux-skill",
    });

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ usage_percent: 5, transport: "grpc" });
    expect(mockHealth).toHaveBeenCalled();
    expect(mockCall).toHaveBeenCalled();
  });

  it("falls back to SSH for readonly tools when MCP is unhealthy", async () => {
    mockDiscover.mockReturnValue({
      host: "node-1",
      mcpEnabled: true,
      mcpEndpoint: { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      sshFallback: true,
    });
    mockHealth.mockResolvedValue({ ok: false, error: "connection refused" });
    mockReadonly.mockReturnValue(true);
    mockExecuteOnHost.mockResolvedValue({
      success: true,
      stdout: "ssh top output",
      stderr: "",
      durationMs: 100,
    });

    const res = await executeLinuxToolOnHost({
      tool: "get_cpu_usage",
      args: { host: "node-1" },
      caller: "linux-skill",
    });

    expect(res.success).toBe(true);
    expect(res.stdout).toBe("ssh top output");
    expect(res.data).toMatchObject({ transport: "ssh_proxy" });
    expect(mockExecuteOnHost).toHaveBeenCalled();
  });

  it("refuses SSH fallback for mutation tools when MCP is unavailable", async () => {
    mockDiscover.mockReturnValue({
      host: "node-1",
      mcpEnabled: true,
      mcpEndpoint: { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      sshFallback: true,
    });
    mockHealth.mockResolvedValue({ ok: false, error: "connection refused" });
    mockReadonly.mockReturnValue(false);

    const res = await executeLinuxToolOnHost({
      tool: "restart_service",
      args: { host: "node-1", service_name: "nginx" },
      caller: "linux-skill",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("变更类工具 restart_service 不允许通过 SSH 执行");
    expect(mockExecuteOnHost).not.toHaveBeenCalled();
  });

  it("returns error when no transport is available", async () => {
    mockDiscover.mockReturnValue({
      host: "node-1",
      mcpEnabled: false,
      sshFallback: false,
    });

    const res = await executeLinuxToolOnHost({
      tool: "get_cpu_usage",
      args: { host: "node-1" },
      caller: "linux-skill",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("未找到主机 node-1 的可用执行通道");
  });

  it("still falls back to SSH when health check throws", async () => {
    mockDiscover.mockReturnValue({
      host: "node-1",
      mcpEnabled: true,
      mcpEndpoint: { host: "node-1", transport: "grpc", grpcTarget: "node-1:8443" },
      sshFallback: true,
    });
    mockHealth.mockRejectedValue(new Error("network unreachable"));
    mockReadonly.mockReturnValue(true);
    mockExecuteOnHost.mockResolvedValue({
      success: true,
      stdout: "ssh fallback",
      stderr: "",
      durationMs: 50,
    });

    const res = await executeLinuxToolOnHost({
      tool: "get_cpu_usage",
      args: { host: "node-1" },
      caller: "linux-skill",
    });

    expect(res.success).toBe(true);
    expect(res.stdout).toBe("ssh fallback");
  });
});
