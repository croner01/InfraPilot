// ============================================================================
// WebSocket Hub — 将 sessionStore 的时间线事件实时推送给前端
// 对应设计文档 §11 "流式输出" 的体验要求
// ============================================================================

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { bus } from "../agent/sessionStore.js";
import { TimelineEvent } from "../types.js";

const clientsBySession = new Map<string, Set<WebSocket>>();

export function attachWsHub(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      ws.close(4000, "sessionId required");
      return;
    }
    if (!clientsBySession.has(sessionId)) clientsBySession.set(sessionId, new Set());
    clientsBySession.get(sessionId)!.add(ws);

    ws.on("close", () => {
      clientsBySession.get(sessionId)?.delete(ws);
    });
  });

  bus.on("event", (event: TimelineEvent) => {
    const clients = clientsBySession.get(event.sessionId);
    if (!clients) return;
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  return wss;
}
