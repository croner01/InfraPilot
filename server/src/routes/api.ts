import { Router } from "express";
import { createSession, getSession, listSessionSummaries, resolveApprovalDecision } from "../agent/sessionStore.js";
import { runAgentTurn } from "../agent/orchestrator.js";
import { orderApiSupervisor } from "../demo/supervisor.js";
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

// -------------------- Demo 场景控制 --------------------

apiRouter.get("/demo/pod-state", (_req, res) => {
  res.json(orderApiSupervisor.getState());
});

apiRouter.post("/demo/restart-scenario", (_req, res) => {
  orderApiSupervisor.resetScenario(200);
  res.json({ ok: true });
});
