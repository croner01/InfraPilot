import express from "express";
import cors from "cors";
import { createServer } from "node:http";

// ============================================================================
// Phase 2: standalone linux-mcp-server 模式
// 设置 MCP_SERVER_MODE=true 时，本进程只启动 gRPC MCP Server，不加载 HTTP 服务
// 相关模块（避免拉取 LLM/OpenAI 等依赖），实现轻量级 Agent 进程。
// ============================================================================
if (process.env.MCP_SERVER_MODE === "true") {
  const mcpPort = Number(process.env.MCP_SERVER_PORT ?? 8443);

  (async () => {
    const { startMcpServer } = await import("./mcp/server/index.js");
    const mcpServer = startMcpServer(mcpPort);
    process.on("SIGTERM", () => {
      mcpServer.tryShutdown(() => process.exit(0));
    });
  })();
} else {
  (async () => {
    const [{ apiRouter }, { attachWsHub }, { startLogShipper, stopLogShipper }, { buildRegistry }] =
      await Promise.all([
        import("./routes/api.js"),
        import("./ws/hub.js"),
        import("./skills/elk/logShipper.js"),
        import("./skills/registry/skillRegistry.js"),
      ]);

    // 启动时预构建 Skill Registry（orchestrator 中也会幂等构建，这里提前完成避免首次请求延迟）
    const { ALL_TOOLS } = await import("./gateway/policy.js");
    await buildRegistry(ALL_TOOLS);

    // 启动时自动恢复所有 awaiting_approval 会话
    const { listAwaitingApprovalSessions } = await import("./db/db.js");
    const { resumeAgentTurn } = await import("./agent/orchestrator.js");
    const awaitingSessions = listAwaitingApprovalSessions();
    for (const s of awaitingSessions) {
      console.log(`[Checkpoint Recovery] resuming session ${s.id} (${s.title})`);
      resumeAgentTurn(s.id).catch((err) => {
        console.error(`[resume error] session ${s.id}:`, err);
      });
    }

    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get("/health", (_req, res) => res.json({ ok: true, service: "infrapilot-server" }));
    app.use("/api", apiRouter);

    const PORT = Number(process.env.PORT ?? 8787);
    const server = createServer(app);
    attachWsHub(server);

    server.listen(PORT, () => {
      console.log(`[InfraPilot Server] listening on :${PORT}`);
      // order-api 演示工作负载已部署为真实K8s Deployment(见 server/k8s-manifests/),
      // 这里只需启动日志采集管道(真实Pod日志 -> 真实OpenSearch)
      startLogShipper();
      console.log("[LogShipper] order-api 真实Pod日志采集管道已启动 -> OpenSearch order-api-logs-*");
    });

    process.on("SIGTERM", () => {
      stopLogShipper();
      server.close(() => process.exit(0));
    });
  })();
}
