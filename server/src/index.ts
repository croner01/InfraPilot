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
    const [{ apiRouter }, { attachWsHub }, { startLogShipper, stopLogShipper }, { buildRegistry }, { skillStore }] =
      await Promise.all([
        import("./routes/api.js"),
        import("./ws/hub.js"),
        import("./skills/elk/logShipper.js"),
        import("./skills/registry/skillRegistry.js"),
        import("./skills/packages/registry.js"),
      ]);

    // 启动时预构建 Skill Registry（orchestrator 中也会幂等构建，这里提前完成避免首次请求延迟）
    const { ALL_TOOLS } = await import("./gateway/policy.js");
    await buildRegistry(ALL_TOOLS);
    await skillStore.init();

    // 幂等播种 demo 告警（M5：真实 Alertmanager webhook 为二期）
    const { seedAlerts } = await import("./demo/seedAlerts.js");
    const seeded = seedAlerts();
    if (seeded > 0) console.log(`[Alert Seed] ${seeded} alerts ready`);

    // 将 runtime-config.json 中的远程主机同步到 SSH_HOSTS，确保 sshProxy 能读取
    const { syncRuntimeHostsToEnv, syncMcpEnv } = await import("./config/store.js");
    syncRuntimeHostsToEnv();
    syncMcpEnv();

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
      // 启动日志采集管道；具体采集目标由 data/runtime-config.json / LOG_SHIP_TARGETS 决定
      startLogShipper();
    });

    process.on("SIGTERM", () => {
      stopLogShipper();
      server.close(() => process.exit(0));
    });
  })();
}
