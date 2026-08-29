# InfraPilot 前端改版 M7（推理树 Hypothesis）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立"假设 → 验证 → 排除/确认"的推理树能力：后端新增 Hypothesis 数据模型、`【假设列表】` 结构化输出契约与合并逻辑、`hypothesis_update` 事件；前端新增 HypothesisTree 组件并在右栏"调查过程"Tab 渲染真实假设数据。

**Architecture:** 后端在 `types.ts` 增加 `Hypothesis`，`plan.ts` 新增 `extractHypotheses` 解析 `【假设列表】`（行格式 `- [active|confirmed|ruled_out] 描述`），`agent/hypotheses.ts` 提供 `mergeHypotheses`（按 statement 合并/更新），runner 在 assistant 文本处理中合并并 emit `hypothesis_update`，prompts 增加输出要求；前端新增 `panels/HypothesisTree.tsx`，App 右栏调查过程 Tab 接入，Conversation 跳过 `hypothesis_update` 事件。

**Tech Stack:** 后端 Express + Vitest；前端 React 19 + Vitest。

**前置依赖：** M1-M6 已完成。

**执行前注意：**
- 工作目录分别为 `.worktrees/frontend-redesign-m1/server` 与 `.worktrees/frontend-redesign-m1/web`。
- 代码编辑通过 apply_patch 写入 `.worktrees/frontend-redesign-m1/` 路径。
- 提交命令单独执行（不要与测试命令用 `&&` 串联）。
- 本里程碑建立假设的**结构化契约与展示**；模型稳定输出假设列表属于提示词调优，测试以解析器/合并器单元测试为准。

---

### Task 1: 后端 Hypothesis 类型与默认值（TDD）

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/agent/sessionStore.ts`
- Create: `server/src/agent/sessionStore.test.ts`

- [ ] **Step 1: 写失败测试**

Create `server/src/agent/sessionStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSession } from "./sessionStore.js";
import { db } from "../db/db.js";

describe("createSession", () => {
  it("initializes empty hypotheses list", () => {
    const session = createSession("test-hypotheses");
    expect(session.hypotheses).toEqual([]);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/agent/sessionStore.test.ts`

Expected: FAIL（`session.hypotheses` 不存在 / 类型错误）。

- [ ] **Step 3: 添加 Hypothesis 类型**

`server/src/types.ts` 的 `TimelineEventType` 联合类型中、`"skills_activated"` 之后追加：

```ts
  | "hypothesis_update"
```

`AgentSession` 接口（`activeSkills?: string[];` 之后）追加：

```ts
  hypotheses: Hypothesis[];
```

在 `RootCause` 接口附近新增：

```ts
export type HypothesisStatus = "active" | "confirmed" | "ruled_out";

export interface Hypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  evidenceIds: string[];
  toolCallIds: string[];
  updatedAt: string;
}
```

- [ ] **Step 4: sessionStore 默认值**

`server/src/agent/sessionStore.ts` 的 `createSession` 中、`activeSkills: [],` 之后追加：

```ts
    hypotheses: [],
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/agent/sessionStore.test.ts`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 6: 同步既有测试 fixture**

以下文件中的 `AgentSession` 字面量（含 `maxIterations: ...` 处）追加 `hypotheses: []`：
- `server/src/agent/memoryStore.test.ts`（2 处）
- `server/src/agent/checkpoint.test.ts`（2 处）
- `server/src/agent/runner.test.ts`（`makeSession`）
- `server/src/agent/runner.skills.test.ts`（`sessionForSkills`）
- `server/src/agent/orchestrator.test.ts`（`makeSession`）
- `server/src/agent/orchestrator.skills.test.ts`（`makeSession`）

示例（memoryStore.test.ts）：

```ts
    plan: [],
    evidence: [],
    hypotheses: [],
```

修改后运行：

Run: `npx vitest run src/agent/memoryStore.test.ts src/agent/checkpoint.test.ts`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/agent/sessionStore.ts src/agent/sessionStore.test.ts
git add src/agent/memoryStore.test.ts src/agent/checkpoint.test.ts
git commit -m "feat(server): add hypothesis model and session default"
```

---

### Task 2: 【假设列表】解析器（TDD）

**Files:**
- Modify: `server/src/agent/plan.ts`
- Modify: `server/src/agent/plan.test.ts`

- [ ] **Step 1: 写失败测试**

`server/src/agent/plan.test.ts` 末尾追加：

```ts
describe("extractHypotheses", () => {
  it("parses hypothesis list with statuses", () => {
    const text = [
      "【假设列表】",
      "- [active] 内存 limit 不足导致 OOM",
      "- [ruled_out] 节点资源不足",
    ].join("\n");
    expect(extractHypotheses(text)).toEqual([
      { statement: "内存 limit 不足导致 OOM", status: "active" },
      { statement: "节点资源不足", status: "ruled_out" },
    ]);
  });

  it("returns empty when no marker", () => {
    expect(extractHypotheses("无假设")).toEqual([]);
  });

  it("stops at the next marker", () => {
    const text = "【假设列表】\n- [active] A\n【根因分析结论】\nxxx";
    expect(extractHypotheses(text)).toEqual([{ statement: "A", status: "active" }]);
  });
});
```

并在文件顶部 import 增加 `extractHypotheses`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/agent/plan.test.ts`

Expected: FAIL（`extractHypotheses` 未定义）。

- [ ] **Step 3: 实现解析器**

`server/src/agent/plan.ts` 修改：
- 常量区新增：

```ts
const HYPOTHESIS_MARKER = "【假设列表】";
```

- `nextMarker` 的候选数组改为：

```ts
const candidates = [PLAN_MARKER, REMEDIATION_MARKER, RCA_MARKER, HYPOTHESIS_MARKER]
```

- 文件末尾新增：

```ts
export interface HypothesisInput {
  statement: string;
  status: "active" | "confirmed" | "ruled_out";
}

/** 提取【假设列表】块，每行格式 "- [active|confirmed|ruled_out] 假设描述" */
export function extractHypotheses(text: string): HypothesisInput[] {
  const idx = text.indexOf(HYPOTHESIS_MARKER);
  if (idx < 0) return [];
  const section = text.slice(idx + HYPOTHESIS_MARKER.length, nextMarker(text, idx + HYPOTHESIS_MARKER.length));
  const result: HypothesisInput[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^[-*•]\s*\[(active|confirmed|ruled_out)\]\s*(.+)$/);
    if (!match) continue;
    const statement = match[2].trim();
    if (statement) {
      result.push({ statement, status: match[1] as HypothesisInput["status"] });
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/agent/plan.test.ts`

Expected: PASS（含 3 个新测试）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/plan.ts src/agent/plan.test.ts
git commit -m "feat(server): parse structured hypothesis list from assistant output"
```

---

### Task 3: 假设合并器 + runner 接线（TDD）

**Files:**
- Create: `server/src/agent/hypotheses.ts`
- Create: `server/src/agent/hypotheses.test.ts`
- Modify: `server/src/agent/runner.ts`
- Modify: `server/src/agent/prompts.ts`

- [ ] **Step 1: 写失败测试**

Create `server/src/agent/hypotheses.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeHypotheses } from "./hypotheses.js";
import type { Hypothesis } from "../types.js";

describe("mergeHypotheses", () => {
  it("appends new hypotheses and updates existing by statement", () => {
    const existing: Hypothesis[] = [
      { id: "h1", statement: "A", status: "active", evidenceIds: [], toolCallIds: [], updatedAt: "t0" },
    ];
    const merged = mergeHypotheses(existing, [
      { statement: "A", status: "confirmed" },
      { statement: "B", status: "ruled_out" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((h) => h.statement === "A")?.status).toBe("confirmed");
    expect(merged.find((h) => h.statement === "B")?.status).toBe("ruled_out");
    // 不修改原数组
    expect(existing[0].status).toBe("active");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/agent/hypotheses.test.ts`

Expected: FAIL，错误为 `Cannot find module './hypotheses.js'`。

- [ ] **Step 3: 实现合并器**

Create `server/src/agent/hypotheses.ts`:

```ts
import { v4 as uuidv4 } from "uuid";
import type { Hypothesis } from "../types.js";

export interface HypothesisInput {
  statement: string;
  status: Hypothesis["status"];
}

/** 按 statement 合并假设：同文本更新状态，新文本追加；返回新数组不修改入参 */
export function mergeHypotheses(existing: Hypothesis[], incoming: HypothesisInput[]): Hypothesis[] {
  const result = existing.map((h) => ({ ...h }));
  for (const item of incoming) {
    const found = result.find((h) => h.statement === item.statement);
    if (found) {
      found.status = item.status;
      found.updatedAt = new Date().toISOString();
    } else {
      result.push({
        id: `hyp-${uuidv4()}`,
        statement: item.statement,
        status: item.status,
        evidenceIds: [],
        toolCallIds: [],
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/agent/hypotheses.test.ts`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: runner 接线**

`server/src/agent/runner.ts` 的 import 修改：

```ts
import { extractPlan, extractRemediation, extractHypotheses } from "./plan.js";
import { mergeHypotheses } from "./hypotheses.js";
```

`processAssistantContent` 中、`plan_update` 处理之后追加：

```ts
  const hypotheses = extractHypotheses(content);
  if (hypotheses.length > 0) {
    updateSession(sessionId, (s) => {
      s.hypotheses = mergeHypotheses(s.hypotheses ?? [], hypotheses);
    });
    const updated = getSession(sessionId);
    emitEvent(sessionId, "hypothesis_update", { hypotheses: updated?.hypotheses ?? [] });
  }
```

- [ ] **Step 6: prompts 增加输出要求**

`server/src/agent/prompts.ts` 的"# 输出要求"段落、`【诊断计划】` 一行之后追加：

```text
- 分析过程中形成假设时,输出以 "【假设列表】" 开头的列表,每行一条,格式 "- [active|confirmed|ruled_out] 假设描述";
  结论输出前请更新各假设状态(active=待验证, confirmed=已确认, ruled_out=已排除)。
```

- [ ] **Step 7: Commit**

```bash
git add src/agent/hypotheses.ts src/agent/hypotheses.test.ts src/agent/runner.ts src/agent/prompts.ts
git commit -m "feat(server): merge hypotheses and emit hypothesis_update"
```

---

### Task 4: 前端 Hypothesis 类型

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/components/conversation/Conversation.tsx`

- [ ] **Step 1: 添加前端类型**

`web/src/lib/types.ts` 末尾新增：

```ts
export type HypothesisStatus = 'active' | 'confirmed' | 'ruled_out';

export interface Hypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  evidenceIds: string[];
  toolCallIds: string[];
  updatedAt: string;
}
```

`AgentSession` 接口（`maxIterations: number;` 之后）追加：

```ts
  hypotheses?: Hypothesis[];
```

- [ ] **Step 2: Conversation 跳过 hypothesis_update 事件**

`web/src/components/conversation/Conversation.tsx` 的 `SKIP_TYPES` 改为：

```ts
const SKIP_TYPES = new Set(['checkpoint_saved', 'runner_resumed', 'hypothesis_update'])
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/components/conversation/Conversation.tsx
git commit -m "feat(web): add hypothesis types and skip update events"
```

---

### Task 5: HypothesisTree 组件（TDD）

**Files:**
- Test: `web/src/components/panels/HypothesisTree.test.tsx`
- Create: `web/src/components/panels/HypothesisTree.tsx`
- Create: `web/src/components/panels/hypothesis-tree.css`
- Create: `web/src/components/panels/HypothesisTree.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/panels/HypothesisTree.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HypothesisTree } from './HypothesisTree.js'
import type { Hypothesis } from '../../lib/types.js'

const hypotheses: Hypothesis[] = [
  { id: 'h1', statement: '内存 limit 不足导致 OOM', status: 'confirmed', evidenceIds: ['ev1'], toolCallIds: [], updatedAt: '2026-08-25T10:30:00Z' },
  { id: 'h2', statement: '节点资源不足', status: 'ruled_out', evidenceIds: [], toolCallIds: [], updatedAt: '2026-08-25T10:31:00Z' },
  { id: 'h3', statement: '镜像拉取失败', status: 'active', evidenceIds: [], toolCallIds: [], updatedAt: '2026-08-25T10:29:00Z' },
]

describe('HypothesisTree', () => {
  it('renders hypotheses with status labels', () => {
    render(<HypothesisTree hypotheses={hypotheses} />)
    expect(screen.getByText('内存 limit 不足导致 OOM')).toBeInTheDocument()
    expect(screen.getByText('已确认')).toBeInTheDocument()
    expect(screen.getByText('已排除')).toBeInTheDocument()
    expect(screen.getByText('待验证')).toBeInTheDocument()
  })

  it('renders empty state', () => {
    render(<HypothesisTree hypotheses={[]} />)
    expect(screen.getByText(/暂无假设/)).toBeInTheDocument()
  })

  it('fires citation click with evidence id', async () => {
    const onCitationClick = vi.fn()
    const user = userEvent.setup()
    render(<HypothesisTree hypotheses={hypotheses} onCitationClick={onCitationClick} />)
    await user.click(screen.getByRole('button', { name: /证据 ev1/ }))
    expect(onCitationClick).toHaveBeenCalledWith('ev1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/panels/HypothesisTree.test.tsx`

Expected: FAIL，错误为 `Cannot find module './HypothesisTree.js'`。

- [ ] **Step 3: 实现 HypothesisTree**

Create `web/src/components/panels/HypothesisTree.tsx`:

```tsx
import { EvidenceCitation } from '../conclusion/EvidenceCitation.js'
import type { Hypothesis } from '../../lib/types.js'
import './hypothesis-tree.css'

interface HypothesisTreeProps {
  hypotheses: Hypothesis[]
  onCitationClick?: (evidenceId: string) => void
}

const statusMeta = {
  active: { label: '待验证', tone: 'active' },
  confirmed: { label: '已确认', tone: 'confirmed' },
  ruled_out: { label: '已排除', tone: 'ruled' },
} as const

export function HypothesisTree({ hypotheses, onCitationClick }: HypothesisTreeProps) {
  if (hypotheses.length === 0) {
    return <p className="hypothesis-tree__empty">暂无假设，Agent 分析后将在此展示推理过程</p>
  }
  return (
    <div className="hypothesis-tree">
      {hypotheses.map((hypothesis, index) => {
        const meta = statusMeta[hypothesis.status] ?? statusMeta.active
        return (
          <div key={hypothesis.id} className={`hypothesis-card hypothesis-card--${meta.tone}`}>
            <div className="hypothesis-card__head">
              <span className={`hypothesis-card__status hypothesis-card__status--${meta.tone}`}>{meta.label}</span>
              <span className="hypothesis-card__idx">H{index + 1}</span>
            </div>
            <p className="hypothesis-card__text">{hypothesis.statement}</p>
            {hypothesis.evidenceIds.length > 0 && onCitationClick && (
              <div className="hypothesis-card__refs">
                {hypothesis.evidenceIds.map((id) => (
                  <EvidenceCitation key={id} label={`证据 ${id}`} onClick={() => onCitationClick(id)} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

Create `web/src/components/panels/hypothesis-tree.css`:

```css
.hypothesis-tree {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hypothesis-tree__empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
.hypothesis-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  background: var(--panel);
}
.hypothesis-card--confirmed {
  border-left: 3px solid var(--success);
}
.hypothesis-card--ruled {
  border-left: 3px solid var(--border-strong);
  opacity: 0.72;
}
.hypothesis-card--active {
  border-left: 3px solid var(--warn);
}
.hypothesis-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.hypothesis-card__status {
  font-size: 11.5px;
  font-weight: 600;
}
.hypothesis-card__status--confirmed {
  color: var(--success);
}
.hypothesis-card__status--ruled {
  color: var(--text-3);
}
.hypothesis-card__status--active {
  color: var(--warn);
}
.hypothesis-card__idx {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
}
.hypothesis-card__text {
  font-size: 13.5px;
  line-height: 1.6;
}
.hypothesis-card__refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/panels/HypothesisTree.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/panels/HypothesisTree.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { HypothesisTree } from './HypothesisTree.js'

const meta: Meta<typeof HypothesisTree> = {
  title: 'panels/HypothesisTree',
  component: HypothesisTree,
}
export default meta
type Story = StoryObj<typeof HypothesisTree>

export const Default: Story = {
  args: {
    hypotheses: [
      { id: 'h1', statement: '内存 limit 256Mi 过低，高峰流量触发 OOMKilled', status: 'confirmed', evidenceIds: ['ev1', 'ev2'], toolCallIds: [], updatedAt: '2026-08-25T10:30:00Z' },
      { id: 'h2', statement: '节点 node-08 资源不足导致驱逐', status: 'ruled_out', evidenceIds: ['ev3'], toolCallIds: [], updatedAt: '2026-08-25T10:31:00Z' },
      { id: 'h3', statement: '镜像拉取失败或探针配置错误', status: 'active', evidenceIds: [], toolCallIds: [], updatedAt: '2026-08-25T10:29:00Z' },
    ],
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/panels/HypothesisTree.tsx src/components/panels/hypothesis-tree.css src/components/panels/HypothesisTree.test.tsx src/components/panels/HypothesisTree.stories.tsx
git commit -m "feat(web): add hypothesis tree panel"
```

---

### Task 6: App 接线（右栏调查过程 Tab）

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 新增 import**

`web/src/App.tsx` 的 import 区新增：

```tsx
import { HypothesisTree } from "./components/panels/HypothesisTree.js";
```

- [ ] **Step 2: 替换调查过程占位**

将：

```tsx
            process={<p className="ui-rp-placeholder">调查过程：M7 接入推理树</p>}
```

替换为：

```tsx
            process={
              <HypothesisTree
                hypotheses={currentSession.hypotheses ?? []}
                onCitationClick={handleCitationClick}
              />
            }
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: 运行全部测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(web): wire hypothesis tree into investigation panel"
```

---

### Task 7: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: server 测试**

Run: `npm test`（server 目录）

Expected: 全部通过（除既有沙箱 listen 失败外）。

- [ ] **Step 2: server 构建**

Run: `npm run build`（server 目录）

Expected: PASS。

- [ ] **Step 3: web 测试与构建**

Run: `npm test` 与 `npm run build`（web 目录）

Expected: PASS。

- [ ] **Step 4: Storybook 构建**

Run: `npm run build-storybook`（web 目录）

Expected: PASS。

- [ ] **Step 5: 提交收尾**

如果上述有修复：

```bash
git add -A
git commit -m "fix: resolve M7 acceptance issues"
```

---

## M7 验收清单

- [ ] `Hypothesis` 类型 + `AgentSession.hypotheses` 默认空数组（含测试）
- [ ] `extractHypotheses` 解析 `【假设列表】`（3 个测试）
- [ ] `mergeHypotheses` 按 statement 合并/更新（含测试）
- [ ] runner 合并假设并 emit `hypothesis_update`；prompts 增加输出要求
- [ ] 前端 HypothesisTree 渲染状态卡片与证据角标（3 个测试 + Story）
- [ ] 右栏"调查过程"Tab 显示真实假设；Conversation 跳过 hypothesis_update
- [ ] server 与 web 的 test/build/storybook 全部通过

## M7 完成后的下一步

M8（暗色主题切换 + 动效/视觉走查 + E2E + 收尾），随后可进行分支合并（finishing-a-development-branch）。
