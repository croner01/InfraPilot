import fs from "node:fs";
import path from "node:path";
import type { ToolDef, ToolExecutionResult } from "../../types.js";
import { skillStore } from "./registry.js";

export const skillsTools: ToolDef[] = [
  {
    name: "list_installed",
    skill: "skills",
    risk: "readonly",
    description: "列出当前已安装/启用的技能包（SKILL.md 指令集），包含名称、描述、启停状态与捆绑资源。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_reference",
    skill: "skills",
    risk: "readonly",
    description: "读取已激活技能包 references/ 目录下的参考文档全文，用于按需加载技能细节。",
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "技能名，如 ceph-rbd-108" },
        file: { type: "string", description: "references/ 下的相对文件名，如 pool-blacklist.md" },
      },
      required: ["skill_name", "file"],
      additionalProperties: false,
    },
  },
];

export async function executeSkillsTool(tool: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const start = Date.now();
  switch (tool) {
    case "list_installed": {
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
      return { success: true, data: { skills }, durationMs: Date.now() - start };
    }
    case "read_reference": {
      await skillStore.init();
      const p = skillStore.get(String(args.skill_name));
      if (!p) return { success: false, error: `技能 ${args.skill_name} 未安装`, durationMs: Date.now() - start };
      const rel = String(args.file);
      if (rel.includes("..") || path.isAbsolute(rel)) {
        return { success: false, error: "非法文件路径", durationMs: Date.now() - start };
      }
      const refRoot = path.join(p.dir, "references");
      const full = path.resolve(refRoot, rel);
      if (!full.startsWith(refRoot)) {
        return { success: false, error: "非法文件路径", durationMs: Date.now() - start };
      }
      if (!fs.existsSync(full)) {
        return { success: false, error: `参考文件不存在: ${rel}`, durationMs: Date.now() - start };
      }
      const content = fs.readFileSync(full, "utf8");
      return {
        success: true,
        data: { skill: p.name, file: rel, content: content.slice(0, 20000) },
        durationMs: Date.now() - start,
      };
    }
    default:
      return { success: false, error: `未知 skills 工具: ${tool}`, durationMs: Date.now() - start };
  }
}
