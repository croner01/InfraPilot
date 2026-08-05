# 诊断计划与修复方案输出补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 在诊断会话中真实生成并持久化"诊断计划（plan）"与"修复方案（remediation）"，使前端两个 Tab 不再永远为空。

**Architecture:** 沿用现有"LLM 文本块解析"模式（`rcaMatch` 解析【根因分析结论】）：在 system prompt 增加【诊断计划】【修复方案】输出契约；新增纯函数解析模块 `plan.ts`；runner 在每条 assistant 消息上解析并写入 `session.plan` / `session.remediation`，同时 emit `plan_update` / `remediation_plan` 事件（前端已具备渲染）。

**Tech Stack:** Node.js/TypeScript, Vitest, React 19

---

## 背景（为什么 plan / remediation 为空）

- `session.plan` 只在创建时初始化为 `[]`（`server/src/agent/sessionStore.ts:25`），仓库中没有任何写入点。
- `session.remediation` 从未被赋值；`plan_update` / `remediation_plan` 事件类型在 `server/src/types.ts` 中定义，但从未被 emit。
- system prompt 只要求输出【根因分析结论】文本，没有要求输出结构化计划/修复块，LLM 因此不会生成可解析内容。
- 前端（`web/src/components/SessionDetailTabs.tsx`、`web/src/App.tsx` EventCard）已具备 plan/remediation 渲染与事件卡片，属于"有界面无数据"。
- 结论：这是设计断点——状态机规划节点与修复方案输出在 MVP 中未落地，而非新会话串数据（后端隔离实测正常）。

---

### Task 1: 新增 plan/remediation 解析模块（TDD）

**Files:**
- Create: `server/src/agent/plan.ts`
- Test: `server/src/agent/plan.test.ts`

- [ ] **Step 1: 编写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { extractPlan, extractRemediation } from "./plan.js";

describe("extractPlan", () => {
  it("returns empty when no plan marker", () => {
    expect(extractPlan("直接回答")).toEqual([]);
  });

  it("extracts numbered steps from plan block", () => {
    const text = "【诊断计划】\n1. 查看 Pod 状态\n2. 检索错误日志\n然后开始排查";
    expect(extractPlan(text)).toEqual(["查看 Pod 状态", "检索错误日志"]);
  });

  it("extracts bullet steps and stops at next marker", () => {
    const text = "【诊断计划】\n- 查看 Pod\n- 检索日志\n【根因分析结论】内存不足";
    expect(extractPlan(text)).toEqual(["查看 Pod", "检索日志"]);
  });

  it("deduplicates repeated steps", () => {
    expect(extractPlan("【诊断计划】\n1. 查看 Pod\n1. 查看 Pod")).toEqual(["查看 Pod"]);
  });
});

describe("extractRemediation", () => {
  it("returns null without marker", () => {
    expect(extractRemediation("无方案")).toBeNull();
  });

  it("parses steps with tool name", () => {
    const text =
      "【修复方案】\n1. 调整内存 limit: k8s.patch_resource_limits(namespace=order-service, deployment_name=order-api, container_name=order-api, memory_limit_mi=512)";
    const r = extractRemediation(text);
    expect(r?.steps).toHaveLength(1);
    expect(r?.steps[0].skill).toBe("k8s");
    expect(r?.steps[0].tool).toBe("patch_resource_limits");
  });

  it("parses plain steps without tool", () => {
    const r = extractRemediation("【修复方案】\n1. 重启服务");
    expect(r?.steps[0].skill).toBeUndefined();
    expect(r?.steps[0].tool).toBeUndefined();
  });

  it("returns null when block has no steps", () => {
    expect(extractRemediation("【修复方案】\n摘要: 无")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && npx vitest run src/agent/plan.test.ts
```

Expected: FAIL，`Cannot find module './plan.js'`。

- [ ] **Step 3: 实现 `server/src/agent/plan.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && npx vitest run src/agent/plan.test.ts
```

Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add server/src/agent/plan.ts server/src/agent/plan.test.ts
git commit -m "feat(agent): add plan/remediation text extraction with tests"
```

---

### Task 2: runner 集成（写入 session 状态 + 事件）

**Files:**
- Modify: `server/src/agent/runner.ts`
- Modify: `server/src/agent/runner.test.ts`

- [ ] **Step 1: 编写失败测试（追加到 `server/src/agent/runner.test.ts` 的 `describe("agent runner")` 内）**

```ts
it("populates plan and remediation from assistant content", async () => {
  const sessionId = "s1";
  const session = makeSession(sessionId);
  sessions.set(sessionId, session);

  (openai.chat.completions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "【诊断计划】\n1. 查看 Pod 状态\n2. 检索错误日志\n【修复方案】\n1. 调整内存 limit: k8s.patch_resource_limits",
        },
      },
    ],
  });

  const cp = await createInitialCheckpoint(sessionId, "pod 重启");
  const { done } = await runAgentStep(sessionId, cp);

  expect(done).toBe(true);
  expect(session.plan).toEqual(["查看 Pod 状态", "检索错误日志"]);
  expect(session.remediation?.steps).toHaveLength(1);
  expect(session.remediation?.steps[0].skill).toBe("k8s");
  expect(session.remediation?.steps[0].tool).toBe("patch_resource_limits");
  expect(emitEvent).toHaveBeenCalledWith(
    sessionId,
    "plan_update",
    expect.objectContaining({ plan: ["查看 Pod 状态", "检索错误日志"] })
  );
  expect(emitEvent).toHaveBeenCalledWith(sessionId, "remediation_plan", expect.objectContaining({ steps: expect.any(Array) }));
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && npx vitest run src/agent/runner.test.ts
```

Expected: FAIL，`session.plan` 仍为 `[]`（runner 未解析）。

- [ ] **Step 3: 修改 `server/src/agent/runner.ts`**

导入：

```ts
import { extractPlan, extractRemediation } from "./plan.js";
```

在 `msg.content` 处理处插入（位于 `emitEvent(sessionId, "assistant_message", ...)` 之后、`rcaMatch` 之前）：

```ts
      // 结构化输出：诊断计划 / 修复方案
      const plan = extractPlan(msg.content);
      if (plan.length > 0) {
        updateSession(sessionId, (s) => {
          s.plan = plan;
        });
        emitEvent(sessionId, "plan_update", { plan });
      }

      const remediation = extractRemediation(msg.content);
      if (remediation) {
        updateSession(sessionId, (s) => {
          s.remediation = remediation;
        });
        emitEvent(sessionId, "remediation_plan", { summary: remediation.summary, steps: remediation.steps });
      }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && npx vitest run src/agent/runner.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/agent/runner.ts server/src/agent/runner.test.ts
git commit -m "feat(agent): persist plan and remediation into session state"
```

---

### Task 3: system prompt 输出契约

**Files:**
- Modify: `server/src/agent/prompts.ts`

- [ ] **Step 1: 在"# 输出要求"小节追加两条约束**

```text
- 在开始调用诊断工具前,先输出一段以 "【诊断计划】" 开头的计划,每行一条编号步骤,列出接下来要执行的诊断动作。
- 当结论包含修复建议时,在【根因分析结论】之后输出以 "【修复方案】" 开头的方案,每行一条编号步骤;
  若某步骤对应具体工具,在描述中注明工具名与参数,格式如 k8s.patch_resource_limits(namespace=order-service, deployment_name=order-api, container_name=order-api, memory_limit_mi=512)。
```

- [ ] **Step 2: 验证 prompt 生成不报错**

```bash
cd server && npx tsx -e "import { buildSystemPrompt } from './src/agent/prompts.js'; console.log(buildSystemPrompt('- test').includes('【诊断计划】'));"
```

Expected: `true`。

- [ ] **Step 3: 提交**

```bash
git add server/src/agent/prompts.ts
git commit -m "feat(prompts): add plan and remediation output contract"
```

---

### Task 4: 类型放宽 + 前端渲染 guard

**Files:**
- Modify: `server/src/types.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/SessionDetailTabs.tsx`

- [ ] **Step 1: 放宽 `server/src/types.ts` 的 `RemediationStep`**

```ts
export interface RemediationStep {
  description: string;
  /** 可选：LLM 输出中检测到的工具名（如 k8s.patch_resource_limits） */
  skill?: SkillName;
  tool?: string;
  args?: Record<string, unknown>;
  risk?: RiskLevel;
  rollback?: string;
}
```

- [ ] **Step 2: 同步 `web/src/lib/types.ts`**

```ts
export interface RemediationStep {
  description: string;
  skill?: string;
  tool?: string;
  args?: Record<string, unknown>;
  risk?: RiskLevel;
  rollback?: string;
}
```

- [ ] **Step 3: `web/src/components/SessionDetailTabs.tsx` 渲染 guard**

把 `RemediationTab` 中：

```tsx
<span className={`risk-badge risk-badge--${step.risk}`}>{step.risk}</span>
<div className="remediation-step__tool">
  {step.skill}.{step.tool}()
</div>
{Object.keys(step.args).length > 0 && (
  <pre className="remediation-step__args">{JSON.stringify(step.args, null, 2)}</pre>
)}
```

替换为：

```tsx
{step.risk ? (
  <span className={`risk-badge risk-badge--${step.risk}`}>{step.risk}</span>
) : null}
{step.skill && step.tool ? (
  <div className="remediation-step__tool">{step.skill}.{step.tool}()</div>
) : null}
{step.args && Object.keys(step.args).length > 0 && (
  <pre className="remediation-step__args">{JSON.stringify(step.args, null, 2)}</pre>
)}
```

- [ ] **Step 4: 构建验证**

```bash
cd server && npm run build && cd ../web && npm run build
```

Expected: 两个 build 均成功。

- [ ] **Step 5: 提交**

```bash
git add server/src/types.ts web/src/lib/types.ts web/src/components/SessionDetailTabs.tsx
git commit -m "refactor(ui): make remediation step tool fields optional"
```

---

### Task 5: 全量验证

**Files:** 无新增。

- [ ] **Step 1: 运行后端全量测试**

```bash
cd server && npm test
```

Expected: 新增用例全部通过；仅有的失败仍为沙箱端口绑定的 `mcp/server/service.test.ts`（与本次改动无关）。

- [ ] **Step 2: 运行前端构建**

```bash
cd web && npm run build
```

Expected: `tsc -b && vite build` 成功。

- [ ] **Step 3: 手动冒烟（可选，需后端运行）**

```bash
curl -sS -X POST http://127.0.0.1:8787/api/sessions -H 'Content-Type: application/json' -d '{"title":"smoke"}'
# 发送一条诊断消息后查询会话状态，确认 plan / remediation 非空
curl -sS http://127.0.0.1:8787/api/sessions/<sessionId>
```

Expected: `plan` 为步骤数组，`remediation` 含 `steps`。

- [ ] **Step 4: 收尾提交（如手动冒烟有额外改动）**

```bash
git add -A && git commit -m "chore: verify plan/remediation output end to end"
```

