// ============================================================================
// MCP Auth — mTLS + 短期 JWT
//
// 服务端：校验 metadata 中的 Bearer token；可选校验 client certificate。
// 客户端：签发/加载短期 JWT，构造 gRPC credentials。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import jwt from "jsonwebtoken";
import type { McpJwtPayload as McpJwtPayloadType } from "./types.js";

export type McpJwtPayload = McpJwtPayloadType;

const MCP_AUDIENCE = "linux-mcp-server";

function getJwtSecret(): string {
  return process.env.MCP_JWT_SECRET ?? "infrapilot-mcp-dev-secret-do-not-use-in-production";
}

export interface SignJwtOptions {
  sessionId: string;
  tools: string[];
  expiresInSeconds?: number;
}

export function signMcpJwt(opts: SignJwtOptions): string {
  const secret = getJwtSecret();
  const exp = Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 300);
  const payload: McpJwtPayload = {
    sub: opts.sessionId,
    aud: MCP_AUDIENCE,
    tools: opts.tools,
    exp,
    iat: Math.floor(Date.now() / 1000),
  };
  return jwt.sign(payload, secret, { algorithm: "HS256" });
}

export function verifyMcpJwt(token: string): McpJwtPayload {
  const secret = getJwtSecret();
  return jwt.verify(token, secret, { audience: MCP_AUDIENCE, algorithms: ["HS256"] }) as McpJwtPayload;
}

export function isToolAllowed(payload: McpJwtPayload, tool: string): boolean {
  return payload.tools.includes(tool);
}

// ----------------------------------------------------------------------------
// gRPC credentials
// ----------------------------------------------------------------------------

function fileOrUndefined(p: string | undefined): Buffer | undefined {
  if (!p) return undefined;
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) return undefined;
  return fs.readFileSync(abs);
}

export interface TlsConfig {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
}

export function createServerCredentials(tls?: TlsConfig): grpc.ServerCredentials {
  // 生产环境强制 mTLS：提供 ca/cert/key
  if (tls?.caPath && tls.certPath && tls.keyPath) {
    const ca = fs.readFileSync(tls.caPath);
    const cert = fs.readFileSync(tls.certPath);
    const key = fs.readFileSync(tls.keyPath);
    return grpc.ServerCredentials.createSsl(ca, [
      { cert_chain: cert, private_key: key },
    ]);
  }

  // 本地开发：允许不安全连接
  return grpc.ServerCredentials.createInsecure();
}

export function createClientCredentials(tls?: TlsConfig): grpc.ChannelCredentials {
  const ca = fileOrUndefined(tls?.caPath);
  const cert = fileOrUndefined(tls?.certPath);
  const key = fileOrUndefined(tls?.keyPath);

  if (ca && cert && key) {
    return grpc.credentials.createSsl(ca, key, cert);
  }

  // 本地开发：不安全连接
  return grpc.credentials.createInsecure();
}

export function loadTlsConfigFromEnv(prefix = "MCP"): TlsConfig {
  return {
    caPath: process.env[`${prefix}_SERVER_CA_PATH`] || process.env[`${prefix}_CA_PATH`],
    certPath: process.env[`${prefix}_CLIENT_CERT_PATH`] || process.env[`${prefix}_CERT_PATH`],
    keyPath: process.env[`${prefix}_CLIENT_KEY_PATH`] || process.env[`${prefix}_KEY_PATH`],
  };
}

export function loadServerTlsConfigFromEnv(prefix = "MCP"): TlsConfig {
  return {
    caPath: process.env[`${prefix}_SERVER_CA_PATH`] || process.env[`${prefix}_CA_PATH`],
    certPath: process.env[`${prefix}_SERVER_CERT_PATH`] || process.env[`${prefix}_CERT_PATH`],
    keyPath: process.env[`${prefix}_SERVER_KEY_PATH`] || process.env[`${prefix}_KEY_PATH`],
  };
}
