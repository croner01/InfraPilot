// ============================================================================
// Configuration API — ELK 日志系统与远程主机配置
// ============================================================================

import { Router } from "express";
import { getElkConfig, setElkConfig, getHostRegistry, setHosts } from "../config/store.js";
import type { HostEntry } from "../gateway/sshHosts.js";
import type { ShipTarget } from "../skills/elk/logShipper.js";

export const configRouter = Router();

// -------------------- ELK 配置 --------------------

configRouter.get("/elk", (_req, res) => {
  res.json(getElkConfig());
});

configRouter.put("/elk", (req, res) => {
  const { node, targets } = req.body ?? {};
  if (targets !== undefined && !Array.isArray(targets)) {
    res.status(400).json({ error: "targets must be an array" });
    return;
  }
  setElkConfig({ node, targets });
  res.json({ ok: true, config: getElkConfig() });
});

configRouter.post("/elk/targets", (req, res) => {
  const target = req.body as ShipTarget;
  if (!target?.namespace || !target?.podNamePrefix || !target?.indexPrefix) {
    res.status(400).json({ error: "namespace, podNamePrefix and indexPrefix are required" });
    return;
  }
  const current = getElkConfig();
  const targets = [...current.targets, target];
  setElkConfig({ targets });
  res.json({ ok: true, targets });
});

// -------------------- 远程主机配置 --------------------

configRouter.get("/hosts", (_req, res) => {
  res.json(getHostRegistry());
});

configRouter.put("/hosts", (req, res) => {
  const { hosts } = req.body ?? {};
  if (!Array.isArray(hosts)) {
    res.status(400).json({ error: "hosts must be an array" });
    return;
  }
  setHosts(hosts as HostEntry[]);
  res.json({ ok: true, hosts });
});

configRouter.post("/hosts", (req, res) => {
  const entry = req.body as HostEntry;
  if (!entry?.name || !entry?.hostname || !entry?.username || !entry?.auth?.type) {
    res.status(400).json({ error: "name, hostname, username and auth.type are required" });
    return;
  }
  const current = getHostRegistry();
  const filtered = current.hosts.filter((h) => h.name !== entry.name);
  filtered.push({ ...entry, port: entry.port ?? 22 });
  setHosts(filtered);
  res.json({ ok: true, hosts: filtered });
});

configRouter.delete("/hosts/:name", (req, res) => {
  const { name } = req.params;
  const current = getHostRegistry();
  const filtered = current.hosts.filter((h) => h.name !== name);
  if (filtered.length === current.hosts.length) {
    res.status(404).json({ error: "host not found" });
    return;
  }
  setHosts(filtered);
  res.json({ ok: true, hosts: filtered });
});
