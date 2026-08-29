import { Router } from "express";
import { createSession, emitEvent, getSession, listSessionSummaries, deleteSession, updateSessionTitle } from "../agent/sessionStore.js";
import { startAgentTurn, resumeAgentTurn } from "../agent/orchestrator.js";
import { getRealPodState, resetRealDemoScenario } from "../demo/realPodState.js";
import { isAbnormalPod, listPods, readPod, listEventsForPod, type NormalizedPod } from "../skills/k8s/client.js";
import { listAuditBySession, decideApproval, getApproval, listTimelineEvents, listAlerts } from "../db/db.js";
import { listKnowledgeCases, searchKnowledgeCases, getKnowledgeCase, addKnowledgeCase } from "../skills/knowledge/store.js";
import { executeDrawioTool, type LogRelation } from "../skills/drawio/tools.js";
import { executeElkTool } from "../skills/elk/tools.js";
import {
  initMemoryStore,
  listMemories,
  deleteMemory,
  extractAndStoreSessionMemory,
} from "../agent/memoryStore.js";
import type { KnowledgeCaseInput } from "../types.js";
import { configRouter } from "./config.js";
import { skillsRouter } from "./skills.js";
import { readFileSync } from "fs";
import { resolve, join } from "path";

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

apiRouter.get("/sessions/:id/events", (req, res) => {
  const rows = listTimelineEvents(req.params.id);
  const events = rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    type: r.type,
    timestamp: r.timestamp,
    payload: JSON.parse(r.payload),
  }));
  res.json(events);
});

apiRouter.get("/alerts", (req, res) => {
  try {
    const { status, severity } = req.query;
    const rows = listAlerts({
      status: status ? String(status) : undefined,
      severity: severity ? String(severity) : undefined,
    });
    res.json({
      alerts: rows.map((row) => ({
        id: row.id,
        severity: row.severity,
        title: row.title,
        source: row.source,
        service: row.service,
        status: row.status,
        startedAt: row.started_at,
        sessionId: row.session_id ?? undefined,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.get("/objects/:namespace/:name/logs", async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const { since, level, limit } = req.query;
    const result = await executeElkTool("search_logs", {
      namespace,
      service: name,
      level: level ? String(level) : undefined,
      limit: limit ? Number(limit) : 50,
      since: since ? String(since) : undefined,
    });
    if (!result.success) {
      return res.status(500).json({ error: result.error ?? "日志查询失败" });
    }
    const raw = ((result.data as { logs?: Array<Record<string, unknown>> })?.logs ?? []) as Array<Record<string, unknown>>;
    res.json({
      logs: raw.map((log) => ({
        timestamp: String(log["@timestamp"] ?? ""),
        level: String(log.level ?? "INFO"),
        message: String(log.message ?? ""),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.patch("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "session not found" });
  const { title } = req.body ?? {};
  if (title !== undefined) {
    updateSessionTitle(req.params.id, title);
  }
  res.json({ ok: true, session: getSession(req.params.id) });
});

apiRouter.delete("/sessions/:id", (req, res) => {
  const removed = deleteSession(req.params.id);
  if (!removed) return res.status(404).json({ error: "session not found" });
  res.json({ ok: true });
});

apiRouter.post("/sessions/:id/messages", async (req, res) => {
  const { id } = req.params;
  const { message } = req.body ?? {};
  const session = getSession(id);
  if (!session) return res.status(404).json({ error: "session not found" });
  if (!message) return res.status(400).json({ error: "message required" });

  emitEvent(id, "user_message", { message, role: "user" });
  res.json({ accepted: true });
  startAgentTurn(id, message).catch((err) => {
    console.error("[agent error]", err);
  });
});

apiRouter.post("/approvals/:approvalId/decide", (req, res) => {
  const { approvalId } = req.params;
  const { approved, approvedBy } = req.body ?? {};

  // 将审批决策持久化到数据库（替代原内存 Promise resolver）
  decideApproval(approvalId, approved ? "approved" : "rejected", approvedBy || "demo-user");

  // 从 approval 记录获取 sessionId 以触发恢复
  const approval = getApproval(approvalId);
  if (approval && approval.decision === "approved") {
    resumeAgentTurn(approval.session_id, approvalId).catch((err) => {
      console.error("[resume error]", err);
    });
  }

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

// -------------------- 通用 K8s Pod 上下文(替代固定 demo pod-state) --------------------

apiRouter.get("/k8s/pods", async (req, res) => {
  try {
    const namespace = req.query.namespace as string | undefined;
    const abnormalOnly = req.query.abnormalOnly === "true";
    const pods = await listPods(namespace);
    const filtered = abnormalOnly ? pods.filter(isAbnormalPod) : pods;
    res.json({ pods: filtered });
  } catch (err: any) {
    res.status(500).json({ error: `查询 Pod 列表失败: ${err?.message ?? String(err)}` });
  }
});

apiRouter.get("/k8s/pods/:namespace/:name", async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const [pod, events] = await Promise.all([
      readPod(namespace, name),
      listEventsForPod(namespace, name),
    ]);
    if (!pod) {
      res.status(404).json({ error: "pod not found" });
      return;
    }
    res.json({ pod, events });
  } catch (err: any) {
    res.status(500).json({ error: `查询 Pod 详情失败: ${err?.message ?? String(err)}` });
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

apiRouter.use("/config", configRouter);

// -------------------- Knowledge 案例管理 --------------------

apiRouter.get("/knowledge/cases", async (_req, res) => {
  try {
    const cases = listKnowledgeCases();
    res.json({ cases });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.get("/knowledge/cases/:id", async (req, res) => {
  try {
    const c = getKnowledgeCase(req.params.id);
    if (!c) return res.status(404).json({ error: "case not found" });
    res.json(c);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.get("/knowledge/search", async (req, res) => {
  try {
    const { query, problem_type, service_name, limit } = req.query;
    const results = await searchKnowledgeCases({
      query: String(query || ""),
      problemType: problem_type ? String(problem_type) : undefined,
      serviceName: service_name ? String(service_name) : undefined,
      limit: limit ? Number(limit) : 10,
    });
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.post("/knowledge/cases", async (req, res) => {
  try {
    const body = req.body as KnowledgeCaseInput;
    if (!body?.title || !body?.summary || !body?.rootCauses?.length) {
      return res.status(400).json({ error: "title, summary and rootCauses are required" });
    }
    const c = await addKnowledgeCase(body);
    res.json({ ok: true, case: c });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// -------------------- Skills 工具执行（直接供前端技能页面调用） --------------------

const DIAGRAMS_DIR = resolve(process.cwd(), "data", "diagrams");

function sanitizeDiagramPath(inputPath: string): string {
  // 仅允许在 DIAGRAMS_DIR 内的路径,防止目录遍历
  const normalized = resolve(DIAGRAMS_DIR, inputPath);
  if (!normalized.startsWith(DIAGRAMS_DIR)) {
    throw new Error("非法文件路径");
  }
  return normalized;
}

apiRouter.post("/skills/drawio/generate", async (req, res) => {
  try {
    const { log_relations, title } = req.body ?? {};
    if (!Array.isArray(log_relations) || log_relations.length === 0) {
      return res.status(400).json({ error: "log_relations 不能为空数组" });
    }
    const outputPath = sanitizeDiagramPath(`${Date.now()}-flowchart.drawio`);
    const result = await executeDrawioTool("generate_flowchart", {
      log_relations: log_relations as LogRelation[],
      output_path: outputPath,
      title: title || "日志关系流程图",
    });
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    const xml = readFileSync(outputPath, "utf-8");
    res.json({ ok: true, xml, output_path: outputPath, ...(result.data as object) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.post("/skills/drawio/export", async (req, res) => {
  try {
    const { input_path, format } = req.body ?? {};
    if (!input_path || !format) {
      return res.status(400).json({ error: "input_path 和 format 必填" });
    }
    if (!["png", "svg", "pdf"].includes(format)) {
      return res.status(400).json({ error: "format 必须是 png/svg/pdf 之一" });
    }
    const safeInput = sanitizeDiagramPath(String(input_path));
    const outputPath = safeInput.replace(/\.drawio$/, `.${format}`);
    const result = await executeDrawioTool("export_diagram", {
      input_path: safeInput,
      output_path: outputPath,
      format,
    });
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    const buffer = readFileSync(outputPath);
    res.json({
      ok: true,
      output_path: outputPath,
      format,
      data: buffer.toString("base64"),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.get("/skills/drawio/download", async (req, res) => {
  try {
    const filePath = sanitizeDiagramPath(String(req.query.path ?? ""));
    const buffer = readFileSync(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase();
    const mime =
      ext === "svg" ? "image/svg+xml" :
      ext === "pdf" ? "application/pdf" :
      ext === "drawio" ? "application/xml" :
      "image/png";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filePath.split("/").pop()}"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// -------------------- Cross-Session Memories --------------------

apiRouter.get("/memories", async (_req, res) => {
  try {
    await initMemoryStore();
    res.json({ memories: listMemories() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

apiRouter.delete("/memories/:id", async (req, res) => {
  try {
    deleteMemory(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// -------------------- Skill Packages 管理 --------------------

apiRouter.use("/skills", skillsRouter);
