// ============================================================================
// Args Hash — 审批令牌与 tool+args 绑定
//
// 通过 canonical JSON + SHA256 计算命令参数的确定性哈希，用于在 Command Gateway
// 执行前校验：用户批准的命令参数与当前待执行参数是否完全一致，防止 TOCTOU 篡改
// （例如：审批了 A 命令，执行时被替换为 B 命令）。
// ============================================================================

import crypto from "node:crypto";
import type { SkillName } from "../types.js";

/**
 * 将值转换为 key 已排序的确定性结构，确保相同语义的对象产生相同 JSON。
 * - 对象：按 key 字母顺序排序
 * - 数组：保持顺序不变
 * - 其他原始值：直接返回
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/**
 * 计算 skill + tool + args 的 SHA256 哈希，作为审批令牌的绑定指纹。
 */
export function computeArgsHash(skill: SkillName, tool: string, args: Record<string, unknown>): string {
  const canonical = canonicalize(args);
  const payload = `${skill}:${tool}:${JSON.stringify(canonical)}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}
