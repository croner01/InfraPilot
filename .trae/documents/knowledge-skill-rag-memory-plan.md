# InfraPilot 计划：Knowledge Skill + RAG 记忆层

## Context

设计文档 §10 / §4 提出 Agent 应具备“经验沉淀”能力：

- 历史 incident 案例库
- SOP / 运维手册检索
- 相似故障推荐

当前 `knowledge/tools.ts` 是空实现，`incident_cases` 表仅支持标题+根因摘要的精确查询，无法做到语义检索。随着 Skill Registry 的 embedder/store 抽象已落地，现在可以低成本地为 Knowledge Skill 补齐 RAG 能力。

## 目标

1. 定义 `KnowledgeCase` 的完整数据模型（标题、问题类型、严重级别、摘要、根因、解决方案、关联服务、标签、来源等）。
2. 复用 `embedder.ts` + `store.ts` 构建 Knowledge 向量索引。
3. 提供 `search_similar_cases` 工具：按故障描述语义检索相似案例。
4. 提供 `add_case` 工具：将当前会话的 RCA 与修复步骤沉淀为案例（供 Agent 在结论阶段或用户手动调用）。
5. 在 `orchestrator.ts` 中集成：Agent 在诊断前/诊断中可主动检索相似案例；在给出 RCA 结论后可选择沉淀新案例。
6. 保持现有测试通过，新增 Knowledge Skill 单元测试。

## 方案

### 模块设计

复用并扩展现有结构：

```
server/src/skills/knowledge/
  store.ts          # 基于 SQLite 的 KnowledgeCase 持久化 + 内存向量索引
  tools.ts          # search_similar_cases / add_case / get_case 工具定义与分发
  tools.test.ts     # 单元测试
```

### 数据模型

在 `types.ts` 已有 `KnowledgeCase` 基础上扩展为可写入的结构：

```typescript
export interface KnowledgeCaseInput {
  title: string;
  problemType: string;        // e.g. "OOMKilled", "NoValidHost", "网络不通"
  severity: "p0" | "p1" | "p2" | "p3";
  summary: string;            // 问题现象
  rootCauses: string[];       // 根因列表
  solutions: string[];        // 解决方案/SOP 步骤
  serviceName?: string;       // 关联服务/组件
  tags?: string[];            // 人工标签
  sourceSessionId?: string;   // 来源会话
}
```

数据库 `incident_cases` 表扩展：

```sql
ALTER TABLE incident_cases ADD COLUMN problem_type TEXT;
ALTER TABLE incident_cases ADD COLUMN severity TEXT;
ALTER TABLE incident_cases ADD COLUMN solutions TEXT;        -- JSON
ALTER TABLE incident_cases ADD COLUMN tags TEXT;             -- JSON
ALTER TABLE incident_cases ADD COLUMN source_session_id TEXT;
ALTER TABLE incident_cases ADD COLUMN embedding TEXT;        -- JSON（稀疏向量，可离线重建）
```

### 向量化策略

Knowledge 文本由以下字段拼接：

```
title: {title}
problem_type: {problemType}
severity: {severity}
summary: {summary}
root_causes: {rootCauses.join("\n")}
solutions: {solutions.join("\n")}
service: {serviceName}
tags: {tags.join(",")}
```

使用 `createEmbedder()` 生成向量，存储到 `InMemoryEmbeddingStore<KnowledgeCase>` 中。启动时从 SQLite 加载全部 case 重建索引。

### 工具定义

#### `knowledge__search_similar_cases`

- 风险：readonly
- 参数：
  - `query`（必填）：故障描述或日志片段
  - `problem_type`（可选）：过滤问题类型
  - `service_name`（可选）：过滤关联服务
  - `limit`（可选，默认 5）：返回数量
- 返回：相似案例列表（含 similarity score）

#### `knowledge__get_case`

- 风险：readonly
- 参数：`case_id`
- 返回：完整 KnowledgeCase

#### `knowledge__add_case`

- 风险：medium（写入知识库，但影响可控；当前无需审批，未来可配置）
- 参数：`KnowledgeCaseInput`
- 返回：新 case 的 id

### 与 Orchestrator 集成

1. **诊断前检索**：`runAgentTurn` 接收到用户消息后，在召回 tools 之前先用 query 检索相似案例，将 top-3 案例摘要注入 system prompt 的“背景知识”段落。
2. **Agent 主动调用**：Agent 也可在诊断过程中调用 `search_similar_cases` 获取更详细参考。
3. **结论沉淀**：当 Agent 输出 `【根因分析结论】` 后，如会话被标记为“有价值”，自动/半自动调用 `add_case` 将 `incidentSummary`、`rootCause`、`evidence`、`remediation` 沉淀为案例。

### Prompt 调整

在 `SYSTEM_PROMPT` 中新增段落：

```
# 知识库使用原则
- 诊断前和诊断中，你可以调用 knowledge.search_similar_cases 查询历史相似案例，参考其根因和修复方案。
- 参考历史案例时，请在结论中说明参考了哪些 case_id。
- 当你完成根因分析后，如果认为该故障具有复现价值，可以调用 knowledge.add_case 将其沉淀到知识库。
```

## 文件改动清单

### 新增/修改

- `server/src/skills/knowledge/store.ts` — SQLite 读写 + 向量索引管理
- `server/src/skills/knowledge/tools.ts` — 工具定义与执行
- `server/src/skills/knowledge/tools.test.ts` — 单元测试
- `server/src/db/db.ts` — `incident_cases` 表扩展与迁移
- `server/src/types.ts` — `KnowledgeCaseInput` / `KnowledgeCase` 字段扩展
- `server/src/agent/prompts.ts` — 增加知识库使用原则
- `server/src/agent/orchestrator.ts` — 诊断前检索相似案例并注入 Prompt；结论后可选沉淀

## 验证步骤

1. `cd server && npm test` 全部通过。
2. 新增测试覆盖：
   - `search_similar_cases` 按 query 召回相关案例
   - `add_case` 写入 SQLite 并更新内存索引
   - 过滤条件（problem_type / service_name）生效
   - Orchestrator 诊断前将相似案例注入 Prompt
3. 手动测试：创建 case → 查询相似 case → 确认返回。

## 风险与回滚

| 风险 | 应对 |
|---|---|
| `incident_cases` 表 schema 变更导致旧数据不兼容 | 启动时自动 ALTER TABLE ADD COLUMN，旧行新列为 NULL；代码中做兼容处理 |
| 向量索引占用内存过大 | Knowledge case 数量可控；后续可切 SQLite fts5 或 Vector DB |
| Agent 过度依赖历史案例导致误诊 | Prompt 明确“历史案例仅供参考，需结合当前证据交叉验证” |
| add_case 产生垃圾数据 | 当前由 Agent 判断调用，后续可增加人工确认开关 |

## 计划执行顺序

1. 扩展 `types.ts` 中的 KnowledgeCase 类型与新增 KnowledgeCaseInput。
2. 扩展 `db.ts` 中的 `incident_cases` 表并添加迁移。
3. 实现 `knowledge/store.ts`（SQLite 读写 + 内存向量索引）。
4. 实现 `knowledge/tools.ts`（search / get / add）。
5. 修改 `prompts.ts` 增加知识库使用原则。
6. 修改 `orchestrator.ts` 集成诊断前检索与结论沉淀。
7. 新增 `knowledge/tools.test.ts` 并跑通全量测试。
