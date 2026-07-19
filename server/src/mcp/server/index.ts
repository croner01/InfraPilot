// ============================================================================
// linux-mcp-server — standalone 入口
// 启动方式：MCP_SERVER_MODE=true npm run dev
// ============================================================================

import * as grpc from "@grpc/grpc-js";
import { proto } from "../protoLoader.js";
import { linuxDiagnosticService } from "./service.js";
import { createServerCredentials, loadServerTlsConfigFromEnv } from "../auth.js";

export function startMcpServer(port = 8443): grpc.Server {
  const server = new grpc.Server();
  server.addService(proto.infrapilot.linux.LinuxDiagnostic.service, linuxDiagnosticService);

  const tlsConfig = loadServerTlsConfigFromEnv();
  const credentials = createServerCredentials(tlsConfig);
  const credLabel = tlsConfig.caPath && tlsConfig.certPath && tlsConfig.keyPath ? "ssl/mtls" : "insecure";

  server.bindAsync(`0.0.0.0:${port}`, credentials, (err, boundPort) => {
    if (err) {
      console.error("[linux-mcp-server] 启动失败:", err.message);
      process.exit(1);
    }
    console.log(`[linux-mcp-server] listening on :${boundPort} (credentials=${credLabel})`);
  });

  return server;
}

// 若直接执行此文件则启动 standalone server
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MCP_SERVER_PORT ?? 8443);
  startMcpServer(port);
}
