# InfraPilot 计划：Skill Registry + RAG 检索式路由

## Context

当前 `runAgentTurn()` 每次都将 `ALL_TOOLS`（30+ 工具）全部注入 LLM Prompt。随着 OpenStack Skill 等新能力加入，带来三个问题：

1. **Prompt 冗长**：大量无关工具浪费 token，稀释上下文。
2. **选型准确率下降**：LLM 容易在面对宽泛问题时选错工具。
3. **扩展性差**：每新增一个 Skill，Prompt 线性膨胀。

因此需要引入 **Skill Registry + RAG 检索式路由**：根据用户 query 和当前会话意图，动态召回最相关的 Top-K 工具，只把这些工具注入 Prompt。

## 目标

1. 为每个 `ToolDef` 建立可嵌入的文本描述。
2. 提供轻量级向量化与相似度召回机制（默认本地 TF-IDF/关键词向量，可插拔 LLM embedding）。
3. 在 `orchestrator.ts` 中将全量 `ALL_TOOLS` 注入改为按 query 动态召回。
4. 预留 Knowledge Skill 的向量存储接口，后续可直接复用同一套 embedder + store。
5. 保持现有测试全部通过，新增 Skill Registry 单元测试。

## 方案

### 模块设计

新增 `server/src/skills/registry/` 目录：

```
registry/
  embedder.ts          # 文本 → 向量（TF-IDF 本地实现 / LLM embedding 可选）
  skillRegistry.ts     # 工具注册、索引构建、按 query 召回
  store.ts             # 向量/索引存储抽象（内存 / SQLite / 后续 Vector DB）
  registry.test.ts     # 单元测试
```

### 关键设计点

#### 1. 工具文本化

每个 `ToolDef` 生成一段用于检索的文本：

```
Skill: {skill}
Tool: {name}
Risk: {risk}
Description: {description}
Parameters: {params}
```

例如 `server_show`：

```
Skill: openstack
Tool: server_show
Risk: readonly
Description: 获取 Nova 虚机详情，包含 status、fault 信息、hypervisor_hostname...
Parameters: { server_id: string }
```

#### 2. 嵌入策略

**默认本地实现**：基于 TF-IDF 的关键词向量。

- 对工具描述分词（中文 jieba 太重，用简单规则：中文按字/词、英文按空白、去停用词）。
- 构建全局词表。
- 每个工具表示为稀疏向量（词 → TF-IDF 权重）。
- query 同样向量化，计算余弦相似度，返回 Top-K。

**可选 LLM embedding**：通过 `EMBEDDING_PROVIDER` 环境变量切换。

- `local`（默认）：TF-IDF
- `openai`：调用 OpenAI embeddings API
- 预留接口，未来可接 ollama / sentence-transformers。

#### 3. 召回接口

```typescript
export interface ToolRecallResult {
  tool: ToolDef;
  score: number;
}

export function recallTools(query: string, options?: { topK?: number; minScore?: number }): ToolRecallResult[];

export function buildRegistry(tools: ToolDef[]): void;
```

#### 4. 与 Orchestrator 集成

修改 `server/src/agent/orchestrator.ts`：

- 启动时或第一次调用前 `buildRegistry(ALL_TOOLS)`。
- `runAgentTurn(sessionId, userMessage)` 中，使用 `userMessage + session.incidentSummary` 作为 query。
- 召回 Top-K（默认 12-16 个）工具，转换为 OpenAI function 格式注入 Prompt。
- 保留安全兜底：即使工具未在召回列表中，`classifyRisk` 仍能通过 `findTool` 找到定义，因此不会绕过安全策略。

#### 5. Prompt 调整

`SYSTEM_PROMPT` 中“可用 Skill 与工具”段落改为动态生成：

```typescript
function buildSystemPrompt(recalledTools: ToolRecallResult[]): string {
  const toolLines = recalledTools
    .map(({ tool }) => `- ${tool.skill}.${tool.name}: ${tool.description}`)
    .join("\n");
  return `${SYSTEM_PROMPT}\n\n# 当前问题最相关的可用工具（请优先从中选择）\n${toolLines}\n`;
}
```

### 6. 预留 Knowledge Skill 接口

新增 `KnowledgeStore` 抽象：

```typescript
export interface EmbeddingStore<T> {
  add(items: T[]): Promise<void>;
  search(query: string, topK: number): Promise<Array<T & { score: number }>>;
}
```

`skillRegistry.ts` 内部实现 `ToolEmbeddingStore`，`knowledge/tools.ts` 后续可复用同一 `embedder.ts` + `store.ts` 存储 `KnowledgeCase`。

## 文件改动清单

### 新增

- `server/src/skills/registry/embedder.ts`
- `server/src/skills/registry/store.ts`
- `server/src/skills/registry/skillRegistry.ts`
- `server/src/skills/registry/registry.test.ts`

### 修改

- `server/src/agent/orchestrator.ts` — 动态召回工具
- `server/src/agent/prompts.ts` — 支持动态工具列表说明
- `server/src/index.ts` — 启动时预构建 Skill Registry
- `server/src/types.ts` — 可选补充 `EmbeddingProvider` 类型

## 验证步骤

1. `cd server && npm test` 全部通过。
2. 新增 `registry.test.ts` 覆盖：
   - TF-IDF 向量化稳定性
   - 相关工具召回（如 query “虚机创建失败” 召回 `server_show`、`hypervisor_list`、`allocation_candidate_list`）
   - 不相关工具被过滤（如 query “K8s Pod OOM” 不召回 OpenStack 工具）
3. 手动测试：通过 Web UI 或 curl 发送一条 K8s 相关请求，确认 Agent 没有调用 OpenStack 工具。

## 风险与回滚

| 风险 | 应对 |
|---|---|
| 召回遗漏关键工具 | 默认保留一定数量的通用发现类工具（如 `k8s.list_pods`、`linux.get_cpu_usage`）始终注入 Prompt；召回结果与兜底工具合并 |
| 本地 TF-IDF 对中文效果差 | 默认已够用；可配置 `EMBEDDING_PROVIDER=openai` 切换 LLM embedding |
| 引入外部 embedding 服务依赖 | 默认本地实现，无网络依赖 |
| 影响现有行为 | 保留 `classifyRisk` / `executeToolCall` 链路不变，仅改变注入 Prompt 的工具列表 |

## 计划执行顺序

1. 实现 `embedder.ts`（TF-IDF + 可选 LLM embedding 接口）。
2. 实现 `store.ts`（内存向量存储 + 余弦相似度搜索）。
3. 实现 `skillRegistry.ts`（构建索引 + 召回接口）。
4. 修改 `orchestrator.ts` 和 `prompts.ts` 接入动态召回。
5. 在 `index.ts` 启动时预构建 registry。
6. 新增 `registry.test.ts` 并跑通全量测试。
