import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { restartService, killProcess, runCommand } from "./runner.js";
import { sanitizePattern } from "./allowlist.js";

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

describe("MCP Server Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupExecSuccess(stdout = "", stderr = "") {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, Buffer.from(stdout), Buffer.from(stderr));
    });
  }

  function setupExecFailure(code: number, stdout = "", stderr = "") {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      const err: any = new Error(`exit ${code}`);
      err.code = code;
      cb(err, Buffer.from(stdout), Buffer.from(stderr));
    });
  }

  it("restarts allowed services", async () => {
    setupExecSuccess();
    const res = await restartService("nginx");
    expect(res.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "systemctl",
      ["restart", "nginx"],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function)
    );
  });

  it("rejects services not in allowlist", async () => {
    const res = await restartService("mysql");
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许重启列表中");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("kills process with allowed signal", async () => {
    setupExecSuccess();
    const res = await killProcess(1234, "SIGTERM");
    expect(res.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "kill",
      ["-SIGTERM", "1234"],
      expect.objectContaining({ timeout: 10000 }),
      expect.any(Function)
    );
  });

  it("rejects disallowed signals", async () => {
    const res = await killProcess(1234, "SIGKILL");
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许列表中");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("rejects invalid pid", async () => {
    const res = await killProcess(0, "SIGTERM");
    expect(res.success).toBe(false);
    expect(res.error).toContain("pid 必须大于 0");
  });

  it("surfaces command failure", async () => {
    setupExecFailure(1, "", "permission denied");
    const res = await killProcess(1234, "SIGTERM");
    expect(res.success).toBe(false);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("permission denied");
  });

  it("sanitizes pattern to prevent shell injection", () => {
    expect(sanitizePattern("orderApiWorker; rm -rf /")).toBe("orderApiWorkerrm-rf");
    expect(sanitizePattern("nginx-worker_1")).toBe("nginx-worker_1");
  });

  describe("runCommand", () => {
    it("executes allowed command", async () => {
      setupExecSuccess("Linux");
      const res = await runCommand("uname", ["-a"]);
      expect(res.success).toBe(true);
      expect(res.stdout).toBe("Linux");
      expect(mockExecFile).toHaveBeenCalledWith("uname", ["-a"], expect.any(Object), expect.any(Function));
    });

    it("rejects command outside allowlist", async () => {
      const res = await runCommand("rm", ["-rf", "/tmp"]);
      expect(res.success).toBe(false);
      expect(res.error).toContain("不在白名单中");
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("rejects command with path separator", async () => {
      const res = await runCommand("/bin/cat", ["/etc/passwd"]);
      expect(res.success).toBe(false);
      expect(res.error).toContain("不能包含路径");
    });

    it("rejects disallowed subcommand", async () => {
      const res = await runCommand("systemctl", ["restart", "nginx"]);
      expect(res.success).toBe(false);
      expect(res.error).toContain("不在允许子命令列表中");
    });

    it("allows read-only systemctl subcommand", async () => {
      setupExecSuccess("active");
      const res = await runCommand("systemctl", ["is-active", "nginx"]);
      expect(res.success).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith("systemctl", ["is-active", "nginx"], expect.any(Object), expect.any(Function));
    });
  });
});
