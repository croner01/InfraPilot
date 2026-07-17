import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { apiRouter } from "./routes/api.js";
import { attachWsHub } from "./ws/hub.js";
import { orderApiSupervisor } from "./demo/supervisor.js";

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
  // 启动演示故障场景(order-api 内存泄漏 -> OOMKilled -> CrashLoopBackOff)
  orderApiSupervisor.start();
  console.log("[Demo] order-api 演示工作负载已启动(将在约2分钟内触发内存泄漏故障)");
});

process.on("SIGTERM", () => {
  orderApiSupervisor.stop();
  server.close(() => process.exit(0));
});
