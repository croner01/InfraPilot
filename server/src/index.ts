import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { apiRouter } from "./routes/api.js";
import { attachWsHub } from "./ws/hub.js";
import { startLogShipper, stopLogShipper } from "./skills/elk/logShipper.js";

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
