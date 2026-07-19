import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeRemoteCommand } from "./sshProxy.js";

// Mock ssh2 Client
const mockConnect = vi.fn();
const mockEnd = vi.fn();
const mockExec = vi.fn();

function MockClient(this: any) {
  this.connect = mockConnect;
  this.end = mockEnd;
  this.exec = mockExec;
  this.on = (event: string, cb: Function) => {
      if (event === "ready") {
        (mockConnect as any)._readyCb = cb;
      }
      if (event === "error") {
        (mockConnect as any)._errorCb = cb;
      }
    };
}

vi.mock("ssh2", () => ({
  Client: MockClient,
}));

describe("sshProxy", () => {
  let tmpDir = "";
  let originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-proxy-"));
    originalEnv = {
      SSH_HOSTS: process.env.SSH_HOSTS,
      SSH_HOSTS_CONFIG: process.env.SSH_HOSTS_CONFIG,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      MY_SSH_KEY: process.env.MY_SSH_KEY,
      NODE_PASSWORD: process.env.NODE_PASSWORD,
    };
    delete process.env.SSH_HOSTS;
    delete process.env.SSH_HOSTS_CONFIG;
    delete process.env.SSH_AUTH_SOCK;
    delete process.env.MY_SSH_KEY;
    delete process.env.NODE_PASSWORD;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setupSuccessfulExec(stdout: string, stderr: string, exitCode: number | null) {
    mockConnect.mockImplementation(() => {
      setImmediate(() => (mockConnect as any)._readyCb?.());
    });
    mockExec.mockImplementation((_cmd: string, cb: Function) => {
      const stream = {
        on: (event: string, handler: Function) => {
          if (event === "close") {
            setImmediate(() => handler(exitCode, null));
          }
          if (event === "data") {
            handler(Buffer.from(stdout));
          }
        },
        stderr: {
          on: (event: string, handler: Function) => {
            if (event === "data") {
              handler(Buffer.from(stderr));
            }
          },
        },
      };
      cb(null, stream);
    });
  }

  it("rejects commands not in allowlist", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    const res = await executeRemoteCommand({ host: "node-1", command: "rm", args: ["-rf", "/"] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许列表中");
  });

  it("rejects dangerous systemctl subcommands", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    const res = await executeRemoteCommand({ host: "node-1", command: "systemctl", args: ["restart", "nginx"] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许列表中");
  });

  it("allows readonly systemctl status", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    setupSuccessfulExec("active\n", "", 0);

    const res = await executeRemoteCommand({ host: "node-1", command: "systemctl", args: ["status", "nginx"] });
    expect(res.success).toBe(true);
    expect(mockExec).toHaveBeenCalled();
    const calledCmd = mockExec.mock.calls[0][0] as string;
    expect(calledCmd).toContain("systemctl status nginx");
  });

  it("returns error when host not found", async () => {
    process.env.SSH_HOSTS = JSON.stringify({ hosts: [] });
    const res = await executeRemoteCommand({ host: "missing", command: "top", args: [] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("未在 Host Registry 中找到主机");
  });

  it("escapes shell metacharacters in args", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    const res = await executeRemoteCommand({ host: "node-1", command: "ps", args: ["-eo", "pid;rm -rf /"] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("不在允许列表中");
  });

  it("uses private key from file", async () => {
    const keyFile = path.join(tmpDir, "id_rsa");
    fs.writeFileSync(keyFile, "PRIVATE KEY CONTENT");
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "privateKey", privateKeyPath: keyFile } }],
    });
    setupSuccessfulExec("ok\n", "", 0);

    await executeRemoteCommand({ host: "node-1", command: "uptime", args: [] });
    expect(mockConnect).toHaveBeenCalled();
    const config = mockConnect.mock.calls[0][0];
    expect(config.privateKey).toBe("PRIVATE KEY CONTENT");
    expect(config.username).toBe("ops");
  });

  it("redacts sensitive output", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    setupSuccessfulExec("password=secret123\n", "", 0);

    const res = await executeRemoteCommand({ host: "node-1", command: "cat", args: ["/etc/config"] });
    expect(res.success).toBe(true);
    expect(res.stdout).not.toContain("secret123");
    expect(res.stdout).toContain("***REDACTED***");
  });

  it("allows trusted cmdLine for pipeline diagnostics", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    setupSuccessfulExec("cpu line 1\ncpu line 2\n", "", 0);

    const res = await executeRemoteCommand({ host: "node-1", command: "sh", args: ["-c", "top -b -n 1 | head -n 15"], cmdLine: "top -b -n 1 | head -n 15" });
    expect(res.success).toBe(true);
    expect(mockExec).toHaveBeenCalled();
    expect((mockExec.mock.calls[0][0] as string)).toBe("top -b -n 1 | head -n 15");
  });

  it("rejects untrusted cmdLine", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    const res = await executeRemoteCommand({ host: "node-1", command: "sh", args: ["-c", "rm -rf /"], cmdLine: "rm -rf /" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("受信任的模板");
  });

  it("returns error on SSH connection failure", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    mockConnect.mockImplementation(() => {
      setImmediate(() => (mockConnect as any)._errorCb?.(new Error("ECONNREFUSED")));
    });

    const res = await executeRemoteCommand({ host: "node-1", command: "uptime", args: [] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("SSH 连接失败");
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("reports non-zero exit code as failure", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    setupSuccessfulExec("", "not found", 1);

    const res = await executeRemoteCommand({ host: "node-1", command: "systemctl", args: ["status", "missing"] });
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain("退出码非 0");
  });

  it("uses private key from environment variable", async () => {
    process.env.MY_SSH_KEY = "ENV-KEY-DATA";
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "privateKey", privateKeyEnv: "MY_SSH_KEY" } }],
    });
    setupSuccessfulExec("ok\n", "", 0);

    await executeRemoteCommand({ host: "node-1", command: "uptime", args: [] });
    const config = mockConnect.mock.calls[0][0];
    expect(config.privateKey).toBe("ENV-KEY-DATA");
  });

  it("resolves password from environment variable", async () => {
    process.env.NODE_PASSWORD = "from-env";
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", passwordEnv: "NODE_PASSWORD" } }],
    });
    setupSuccessfulExec("ok\n", "", 0);

    await executeRemoteCommand({ host: "node-1", command: "uptime", args: [] });
    const config = mockConnect.mock.calls[0][0];
    expect(config.password).toBe("from-env");
  });

  it("uses SSH agent when auth type is agent", async () => {
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent";
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "agent" } }],
    });
    setupSuccessfulExec("ok\n", "", 0);

    await executeRemoteCommand({ host: "node-1", command: "uptime", args: [] });
    const config = mockConnect.mock.calls[0][0];
    expect(config.agent).toBe("/tmp/ssh-agent");
  });

  it("returns timeout error when command exceeds limit", async () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-1", hostname: "10.0.0.1", username: "ops", auth: { type: "password", password: "secret" } }],
    });
    mockConnect.mockImplementation(() => {
      setImmediate(() => (mockConnect as any)._readyCb?.());
    });
    mockExec.mockImplementation(() => {
      // 永远不触发 close,让 timeout 触发
    });

    const res = await executeRemoteCommand({ host: "node-1", command: "sleep", args: ["10"], timeoutMs: 50 });
    expect(res.success).toBe(false);
    expect(res.error).toContain("超时");
  });
});
