import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeOnHost } from "./remoteExecutor.js";

vi.mock("../../gateway/sshProxy.js", () => ({
  executeRemoteCommand: vi.fn(),
}));

import { executeRemoteCommand } from "../../gateway/sshProxy.js";

describe("remoteExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes local command when host is local", async () => {
    const res = await executeOnHost("local", "echo", ["hello"]);
    expect(res.success).toBe(true);
    expect(res.stdout?.trim()).toBe("hello");
    expect(executeRemoteCommand).not.toHaveBeenCalled();
  });

  it("routes to SSH proxy when host is not local", async () => {
    const mocked = executeRemoteCommand as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValue({
      success: true,
      stdout: "remote output",
      stderr: "",
      exitCode: 0,
      durationMs: 100,
    });

    const res = await executeOnHost("node-1", "uptime", []);
    expect(res.success).toBe(true);
    expect(res.stdout).toBe("remote output");
    expect(executeRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "node-1",
        command: "uptime",
        args: [],
        caller: "linux-skill",
      })
    );
  });

  it("returns error for local command failure", async () => {
    const res = await executeOnHost("local", "false", []);
    expect(res.success).toBe(false);
    expect(res.error).toContain("退出码非 0");
  });

  it("defaults to local when host is undefined or empty", async () => {
    const res1 = await executeOnHost("", "echo", ["hello"]);
    expect(res1.success).toBe(true);
    expect(res1.stdout?.trim()).toBe("hello");

    const res2 = await executeOnHost(undefined as any, "echo", ["hello"]);
    expect(res2.success).toBe(true);
    expect(res2.stdout?.trim()).toBe("hello");
  });

  it("passes sh -c cmdLine to SSH proxy", async () => {
    const mocked = executeRemoteCommand as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValue({
      success: true,
      stdout: "remote pipeline output",
      stderr: "",
      exitCode: 0,
      durationMs: 50,
    });

    const res = await executeOnHost("node-1", "sh", ["-c", "top -b -n 1 | head -n 15"]);
    expect(res.success).toBe(true);
    expect(executeRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "node-1",
        command: "sh",
        args: ["-c", "top -b -n 1 | head -n 15"],
        cmdLine: "top -b -n 1 | head -n 15",
        caller: "linux-skill",
      })
    );
  });

  it("propagates remote execution errors", async () => {
    const mocked = executeRemoteCommand as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
      durationMs: 30,
      error: "远程命令退出码非 0: 1",
    });

    const res = await executeOnHost("node-1", "uptime", []);
    expect(res.success).toBe(false);
    expect(res.error).toContain("远程命令退出码非 0");
    expect(res.stderr).toContain("permission denied");
  });
});
