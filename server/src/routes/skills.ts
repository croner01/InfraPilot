import { Router } from "express";
import { skillStore } from "../skills/packages/registry.js";
import { installFromGitHub, uninstallSkill, listCuratedSkills } from "../skills/packages/installer.js";

export const skillsRouter = Router();

skillsRouter.get("/", async (_req, res) => {
  try {
    await skillStore.init();
    const skills = skillStore.list().map((s) => ({
      name: s.name,
      description: s.frontmatter.description,
      enabled: s.enabled,
      references: s.references,
      scripts: s.scripts,
      assets: s.assets,
      source: s.source,
      version: s.version,
    }));
    res.json({ skills });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

skillsRouter.get("/curated", (_req, res) => {
  res.json({ skills: listCuratedSkills() });
});

skillsRouter.post("/install", async (req, res) => {
  try {
    const { repo, path, ref, token } = req.body ?? {};
    if (!repo || !path) return res.status(400).json({ error: "repo 与 path 必填" });
    const name = await installFromGitHub({
      repo: String(repo),
      path: String(path),
      ref: ref ? String(ref) : undefined,
      token: token ? String(token) : undefined,
    });
    res.json({ ok: true, name });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

skillsRouter.patch("/:name", async (req, res) => {
  try {
    await skillStore.setEnabled(req.params.name, Boolean(req.body?.enabled));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

skillsRouter.delete("/:name", async (req, res) => {
  try {
    await uninstallSkill(req.params.name);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});
