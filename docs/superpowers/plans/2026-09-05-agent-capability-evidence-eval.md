# Agent 能力提升（证据层 P0 + 推理/评测 P1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"Agent 判断方向错误"这一类问题从根上治理：证据层制度化（输出规范、显式错误语义、执行作用域注入、节点级证据工具），推理层自检（结论前反证、假设-证据编号回填），并用离线评测集把能力改进变成可度量的回归。

**Architecture:** P0 全部落在 server 端证据链：`summary.ts`（公共摘要约定）+ 对已知"静默空结果"的显式化、`executionScope.ts`（启动探测注入 system prompt）、k8s 新增 `top_nodes/get_node`；P1 落在推理与评测：prompts/plan.ts/runner 增加【反证检查】解析与假设-证据回填，新增 `server/src/agent/eval/`（离线评测：case + 纯函数评估器 + 运行脚本）。每个改动带单元测试。

**Tech Stack:** Node/TS（server）+ Vitest；OpenAI 兼容 function calling；K8s client（metrics.k8s.io / nodes）；npm 脚本 `eval:agent`。

**前置依赖：** M1-M8 与 k8s 技能增强已上线（top_pods/get_deployment/get_pod_memory/get_pod_processes、list_pods 汇总）。本计划不改 web。

**执行前注意：**
- 工作目录 `.worktrees/frontend-redesign-m1` 已移除，后续执行请新建 worktree（using-git-worktrees）。
- 镜像构建在 npm registry 限速时使用"旧镜像层叠加新 dist/skills"零网络法（见历次 commit），本计划各任务不新增 npm 依赖。
- 评测脚本需要可访问的运行实例（本地 8787 或集群 NodePort 30080）与可用 LLM key；无实例时仅跑 `evaluate.ts` 单元测试。
- 提交命令单独执行（勿与测试命令 `&&` 串联，沙箱会降权）。

---

### Task 1: 工具输出规范文档 + 公共摘要助手

**Files:**
- Create: `server/src/skills/summary.ts`
- Create: `server/src/skills/summary.test.ts`
- Create: `docs/tool-output-guidelines.md`
- Modify: `server/src/skills/k8s/tools.ts`（list_pods 改用助手，保持输出形状不变）

- [ ] **Step 1: 写失败测试**

Create `server/src/skills/summary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { countBy, capSamples } from "./summary.js";

describe("countBy", () => {
  it("counts values preserving insertion order", () => {
    expect(countBy(["Running", "Evicted", "Running", "Error"])).toEqual({ Running: 2, Evicted: 1, Error: 1 });
  });
});

describe("capSamples", () => {
  it("caps and reports truncation", () => {
    const input = [1, 2, 3, 4, 5];
    const { samples, truncated } = capSamples(input, 3);
    expect(samples).toEqual([1, 2, 3]);
    expect(truncated).toBe(true);
  });

  it("does not truncate small lists", () => {
    const { truncated } = capSamples([1, 2], 3);
    expect(truncated).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/skills/summary.test.ts`

Expected: FAIL，错误为 `Cannot find module './summary.js'`。

- [ ] **Step 3: 实现助手**

Create `server/src/skills/summary.ts`:

```ts
/** 列表类工具输出的公共约定：countBy 用于 summary 聚合，capSamples 用于样本截断 */
export function countBy<T extends string>(values: T[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

export function capSamples<T>(samples: T[], limit: number): { samples: T[]; truncated: boolean } {
  return { samples: samples.slice(0, limit), truncated: samples.length > limit };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/skills/summary.test.ts`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: list_pods 改用助手（重构不改变量输出）**

`server/src/skills/k8s/tools.ts` 的 `list_pods` case：
- import 增加 `countBy, capSamples`；
- `const byReason = countBy(abnormal.map((p) => p.status ?? p.reason ?? "Unknown"));`
- 样本截断改为：

现排序逻辑产出的数组变量名为 `samples`，截断改为：

```ts
        const capped = capSamples(samples, 15);
```

并将返回对象中的 `pods: samples` 与 `truncated: abnormal.length > samples.length` 替换为 `pods: capped.samples` 与 `truncated: capped.truncated`（输出形状不变，既有测试兼容）。

- [ ] **Step 6: 运行既有测试确认无回归**

Run: `npx vitest run src/skills/k8s/tools.test.ts src/skills/summary.test.ts`

Expected: PASS（8+3）。

- [ ] **Step 7: 写规范文档**

Create `docs/tool-output-guidelines.md`，内容必须覆盖：summary 计数在最前、样本截断必须带 `truncated`、判别字段显式化（Evicted/Error/OOMKilled 分开）、"查不到"必须返回 `success:false + error` 或 `note:"不可用原因"` 而非空成功、输出只给模型需要的字段。

- [ ] **Step 8: Commit**

```bash
git add server/src/skills/summary.ts server/src/skills/summary.test.ts server/src/skills/k8s/tools.ts docs/tool-output-guidelines.md
git commit -m "feat(agent): tool output summary helpers and guidelines"
```

---

### Task 2: 显式错误语义（消除"静默空 = 证据"）

**Files:**
- Modify: `server/src/skills/elk/tools.ts`
- Modify: `server/src/skills/elk/tools.test.ts`

背景：`searchRecords` 在索引不存在时 catch 并返回 `[]`，上层 `search_logs` 返回 `total_matched: 0`——Agent 会把"没日志"当成"启动早期即失败"证据。修复：空结果必须带 note 说明原因。

- [ ] **Step 1: 写失败测试**

在 `server/src/skills/elk/tools.test.ts` 追加：

```ts
  it("search_logs notes empty results instead of silent zero", async () => {
    SHIP_TARGETS.push({ namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" });
    const mocked = osClient.search as ReturnType<typeof vi.fn>;
    mocked.mockRejectedValue({ meta: { body: { error: { type: "index_not_found_exception" } } } });
    const res = await executeElkTool("search_logs", { namespace: "order-service", since: "30m" });
    expect(res.success).toBe(true);
    expect((res.data as { note?: string }).note).toContain("索引不存在或为空");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/skills/elk/tools.test.ts`

Expected: FAIL（无 note）。

- [ ] **Step 3: 实现**

`server/src/skills/elk/tools.ts` 的 `searchRecords` 目前 catch 后 `return []`。改为抛出带标记的哨兵，或让 `search_logs` 知道索引缺失：更简单——`searchRecords` 增加参数 `missingIndex` 状态：

```ts
async function searchRecords(query: unknown, size: number, options?: SearchOptions): Promise<{ records: LogRecord[]; indexMissing: boolean }> {
  const index = buildIndexPattern(options);
  if (!index) return { records: [], indexMissing: true };
  try {
    const res: any = await osClient.search({ index, body: { query: query as any, sort: [{ "@timestamp": { order: "asc" } }], size } } as any);
    return { records: res.body.hits.hits.map((h: any) => h._source as LogRecord), indexMissing: false };
  } catch (err: any) {
    if (err?.meta?.body?.error?.type === "index_not_found_exception") {
      return { records: [], indexMissing: true };
    }
    throw err;
  }
}
```

`search_logs` case 内调用与返回改为：

```ts
        const { records, indexMissing } = await searchRecords(query, Number(limit), searchOpts);
        const result = records.slice(-Number(limit)).map((l) => ({ ...l, message: redact(l.message ?? "") }));
        const data: Record<string, unknown> = { total_matched: result.length, logs: result, index_pattern: buildIndexPattern(searchOpts) };
        if (indexMissing) data.note = `索引不存在或为空(${buildIndexPattern(searchOpts)}), 可能是日志采集未覆盖或时间窗内无数据`;
        return { success: true, data, durationMs: Date.now() - start };
```

其余调用 `searchRecords` 的 case（aggregate_by_field/get_error_timeline/cluster_similar_errors）同步改为解构 `records`，并在 `indexMissing` 时给 `data.note`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/skills/elk/tools.test.ts`

Expected: PASS。

- [ ] **Step 5: 审计并记录其余"静默空"点**

在 `docs/tool-output-guidelines.md` 追加"已知静默空点"清单，至少包含：linux 容器日志不可取（docker terminated）、k8s exec 超时、metrics API 不可达（top_pods 抛错已转 success:false 保持）、clickhouse 空窗口。逐点确认现有行为是"success:false + error"还是"空 success"，属于后者的一并本 Task 修复并补测试。

- [ ] **Step 6: Commit**

```bash
git add server/src/skills/elk/tools.ts server/src/skills/elk/tools.test.ts docs/tool-output-guidelines.md
git commit -m "feat(agent): explicit empty-result notes in elk tool"
```

---

### Task 3: 执行作用域注入（部署形态感知）

**Files:**
- Create: `server/src/agent/executionScope.ts`
- Create: `server/src/agent/executionScope.test.ts`
- Modify: `server/src/agent/prompts.ts`
- Modify: `server/src/agent/runner.ts`（注入处）

- [ ] **Step 1: 写失败测试**

Create `server/src/agent/executionScope.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getExecutionScopeNote } from "./executionScope.js";

describe("getExecutionScopeNote", () => {
  afterEach(() => {
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  it("returns in-cluster note when running inside k8s", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    const note = getExecutionScopeNote();
    expect(note).toContain("InfraPilot Server 部署在 Kubernetes Pod 内");
    expect(note).toContain("linux host=local 作用域是 server 容器自身");
  });

  it("returns host note when running on host", () => {
    const note = getExecutionScopeNote();
    expect(note).toContain("宿主机");
  });
});
```

（可 mock `fs.existsSync`/环境以稳定两分支；测试只断言关键词。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/agent/executionScope.test.ts`

Expected: FAIL，`Cannot find module './executionScope.js'`。

- [ ] **Step 3: 实现探测模块**

Create `server/src/agent/executionScope.ts`:

```ts
/** 启动时探测运行形态，生成注入 system prompt 的作用域说明，避免 Agent 把 server 容器视角当宿主机视角 */
export function isInCluster(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

export function getExecutionScopeNote(): string {
  if (isInCluster()) {
    return [
      "⚠️ 执行作用域警告: 当前 InfraPilot Server 部署在 Kubernetes Pod 内,",
      "linux 工具的 host=local 作用域是 **InfraPilot Server 容器自身**, 不是宿主机, 也不是目标业务 Pod。",
      "诊断业务 Pod 时必须优先使用 k8s.top_pods / get_pod_memory / get_pod_processes / get_deployment / list_pods,",
      "不得用 linux.get_memory_info / get_process_info / tail_recent_dmesg_or_syslog 推断业务 Pod 或宿主机状态。",
    ].join("\n");
  }
  return "当前 InfraPilot Server 运行在宿主机上, linux 工具 host=local 可直接读取宿主机内存/进程/dmesg。";
}
```

- [ ] **Step 4: prompts 与 runner 注入**

`server/src/agent/prompts.ts`：

```ts
import { getExecutionScopeNote } from "./executionScope.js";
```

`buildSystemPrompt` 改为在 `{{toolList}}` 替换后追加作用域说明：

```ts
export function buildSystemPrompt(toolListMarkdown: string): string {
  return SYSTEM_PROMPT_TEMPLATE.replace("{{toolList}}", toolListMarkdown) + "\n\n" + getExecutionScopeNote();
}
```

删除模板里原先写死的"执行作用域警告"段，避免重复（runner.ts 不再单独拼接该说明）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/agent/executionScope.test.ts src/agent/prompts.test.ts`

Expected: PASS（prompts 既有断言如含关键词需同步核对）。

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/executionScope.ts server/src/agent/executionScope.test.ts server/src/agent/prompts.ts server/src/agent/runner.ts
git commit -m "feat(agent): inject execution scope note into system prompt"
```

---

### Task 4: k8s 节点级证据（top_nodes / get_node）

**Files:**
- Modify: `server/src/skills/k8s/client.ts`
- Modify: `server/src/skills/k8s/tools.ts`
- Modify: `server/src/skills/k8s/tools.test.ts`

- [ ] **Step 1: client 增加 topNodes 与 getNode**

`server/src/skills/k8s/client.ts` 追加：

```ts
export interface NodeMetricRow {
  name: string;
  cpuCores: number;
  memoryBytes: number;
}

/** 节点实时用量（metrics.k8s.io/v1beta1 nodes），等价 kubectl top node */
export async function topNodes(): Promise<NodeMetricRow[]> {
  const res = await customObjectsApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" });
  const items = ((res.body as { items?: unknown[] })?.items ?? []) as Array<{
    metadata?: { name?: string };
    usage?: Record<string, string>;
  }>;
  return items
    .map((item) => ({
      name: item.metadata?.name ?? "",
      cpuCores: parseCpu(item.usage?.cpu) ?? 0,
      memoryBytes: parseMemory(item.usage?.memory) ?? 0,
    }))
    .filter((row) => row.name !== "");
}

/** 节点 allocatable/capacity/conditions/taints（脱敏，无 secrets） */
export async function getNode(name: string) {
  const node = await coreApi.readNode({ name });
  return {
    name: node.metadata?.name,
    capacity: node.status?.capacity,
    allocatable: node.status?.allocatable,
    conditions: (node.status?.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
    })),
    taints: (node.spec?.taints ?? []).map((t) => ({ key: t.key, effect: t.effect })),
  };
}
```

- [ ] **Step 2: tools 增加定义与 case**

`tools.ts` 增两条只读工具定义（参考现有风格）：
- `top_nodes`（无参数）："读取所有节点 CPU/内存用量（等价 kubectl top node），用于判断节点级资源压力/驱逐来源"
- `get_node(node_name)`：读取单节点 capacity/allocatable/conditions(压力/磁盘)/taints

`executeK8sTool` 增加对应 case（直接调 client，原样返回），mock 测试两条路径成功与 node 404 失败。

- [ ] **Step 3: 测试**

`tools.test.ts` 追加两条：mock `topNodes`/`getNode`；断言返回与调用参数。

- [ ] **Step 4: 运行测试 + 构建**

Run: `npx vitest run src/skills/k8s/` 与 `npm run build`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/skills/k8s/client.ts server/src/skills/k8s/tools.ts server/src/skills/k8s/tools.test.ts
git commit -m "feat(k8s-skill): add node-level metrics and node info tools"
```

---

### Task 5: 结论前反证自检（【反证检查】契约）

**Files:**
- Modify: `server/src/agent/prompts.ts`
- Modify: `server/src/agent/plan.ts`
- Modify: `server/src/agent/plan.test.ts`
- Modify: `server/src/agent/runner.ts`

- [ ] **Step 1: prompts 增加输出要求**

在"# 输出要求"中、【根因分析结论】段落前追加：

```text
- 输出【根因分析结论】前,必须先输出以 "【反证检查】" 开头的简短列表, 每行格式 "- <与当前结论矛盾或未排除的解释>", 至少包含:
  1) 是否存在一个健康副本在运行(若存在, 为什么结论仍成立);
  2) 最有力的反证证据是什么(如无, 写 "无");
  3) 已被排除的主要替代解释。
```

- [ ] **Step 2: 写失败测试（plan.ts 解析）**

`plan.test.ts` 追加：

```ts
describe("extractCounterEvidence", () => {
  it("extracts counter-evidence list until next marker", () => {
    const text = [
      "【反证检查】",
      "- 存在 1 个 Running 副本, 但其内存已贴 4Gi 上限",
      "- 最有力反证: 无 OOMKilled 标记",
      "【根因分析结论】",
      "根因是...",
    ].join("\n");
    expect(extractCounterEvidence(text)).toHaveLength(2);
  });

  it("returns empty when no marker", () => {
    expect(extractCounterEvidence("直接结论")).toEqual([]);
  });
});
```

`plan.ts` 常量区新增：

```ts
const COUNTER_MARKER = "【反证检查】";
```

`nextMarker` 的候选数组加入 `COUNTER_MARKER`。

- [ ] **Step 3: 实现 extractCounterEvidence**

`plan.ts` 追加（模式同 `extractHypotheses`，行匹配 `- ...`，返回清洗后的字符串数组）：

```ts
/** 提取【反证检查】块，供结论前自检/替代假设展示 */
export function extractCounterEvidence(text: string): string[] {
  const idx = text.indexOf(COUNTER_MARKER);
  if (idx < 0) return [];
  const section = text.slice(idx + COUNTER_MARKER.length, nextMarker(text, idx + COUNTER_MARKER.length));
  return section
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("```"));
}
```

- [ ] **Step 4: runner 落库到 alternativeHypotheses**

`runner.ts` `processAssistantContent` 的 rca 分支中：

```ts
        alternativeHypotheses: extractCounterEvidence(content),
```

（import `extractCounterEvidence`。）

- [ ] **Step 5: 测试通过 + 全量回归**

Run: `npx vitest run src/agent/plan.test.ts src/agent/runner.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/prompts.ts server/src/agent/plan.ts server/src/agent/plan.test.ts server/src/agent/runner.ts
git commit -m "feat(agent): counter-evidence check before RCA conclusion"
```

---

### Task 6: 假设 ↔ 证据编号回填

**Files:**
- Modify: `server/src/agent/hypotheses.ts`
- Modify: `server/src/agent/hypotheses.test.ts`
- Modify: `server/src/agent/runner.ts`

- [ ] **Step 1: 写失败测试**

`hypotheses.test.ts` 追加：

```ts
import { linkHypothesesToEvidence } from "./hypotheses.js";
import type { Evidence } from "../types.js";

describe("linkHypothesesToEvidence", () => {
  it("maps evidence#N markers to evidence ids", () => {
    const hypotheses: Hypothesis[] = [
      { id: "h1", statement: "内存 limit 过小（证据#1 与 证据#2 支撑）", status: "confirmed", evidenceIds: [], toolCallIds: [], updatedAt: "t" },
    ];
    const evidence: Evidence[] = [
      { id: "ev-oom", type: "k8s_event", content: {}, confidence: 0.9, collectedAt: "t", summary: "OOM" },
      { id: "ev-mem", type: "metric", content: {}, confidence: 0.8, collectedAt: "t", summary: "4095Mi" },
    ];
    expect(linkHypothesesToEvidence(hypotheses, evidence)[0].evidenceIds).toEqual(["ev-oom", "ev-mem"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/agent/hypotheses.test.ts` → FAIL（未导出）。

- [ ] **Step 3: 实现**

`hypotheses.ts` 追加：

```ts
import type { Evidence, Hypothesis } from "../types.js";

/** 把假设文本里的 证据#N / 证据N 映射为 session.evidence 中第 N 条（1-based）的 id */
export function linkHypothesesToEvidence(hypotheses: Hypothesis[], evidence: Evidence[]): Hypothesis[] {
  return hypotheses.map((h) => {
    const ids = Array.from(new Set(Array.from(h.statement.matchAll(/证据#?(\d+)/g)).map((m) => {
      const index = Number(m[1]) - 1;
      return index >= 0 && index < evidence.length ? evidence[index].id : undefined;
    }).filter((id): id is string => Boolean(id))));
    return ids.length > 0 ? { ...h, evidenceIds: Array.from(new Set([...h.evidenceIds, ...ids])) } : h;
  });
}
```

- [ ] **Step 4: runner 在 merge 后回填**

`runner.ts` 的 hypothesis 分支中、`emitEvent` 前：

```ts
        updateSession(sessionId, (s) => {
          s.hypotheses = linkHypothesesToEvidence(mergeHypotheses(s.hypotheses ?? [], hypotheses), s.evidence);
        });
```

（import `linkHypothesesToEvidence`。）

- [ ] **Step 5: 测试 + 全量回归**

Run: `npx vitest run src/agent/hypotheses.test.ts src/agent/runner.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/hypotheses.ts server/src/agent/hypotheses.test.ts server/src/agent/runner.ts
git commit -m "feat(agent): backfill hypothesis evidence ids from cited numbers"
```

---

### Task 7: 离线评测引擎（纯函数）

**Files:**
- Create: `server/src/agent/eval/types.ts`
- Create: `server/src/agent/eval/evaluate.ts`
- Create: `server/src/agent/eval/evaluate.test.ts`
- Create: `server/src/agent/eval/cases/kafka-evicted.json`

- [ ] **Step 1: 类型与纯函数**

Create `server/src/agent/eval/types.ts`:

```ts
export type EvalCheck =
  | { type: "hasTool"; skill: string; tool: string }
  | { type: "rootCauseMatches"; regex: string }
  | { type: "hypothesisStatus"; statementRegex: string; status: string };

export interface EvalCase {
  id: string;
  message: string;
  checks: EvalCheck[];
}

export interface EvalContext {
  toolsUsed: Array<{ skill: string; tool: string }>;
  rootCauseSummary: string;
  hypotheses: Array<{ statement: string; status: string }>;
}

export interface EvalResult {
  caseId: string;
  checks: Array<{ check: EvalCheck; passed: boolean; reason?: string }>;
  passedAll: boolean;
}
```

- [ ] **Step 2: 写失败测试**

Create `server/src/agent/eval/evaluate.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { evaluateCase } from "./evaluate.js";
import type { EvalCase, EvalContext } from "./types.js";

const ctx: EvalContext = {
  toolsUsed: [{ skill: "k8s", tool: "list_pods" }, { skill: "k8s", tool: "top_pods" }],
  rootCauseSummary: "节点驱逐与容器 OOM(4Gi) 共同导致 Kafka 崩溃, emptyDir 加剧",
  hypotheses: [{ statement: "emptyDir 导致数据丢失", status: "confirmed" }],
};

describe("evaluateCase", () => {
  it("passes when tools, summary and hypotheses match", () => {
    const c: EvalCase = {
      id: "c1",
      message: "kafka 无法启动",
      checks: [
        { type: "hasTool", skill: "k8s", tool: "top_pods" },
        { type: "rootCauseMatches", regex: "OOM|Evicted|emptyDir" },
        { type: "hypothesisStatus", statementRegex: "emptyDir", status: "confirmed" },
      ],
    };
    const r = evaluateCase(c, ctx);
    expect(r.passedAll).toBe(true);
  });

  it("fails on missing evidence", () => {
    const c: EvalCase = {
      id: "c2",
      message: "x",
      checks: [{ type: "hasTool", skill: "k8s", tool: "get_deployment" }],
    };
    expect(evaluateCase(c, ctx).passedAll).toBe(false);
  });
});
```

- [ ] **Step 3: 实现 evaluate.ts**

```ts
import type { EvalCase, EvalContext, EvalResult } from "./types.js";

export function evaluateCase(evalCase: EvalCase, ctx: EvalContext): EvalResult {
  const results = evalCase.checks.map((check) => {
    switch (check.type) {
      case "hasTool":
        return ctx.toolsUsed.some((t) => t.skill === check.skill && t.tool === check.tool);
      case "rootCauseMatches":
        return new RegExp(check.regex, "i").test(ctx.rootCauseSummary);
      case "hypothesisStatus":
        return ctx.hypotheses.some(
          (h) => new RegExp(check.statementRegex, "i").test(h.statement) && h.status === check.status,
        );
      default:
        return false;
    }
  });

  return {
    caseId: evalCase.id,
    checks: evalCase.checks.map((check, i) => ({ check, passed: results[i], reason: results[i] ? undefined : "未命中" })),
    passedAll: results.every(Boolean),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/agent/eval/evaluate.test.ts` → PASS（2 tests）

- [ ] **Step 5: 建立首个回归 case**

Create `server/src/agent/eval/cases/kafka-evicted.json`（金标准来自本次实战）：

```json
{
  "id": "kafka-evicted-oom",
  "message": "分析 islap 命名空间下 kafka 无法启动的原因",
  "checks": [
    { "type": "hasTool", "skill": "k8s", "tool": "list_pods" },
    { "type": "hasTool", "skill": "k8s", "tool": "get_deployment" },
    { "type": "rootCauseMatches", "regex": "Evicted|驱逐|OOM|内存|emptyDir|4Gi|页缓存" },
    { "type": "rootCauseMatches", "regex": "emptyDir" }
  ]
}
```

同时把 927a741f 会话的"错误金标准反面检查"加注释：该 case 曾判"启动即失败"，故 rootCauseMatches 不应命中 `"启动早期即失败"` 的排他表述——本版评测暂以正向命中为准，反向检查列入 Task 8 文档。

- [ ] **Step 6: Commit**

```bash
git add server/src/agent/eval/
git commit -m "feat(agent): offline eval engine with kafka regression case"
```

---

### Task 8: 评测运行脚本 + 文档

**Files:**
- Create: `server/src/agent/eval/runEval.ts`
- Modify: `server/package.json`（scripts: eval:agent）
- Create: `docs/agent-eval.md`

- [ ] **Step 1: 运行脚本**

`runEval.ts`：读 `cases/*.json`；对每个 case：
1. `POST {base}/api/sessions` 建会话；
2. `POST /messages` 发 `case.message`；
3. 轮询 `GET /sessions/:id` 至 `concluded/closed`（超时 180s）；
4. 拉 events 提取 `toolsUsed`（tool_call_start 去重）、`rootCauseSummary`、`hypotheses`；
5. `evaluateCase` 输出表格（caseId/check/pass），统计 `passed/total`；
6. 非全过则 `process.exit(1)`。

CLI：`tsx src/agent/eval/runEval.ts <base-url>`，默认 `http://localhost:8787`。fetch 为 Node 内置（Node 22）。

- [ ] **Step 2: package.json 脚本**

```json
    "eval:agent": "tsx src/agent/eval/runEval.ts"
```

- [ ] **Step 3: 文档**

Create `docs/agent-eval.md`：使用方式、case schema、如何新增/固化真实会话（给出从 GET /api/sessions/:id 导出金标准的步骤）、CI 建议（在测试环境起 server + mock LLM 跑 `npm run eval:agent`）。

- [ ] **Step 4: 冒烟（可选）**

如有可访问实例与 LLM key：

```bash
npm run eval:agent -- http://192.168.111.209:30080
```

Expected: kafka-evicted case 通过（若实际结论偏离，记录为已知项而非硬失败）。

- [ ] **Step 5: Commit**

```bash
git add server/src/agent/eval/runEval.ts server/package.json docs/agent-eval.md
git commit -m "feat(agent): eval runner script and docs"
```

---

### Task 9: 全量验收

**Files:** 无新增；问题则修复对应文件。

- [ ] **Step 1: server 全量测试与构建**

Run: `npm test` 与 `npm run build`（server 目录）

Expected: PASS（新增 summary/executionScope/eval 等测试全绿）。

- [ ] **Step 2: 回归基线**

若已部署实例可访问，运行 `npm run eval:agent -- <base-url>`，记录通过率。

- [ ] **Step 3: 提交收尾**

如有修复：`git add -A && git commit -m "fix(agent): resolve evidence-eval acceptance issues"`

---

## 验收清单

- [ ] `summary.ts` 助手 + `docs/tool-output-guidelines.md` 落地，list_pods 用助手重构无行为变化
- [ ] elk 空结果带 `note`（索引缺失 vs 无数据可区分）；"静默空"清单审计完成
- [ ] in-cluster 时 system prompt 注入作用域警告（executionScope 单测）
- [ ] `k8s.top_nodes` / `k8s.get_node` 上线并测试
- [ ] 结论前【反证检查】解析并写入 `alternativeHypotheses`
- [ ] 假设文本中 `证据#N` 回填 `evidenceIds`
- [ ] `server/src/agent/eval/`：纯函数评估器测试通过 + kafka-evicted case 入库
- [ ] `npm run eval:agent` 可用，`docs/agent-eval.md` 写清固化流程
- [ ] server 全量测试/构建通过

## 后续（不在本计划）

- P2：工具执行卡耗时、会话续跑、并行假设验证、内存趋势图表证据
- 反向金标准检查（如"不得断言启动即失败而无健康副本核查"）与多 case 矩阵
- 将评测接入 CI/每日回归，随技能改动自动跑
