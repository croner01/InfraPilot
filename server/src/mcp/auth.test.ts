import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  signMcpJwt,
  verifyMcpJwt,
  isToolAllowed,
  createServerCredentials,
  createClientCredentials,
} from "./auth.js";

function generateTestCerts(dir: string) {
  const caKey = path.join(dir, "ca.key");
  const caCert = path.join(dir, "ca.crt");
  const clientKey = path.join(dir, "client.key");
  const clientCsr = path.join(dir, "client.csr");
  const clientCert = path.join(dir, "client.crt");

  execSync(`openssl genrsa -out ${caKey} 2048`, { stdio: "ignore" });
  execSync(
    `openssl req -new -x509 -key ${caKey} -out ${caCert} -days 1 -subj "/CN=test-ca"`,
    { stdio: "ignore" }
  );
  execSync(`openssl genrsa -out ${clientKey} 2048`, { stdio: "ignore" });
  execSync(
    `openssl req -new -key ${clientKey} -out ${clientCsr} -subj "/CN=test-client"`,
    { stdio: "ignore" }
  );
  execSync(
    `openssl x509 -req -in ${clientCsr} -CA ${caCert} -CAkey ${caKey} -CAcreateserial -out ${clientCert} -days 1`,
    { stdio: "ignore" }
  );

  return { caCert, clientCert, clientKey };
}

describe("MCP Auth", () => {
  let originalSecret: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    originalSecret = process.env.MCP_JWT_SECRET;
    process.env.MCP_JWT_SECRET = "test-secret-for-auth";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auth-"));
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.MCP_JWT_SECRET;
    else process.env.MCP_JWT_SECRET = originalSecret;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("signs and verifies a JWT with tool scope", () => {
    const token = signMcpJwt({ sessionId: "session-1", tools: ["get_cpu_usage"], expiresInSeconds: 60 });
    const payload = verifyMcpJwt(token);
    expect(payload.sub).toBe("session-1");
    expect(payload.tools).toEqual(["get_cpu_usage"]);
    expect(payload.aud).toBe("linux-mcp-server");
  });

  it("rejects expired tokens", () => {
    const token = signMcpJwt({ sessionId: "session-1", tools: ["get_cpu_usage"], expiresInSeconds: -1 });
    expect(() => verifyMcpJwt(token)).toThrow();
  });

  it("rejects tokens signed with a different secret", () => {
    const token = signMcpJwt({ sessionId: "session-1", tools: ["get_cpu_usage"], expiresInSeconds: 60 });
    process.env.MCP_JWT_SECRET = "different-secret";
    expect(() => verifyMcpJwt(token)).toThrow();
  });

  it("checks tool scope correctly", () => {
    const token = signMcpJwt({ sessionId: "session-1", tools: ["get_cpu_usage", "get_memory_info"] });
    const payload = verifyMcpJwt(token);
    expect(isToolAllowed(payload, "get_cpu_usage")).toBe(true);
    expect(isToolAllowed(payload, "restart_service")).toBe(false);
  });

  it("creates insecure server credentials when TLS config is incomplete", () => {
    const creds = createServerCredentials({});
    expect(creds).toBeDefined();
  });

  it("creates SSL/mTLS server credentials when all TLS files exist", () => {
    const ca = path.join(tmpDir, "ca.crt");
    const cert = path.join(tmpDir, "server.crt");
    const key = path.join(tmpDir, "server.key");
    fs.writeFileSync(ca, "ca-content");
    fs.writeFileSync(cert, "cert-content");
    fs.writeFileSync(key, "key-content");

    const creds = createServerCredentials({ caPath: ca, certPath: cert, keyPath: key });
    expect(creds).toBeDefined();
  });

  it("creates insecure client credentials when TLS files are missing", () => {
    const creds = createClientCredentials({});
    expect(creds).toBeDefined();
  });

  it("creates SSL client credentials when all TLS files exist", () => {
    const { caCert, clientCert, clientKey } = generateTestCerts(tmpDir);

    const creds = createClientCredentials({
      caPath: caCert,
      certPath: clientCert,
      keyPath: clientKey,
    });
    expect(creds).toBeDefined();
  });
});
