# 跨会话记忆（Cross-Session Memory）实现计划

## 上下文

此前已修复单会话内的上下文丢失问题（`orchestrator.ts` 复用 checkpoint、`runner.ts` 保留 checkpoint、`prompts.ts` 增加上下文关联指令）。跨会话记忆的后端能力已实现：包括 `session_memories` 表、记忆存储与召回、Agent Runner 集成、API 端点与单元测试。用户已同意继续完成后端集成后的前端“记忆管理”面板。

## 当前状态

- [x] SQLite `session_memories` 表迁移
- [x] `SessionMemory` / `MemoryConfig` 类型
- [x] `memoryStore.ts` 与 `memoryStore.test.ts`
- [x] Agent Runner 与 prompts 集成
- [x] API 端点 `/config/memory`、`/memories`
- [x] 前端 API 封装 `fetchMemoryConfig` / `updateMemoryConfig` / `listMemories` / `deleteMemory`
- [ ] 前端 SettingsPage “记忆管理”面板（本计划剩余工作）

## 目标

1. 会话结束时自动提取并保存脱敏摘要。
2. 新建会话时，根据用户首条消息召回相关历史会话摘要并注入 system prompt。
3. 前端 SettingsPage 增加“记忆管理”面板，支持开关、Top-K 配置、查看/删除记忆。
4. 不破坏现有 API；SQLite 自动迁移；测试与构建全部通过。

## 方案概述

新增 `session_memories` 表保存会话摘要，复用现有 embedding/store 抽象做向量召回，在 `buildInitialHistory` 时把召回结果拼入 system prompt，并在会话结束时异步提取摘要。

---

## 1. 数据模型

### 1.1 SQLite 表

在 `/root/InfraPilot/server/src/db/db.ts` 初始化 SQL 中新增：

```sql
CREATE TABLE IF NOT EXISTS session_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding TEXT
);
```

- `session_id` 唯一：同一会话只沉淀一条记忆，避免重复。
- `tags` 存 JSON 字符串，如 `["auto_extracted"]`。
- `embedding` 存 JSON 向量，与 `incident_cases.embedding` 保持一致。
- 用 `addColumnIfMissing` 为旧表补列，保证向后兼容。

### 1.2 TypeScript 类型

`/root/InfraPilot/server/src/types.ts` 新增：

```ts
export interface SessionMemoryInput {
  sessionId: string;
  title: string;
  summary: string;
  tags?: string[];
}

export interface SessionMemory extends SessionMemoryInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
```

`/root/InfraPilot/server/src/config/types.ts` 新增：

```ts
export interface MemoryConfig {
  enabled: boolean;
  recallTopK: number;
}
```

`RuntimeConfig` 增加 `memory?: MemoryConfig`。

---

## 2. 后端实现

### 2.1 数据库访问层

`/root/InfraPilot/server/src/db/db.ts` 新增：

```ts
export interface MemoryRow { ... }
export function insertMemory(row: MemoryRow): void
export function getMemory(id: string): MemoryRow | undefined
export function getMemoryBySessionId(sessionId: string): MemoryRow | undefined
export function listMemories(): MemoryRow[]
export function deleteMemory(id: string): void
```

### 2.2 运行时配置

`/root/InfraPilot/server/src/config/store.ts` 新增：

```ts
const DEFAULT_MEMORY_CONFIG: MemoryConfig = { enabled: true, recallTopK: 3 };

export function getMemoryConfig(): MemoryConfig
export function setMemoryConfig(cfg: MemoryConfig): void
```

### 2.3 记忆存储模块（新增）

新建 `/root/InfraPilot/server/src/agent/memoryStore.ts`：

- 全局单例 `MemoryStore`，复用 `createEmbedder` + `InMemoryEmbeddingStore<SessionMemory>`。
- 导出函数：
  - `initMemoryStore(embedder?)`
  - `addMemory(input, embedder?)`
  - `searchMemories(query, limit?)`
  - `listMemories()`
  - `getMemory(id)`
  - `deleteMemory(id)`
  - `resetMemoryStore()`（测试用）
- 导出辅助函数：
  - `extractMemorySummary(session: AgentSession): string`：基于 title、incidentSummary、rootCause、remediation、工具名拼接摘要；整体过 `redact()` 脱敏。
  - `extractAndStoreSessionMemory(sessionId: string): Promise<void>`：读取配置，若未开启或会话无有效内容则跳过；同一会话只写一次。
  - `buildMemoryContext(query: string): Promise<string>`：读取配置，召回 Top-K 相关记忆并格式化为 markdown。

### 2.4 向量存储扩展

`/root/InfraPilot/server/src/skills/registry/store.ts` 的 `InMemoryEmbeddingStore` 增加：

```ts
remove(id: string): void
```

用于删除记忆后同步清理内存索引。

### 2.5 Agent Runner 集成

`/root/InfraPilot/server/src/agent/runner.ts`：

- `buildInitialHistory` 中，在 `similarCases` 后追加 `memoryContext`：

  ```ts
  const similarCases = await fetchSimilarCases(recallQuery);
  const memoryContext = await buildMemoryContext(recallQuery);
  const systemPrompt = buildSystemPrompt(
    buildToolListMarkdown(availableTools) + similarCases + memoryContext
  );
  ```

- `runAgentStep` 结束点（无 tool_calls 或达到 maxIterations）异步调用：

  ```ts
  extractAndStoreSessionMemory(sessionId).catch(() => {});
  ```

### 2.6 会话终止入口

`/root/InfraPilot/server/src/routes/api.ts` 的 `DELETE /sessions/:id` 中同步调用一次：

```ts
extractAndStoreSessionMemory(req.params.id).catch(() => {});
```

### 2.7 API 端点

`/root/InfraPilot/server/src/routes/config.ts` 新增：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/config/memory` | 获取记忆开关与 recallTopK |
| PUT | `/config/memory` | 更新记忆配置 |

`/root/InfraPilot/server/src/routes/api.ts` 新增：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/memories` | 列出所有记忆摘要 |
| DELETE | `/memories/:id` | 删除指定记忆 |

### 2.8 System Prompt

`/root/InfraPilot/server/src/agent/prompts.ts` 在“知识库使用原则”附近追加：

```
# 跨会话记忆使用原则
- 你也会看到与当前问题相关的历史会话摘要，仅作参考。
- 历史记忆不能直接作为当前结论，必须结合实时工具证据交叉验证。
```

---

## 3. 前端实现

### 3.1 类型

`/root/InfraPilot/web/src/lib/types.ts` 新增：

```ts
export interface MemoryConfig {
  enabled: boolean;
  recallTopK: number;
}

export interface MemoryEntry {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 API 封装

`/root/InfraPilot/web/src/lib/api.ts` 新增：

```ts
export function fetchMemoryConfig(onError?: OnError)
export function updateMemoryConfig(config: MemoryConfig, onError?: OnError)
export function listMemories(onError?: OnError)
export function deleteMemory(id: string, onError?: OnError)
```

### 3.3 设置页（剩余工作，需执行）

`/root/InfraPilot/web/src/components/SettingsPage.tsx`：

- `SECTIONS` 增加 `{ id: "memory-management", label: "记忆管理" }`。
- 导入 `fetchMemoryConfig`、`updateMemoryConfig`、`listMemories`、`deleteMemory`、`MemoryConfig`、`MemoryEntry`。
- `load()` 中并行拉取 `fetchMemoryConfig()` 与 `listMemories()`；新增状态 `memoryConfig` 与 `memories`。
- 新增 `MemoryPanel` 组件：
  - 启用/禁用开关（`enabled`）。
  - recallTopK 数字输入（1-10），失焦/回车时保存或点击保存按钮。
  - 保存按钮调用 `updateMemoryConfig`，成功后刷新配置状态。
  - 记忆列表展示标题、摘要、创建时间，支持删除；空列表显示 `EmptyState`。
- 顶部统计卡片增加“记忆条目数”。

`/root/InfraPilot/web/src/styles/app.css`：

- 新增 `.memory-panel`、`.memory-list`、`.memory-card`、`.memory-card__header`、`.memory-card__summary`、`.memory-card__meta`、`.memory-config__actions` 等样式，与现有设置页卡片风格保持一致。

---

## 4. 关键流程

1. 用户创建新会话并发送首条消息。
2. `startAgentTurn` -> `createInitialCheckpoint` -> `buildInitialHistory`。
3. `buildInitialHistory` 构造 `recallQuery = userMessage + incidentSummary`。
4. 同时召回：历史相似案例（`fetchSimilarCases`）和跨会话记忆（`buildMemoryContext`）。
5. 工具列表 + 案例 + 记忆拼入 system prompt。
6. 会话自然结束或被终止时，调用 `extractAndStoreSessionMemory`，脱敏后写入 `session_memories` 并生成 embedding。
7. 下次新会话启动时即可检索到该记忆。

---

## 5. 测试策略

### 5.1 后端单元测试

新增 `/root/InfraPilot/server/src/agent/memoryStore.test.ts`：

- `addMemory` / `listMemories` / `deleteMemory` / `getMemory` CRUD。
- `searchMemories` 按相似度排序（mock embedder）。
- `extractMemorySummary` 正确拼接并脱敏；不输出工具 args。
- `buildMemoryContext`：禁用返回空；启用且有匹配时返回 markdown。
- `extractAndStoreSessionMemory`：同一会话只写一次；空会话不写入。

### 5.2 Runner / Orchestrator 测试

`/root/InfraPilot/server/src/agent/runner.test.ts` 与 `/root/InfraPilot/server/src/agent/orchestrator.test.ts` 中 mock `memoryStore.js`：

```ts
vi.mock("../agent/memoryStore.js", () => ({
  buildMemoryContext: vi.fn().mockResolvedValue(""),
  extractAndStoreSessionMemory: vi.fn().mockResolvedValue(undefined),
  resetMemoryStore: vi.fn(),
}));
```

新增测试：当 `buildMemoryContext` 返回非空字符串时，system message 包含记忆文本。

### 5.3 配置 API 测试

新增 `/root/InfraPilot/server/src/routes/config.test.ts`（若未引入 supertest，则函数级测试）：

- `/config/memory` GET / PUT 默认值与更新。
- `/memories` GET / DELETE。

### 5.4 前端验证（剩余）

- `/root/InfraPilot/web` 执行 `npm run build`，确保 TypeScript 与 JSX 无错。
- 启动后端后手动验证：
  - SettingsPage 新增“记忆管理”导航项能正常滚动与高亮。
  - 开关与 Top-K 保存后刷新页面仍生效。
  - 记忆列表展示标题、摘要、时间；删除后列表即时刷新。

### 5.5 回归验证

- `/root/InfraPilot/server` 执行 `npm run build` 与 `npm test`。
- 验证现有 `runner.test.ts`、`orchestrator.test.ts`、`knowledge/tools.test.ts`、`registry/registry.test.ts` 全部通过。

---

## 6. 迁移与部署

1. 启动服务器时，SQLite 自动创建 `session_memories` 表。
2. `runtime-config.json` 缺失 `memory` 字段时使用默认值，不影响旧配置。
3. 无需手动迁移数据。

---

## 7. 风险与应对

| 风险 | 应对 |
|------|------|
| 记忆里混入密码/token | 只写入高层摘要 + 工具名；整体过 `redact()`。 |
| 重复提取 | `session_id` 唯一 + 提取前查重。 |
| 测试调用真实 embedding API | 测试使用 mock embedder；runner/orchestrator 测试 mock `memoryStore.js`。 |
| 禁用后仍写入/召回 | `extractAndStoreSessionMemory` 与 `buildMemoryContext` 都先读 `getMemoryConfig().enabled`。 |
| 删除记忆后索引未更新 | `InMemoryEmbeddingStore.remove(id)` 同步清理。 |

---

## 8. 关键修改文件清单

- [x] 新增：`/root/InfraPilot/server/src/agent/memoryStore.ts`
- [x] 新增：`/root/InfraPilot/server/src/agent/memoryStore.test.ts`
- [x] 修改：`/root/InfraPilot/server/src/db/db.ts`
- [x] 修改：`/root/InfraPilot/server/src/types.ts`
- [x] 修改：`/root/InfraPilot/server/src/config/types.ts`
- [x] 修改：`/root/InfraPilot/server/src/config/store.ts`
- [x] 修改：`/root/InfraPilot/server/src/routes/config.ts`
- [x] 修改：`/root/InfraPilot/server/src/routes/api.ts`
- [x] 修改：`/root/InfraPilot/server/src/agent/runner.ts`
- [x] 修改：`/root/InfraPilot/server/src/agent/prompts.ts`
- [x] 修改：`/root/InfraPilot/server/src/skills/registry/store.ts`
- [x] 修改：`/root/InfraPilot/server/src/agent/runner.test.ts`
- [x] 修改：`/root/InfraPilot/server/src/agent/orchestrator.test.ts`
- [x] 修改：`/root/InfraPilot/web/src/lib/types.ts`
- [x] 修改：`/root/InfraPilot/web/src/lib/api.ts`
- [ ] 修改：`/root/InfraPilot/web/src/components/SettingsPage.tsx`（本次执行）
- [ ] 修改：`/root/InfraPilot/web/src/styles/app.css`（本次执行）
