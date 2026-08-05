// ============================================================================
// Plan / Remediation 输出解析
// 从 assistant 文本中提取【诊断计划】与【修复方案】结构化块，
// 供 runner 写入 session.plan / session.remediation。
// ============================================================================

import { Remediation, RemediationStep } from "../types.js";

const PLAN_MARKER = "【诊断计划】";
const REMEDIATION_MARKER = "【修复方案】";
const RCA_MARKER = "【根因分析结论】";

function nextMarker(text: string, from: number): number {
  const candidates = [PLAN_MARKER, REMEDIATION_MARKER, RCA_MARKER]
    .map((m) => text.indexOf(m, from))
    .filter((i) => i >= 0);
  if (candidates.length === 0) return text.length;
  return Math.min(...candidates);
}

function cleanStep(line: string): string {
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.、)]\s*/, "")
    .trim();
}

/** 提取【诊断计划】块中的编号/列表步骤，自动去重 */
export function extractPlan(text: string): string[] {
  const idx = text.indexOf(PLAN_MARKER);
  if (idx < 0) return [];
  const section = text.slice(idx + PLAN_MARKER.length, nextMarker(text, idx + PLAN_MARKER.length));
  const steps = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"))
    .filter((line) => /^[-*•]|\d+[.、)]/.test(line))
    .map(cleanStep)
    .filter((line) => line.length > 0);
  return Array.from(new Set(steps));
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  const cleaned = (raw ?? "").trim();
  if (!cleaned) return {};
  try {
    const parsed = JSON.parse(cleaned.startsWith("{") ? cleaned : `{${cleaned}}`);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 提取【修复方案】块并解析为结构化 Remediation；无步骤时返回 null */
export function extractRemediation(text: string): Remediation | null {
  const idx = text.indexOf(REMEDIATION_MARKER);
  if (idx < 0) return null;
  const section = text.slice(idx + REMEDIATION_MARKER.length, nextMarker(text, idx + REMEDIATION_MARKER.length));
  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("```"));

  const steps: RemediationStep[] = [];
  let summary = "";
  for (const line of lines) {
    if (!/^[-*•]|\d+[.、)]/.test(line)) {
      if (/^(摘要|概述)\s*[:：]/.test(line)) {
        summary = line.replace(/^[^:：]*[:：]\s*/, "");
      }
      continue;
    }
    const description = cleanStep(line);
    // 形如 k8s.patch_resource_limits(...) 或 k8s__patch_resource_limits
    const toolMatch = description.match(/([a-z][a-z0-9_]*)[._]{1,2}([a-z][a-z0-9_]*)(?:\(([^)]*)\))?/);
    steps.push({
      description,
      skill: toolMatch ? (toolMatch[1] as RemediationStep["skill"]) : undefined,
      tool: toolMatch ? toolMatch[2] : undefined,
      args: toolMatch ? parseArgs(toolMatch[3]) : {},
      risk: toolMatch ? "high" : "medium",
    });
  }
  if (steps.length === 0) return null;
  return { summary: summary || "Agent 生成的修复方案", steps };
}
