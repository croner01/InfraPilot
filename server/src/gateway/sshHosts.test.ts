import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadHostsFromFile,
  loadHostsFromEnv,
  loadHostRegistry,
  findHost,
  getPrivateKeyContent,
  HostRegistry,
} from "./sshHosts.js";

describe("sshHosts", () => {
  let tmpDir = "";
  let originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-hosts-"));
    originalEnv = {
      SSH_HOSTS: process.env.SSH_HOSTS,
      SSH_HOSTS_CONFIG: process.env.SSH_HOSTS_CONFIG,
      TEST_SSH_KEY: process.env.TEST_SSH_KEY,
    };
    delete process.env.SSH_HOSTS;
    delete process.env.SSH_HOSTS_CONFIG;
    delete process.env.TEST_SSH_KEY;
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

  it("loads hosts from JSON file", () => {
    const registry: HostRegistry = {
      hosts: [
        {
          name: "node-1",
          hostname: "192.168.1.10",
          port: 22,
          username: "ops",
          auth: { type: "privateKey", privateKeyPath: "/keys/node1" },
        },
      ],
    };
    const file = path.join(tmpDir, "hosts.json");
    fs.writeFileSync(file, JSON.stringify(registry));
    const loaded = loadHostsFromFile(file);
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0].name).toBe("node-1");
    expect(loaded.hosts[0].port).toBe(22);
  });

  it("loads hosts from YAML file", () => {
    const yaml = `hosts:
  - name: node-2
    hostname: 192.168.1.11
    port: 2222
    username: ops
    auth:
      type: password
      passwordEnv: NODE2_PASSWORD
`;
    const file = path.join(tmpDir, "hosts.yaml");
    fs.writeFileSync(file, yaml);
    const loaded = loadHostsFromFile(file);
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0].name).toBe("node-2");
    expect(loaded.hosts[0].hostname).toBe("192.168.1.11");
    expect(loaded.hosts[0].auth.type).toBe("password");
    expect(loaded.hosts[0].auth.passwordEnv).toBe("NODE2_PASSWORD");
  });

  it("loads hosts from SSH_HOSTS env", () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "node-3", hostname: "10.0.0.3", username: "root", auth: { type: "agent" } }],
    });
    const loaded = loadHostsFromEnv();
    expect(loaded?.hosts).toHaveLength(1);
    expect(loaded?.hosts[0].auth.type).toBe("agent");
  });

  it("loadHostRegistry prefers env over file", () => {
    process.env.SSH_HOSTS = JSON.stringify({
      hosts: [{ name: "env-node", hostname: "10.0.0.1", username: "root", auth: { type: "agent" } }],
    });
    const file = path.join(tmpDir, "hosts.json");
    fs.writeFileSync(file, JSON.stringify({ hosts: [{ name: "file-node", hostname: "10.0.0.2", username: "root", auth: { type: "agent" } }] }));
    process.env.SSH_HOSTS_CONFIG = file;

    const loaded = loadHostRegistry();
    expect(loaded.hosts).toHaveLength(1);
    expect(loaded.hosts[0].name).toBe("env-node");
  });

  it("findHost matches name or hostname", () => {
    const registry: HostRegistry = {
      hosts: [{ name: "node-a", hostname: "10.0.0.1", username: "ops", auth: { type: "agent" } }],
    };
    expect(findHost(registry, "node-a")?.name).toBe("node-a");
    expect(findHost(registry, "10.0.0.1")?.name).toBe("node-a");
    expect(findHost(registry, "missing")).toBeUndefined();
  });

  it("getPrivateKeyContent reads from env var", () => {
    process.env.TEST_SSH_KEY = "ssh-rsa AAAA...";
    expect(getPrivateKeyContent({ type: "privateKey", privateKeyEnv: "TEST_SSH_KEY" })).toBe("ssh-rsa AAAA...");
  });

  it("getPrivateKeyContent reads from file", () => {
    const keyFile = path.join(tmpDir, "id_rsa");
    fs.writeFileSync(keyFile, "ssh-rsa FILEKEY");
    expect(getPrivateKeyContent({ type: "privateKey", privateKeyPath: keyFile })).toBe("ssh-rsa FILEKEY");
  });
});
