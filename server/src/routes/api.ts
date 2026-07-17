import { Router } from "express";
import { createSession, getSession, listSessionSummaries, resolveApprovalDecision } from "../agent/sessionStore.js";
import { runAgentTurn } from "../agent/orchestrator.js";
import { getRealPodState, resetRealDemoScenario } from "../demo/realPodState.js";
import { listAuditBySession } from "../db/db.js";

export const apiRouter = Router();

apiRouter.get("/sessions", (_req, res) => {
  res.json(listSessionSummaries());
});

apiRouter.post("/sessions", (req, res) => {
  const title = req.body?.title || "新的故障排查会话";
  const session = createSession(title);
  res.json(session);
});

apiRouter.get("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  res.json(session);
});

apiRouter.get("/sessions/:id/audit", (req, res) => {
  res.json(listAuditBySession(req.params.id));
});

apiRouter.post("/sessions/:id/messages", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body ?? {};
  const session = getSession(id);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!message) return res.status(400).json({ error: "message required" });

  res.json({ accepted: true });
  runAgentTurn(id, message).catch((err) => {
    console.error("[agent error]", err);
  });
});

apiRouter.post("/approvals/:approvalId/decide", (req, res) => {
  const { approvalId } = req.params;
  const { approved, approvedBy } = req.body ?? {};
  const ok = resolveApprovalDecision(approvalId, { approved: !!approved, approvedBy: approvedBy || "demo-user" });
  if (!ok) return res.status(404).json({ error: "no pending approval with this id (可能已处理或已过期)" });
  res.json({ ok: true });
});

// -------------------- Demo 场景控制(真实K8s集群) --------------------

apiRouter.get("/demo/pod-state", async (_req, res) => {
  try {
    const state = await getRealPodState();
    res.json(state ?? { podName: "order-api", namespace: "order-service", status: "NotFound", restartCount: 0, resources: { limitsMemoryMb: 0 }, events: [], currentRssMb: 0 });
  } catch (err: any) {
    res.status(500).json({ error: `查询真实K8s集群失败: ${err?.message ?? String(err)}` });
  }
});

apiRouter.post("/demo/restart-scenario", async (_req, res) => {
  try {
    await resetRealDemoScenario(200);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `重置真实K8s场景失败: ${err?.message ?? String(err)}` });
  }
});
