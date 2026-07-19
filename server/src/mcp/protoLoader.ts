// ============================================================================
// Proto 加载器
// 处理开发/生产/测试路径差异，使用 @grpc/proto-loader 加载 linux_diagnostic.proto
// ============================================================================

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as protoLoader from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProtoPath(): string {
  if (process.env.MCP_PROTO_PATH) {
    const envPath = path.resolve(process.env.MCP_PROTO_PATH);
    if (fs.existsSync(envPath)) return envPath;
  }

  // 候选路径：开发/生产/测试时可能的位置
  const candidates = [
    // 从 server/src/mcp/protoLoader.ts -> server/proto
    path.resolve(__dirname, "..", "..", "..", "proto", "linux_diagnostic.proto"),
    // 从 dist/mcp/protoLoader.js -> proto（如果 proto 被复制到 dist 同级）
    path.resolve(process.cwd(), "proto", "linux_diagnostic.proto"),
    // 从项目根目录运行测试时
    path.resolve(process.cwd(), "server", "proto", "linux_diagnostic.proto"),
    // 绝对备用
    path.resolve("/root/InfraPilot/server/proto/linux_diagnostic.proto"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    `找不到 linux_diagnostic.proto。已尝试: ${candidates.join(", ")}。可通过 MCP_PROTO_PATH 环境变量指定。`
  );
}

const PROTO_PATH = findProtoPath();

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

export const proto = grpc.loadPackageDefinition(packageDefinition) as any;

export function getLinuxDiagnosticClient(target: string, credentials: grpc.ChannelCredentials): any {
  return new proto.infrapilot.linux.LinuxDiagnostic(target, credentials);
}
