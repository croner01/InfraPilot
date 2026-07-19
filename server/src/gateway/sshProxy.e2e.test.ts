import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { executeRemoteCommand, loadHostRegistry } from "./sshProxy.js";

/**
 * 端到端验证：使用真实本地 SSH 服务验证远程命令执行。
 * 仅在 RUN_E2E_TESTS=true 时运行，避免无 SSH 环境的 CI 失败。
 */
const runE2e = process.env.RUN_E2E_TESTS === "true";

describe.skipIf(!runE2e)("sshProxy e2e", () => {
  const originalHosts = process.env.SSH_HOSTS;

  beforeAll(() => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [
        {
          name: "localhost-e2e",
          hostname: "127.0.0.1",
          port: 22,
          username: "root",
          auth: { type: "privateKey", privateKeyPath: "/root/.ssh/id_ed25519" },
        },
      ],
    });
  });

  afterAll(() => {
    if (originalHosts === undefined) delete process.env.SSH_HOSTS;
    else process.env.SSH_HOSTS = originalHosts;
  });

  it("loads host registry from env", () => {
    const registry = loadHostRegistry();
    expect(registry.hosts).toHaveLength(1);
    expect(registry.hosts[0].name).toBe("localhost-e2e");
  });

  it("executes uptime on local sshd", async () => {
    const res = await executeRemoteCommand({ host: "localhost-e2e", command: "uptime", args: [], timeoutMs: 10000 });
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("load average");
    expect(res.stderr).toBe("");
  });

  it("executes trusted pipeline command on local sshd", async () => {
    const res = await executeRemoteCommand({
      host: "localhost-e2e",
      command: "sh",
      args: ["-c", "top -b -n 1 | head -n 5"],
      cmdLine: "top -b -n 1 | head -n 5",
      timeoutMs: 10000,
    });
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("top");
  });

  it("rejects dangerous command on local sshd", async () => {
    const res = await executeRemoteCommand({ host: "localhost-e2e", command: "rm", args: ["-rf", "/tmp/test"], timeoutMs: 10000 });
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许列表中");
  });

  it("redacts token-like output", async () => {
    const res = await executeRemoteCommand({
      host: "localhost-e2e",
      command: "echo",
      args: ["token=Bearer abc123secret"],
      timeoutMs: 10000,
    });
    expect(res.success).toBe(true);
    expect(res.stdout).toContain("***REDACTED***");
    expect(res.stdout).not.toContain("abc123secret");
  });
});
