import { insertAlert, listAlerts } from "../db/db.js";

const demoAlerts = [
  {
    id: "alert-order-api-oom",
    severity: "p0",
    title: "order-api Pod CrashLoopBackOff",
    source: "order-service/order-api · Prometheus",
    service: "order-api",
    status: "firing",
    startedAt: "2026-08-25T10:24:00Z",
  },
  {
    id: "alert-payment-5xx",
    severity: "p1",
    title: "payment-service 5xx 上升",
    source: "pay/payment-service · Prometheus",
    service: "payment-service",
    status: "firing",
    startedAt: "2026-08-25T10:02:00Z",
  },
  {
    id: "alert-node08-disk",
    severity: "p2",
    title: "node-08 磁盘使用率 > 80%",
    source: "k8s-node · node_exporter",
    service: "node-08",
    status: "acknowledged",
    startedAt: "2026-08-25T09:41:00Z",
  },
] as const;

/** 幂等播种：表内已有数据时直接返回现有数量，避免重复插入 */
export function seedAlerts(): number {
  const existing = listAlerts();
  if (existing.length > 0) return existing.length;
  for (const alert of demoAlerts) {
    insertAlert({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      source: alert.source,
      service: alert.service,
      status: alert.status,
      started_at: alert.startedAt,
      session_id: null,
    });
  }
  return demoAlerts.length;
}
