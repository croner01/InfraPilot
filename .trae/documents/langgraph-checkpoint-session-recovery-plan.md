# InfraPilot 计划：LangGraph Checkpoint / 会话恢复

## Context

当前 `runAgentTurn()` 使用 `while` 循环 + `await waitForApprovalDecision(approvalId)` 阻塞等待前端审批。审批 resolver 存储在内存 `Map` 中，存在两个生产级问题：

1. **Server 重启后审批状态丢失**：进程重启后，`pendingApprovals` 清空，前端已批准的请求无法恢复。
2. **会话状态已持久化，但执行循环无法恢复**：`AgentSession` 已写入 SQLite，但 orchestrator 的执行循环在内存中，重启后无法从 `awaiting_approval` 状态继续。

本计划在不引入 LangGraph 依赖的前提下，实现与 LangGraph Checkpoint 语义等价的持久化中断-恢复机制：

- 将 `runAgentTurn` 的执行状态抽象为可持久化的 `AgentCheckpoint`
- 审批请求写入持久化队列（ approvals 表已存在）
- 提供 `/api/sessions/:id/resume` 接口或启动时自动扫描 `awaiting_approval` 会话，恢复执行循环

## 目标

1. 定义 `AgentCheckpoint`：保存当前执行循环所需的最小状态（history、iteration、pendingToolCalls 等）。
2. 每次状态变更后将 checkpoint 持久化到 SQLite（`session_checkpoints` 表）。
3. 审批决策从“内存 Promise”改为“持久化事件 + 轮询/通知”。
4. Server 启动时扫描所有 `awaiting_approval` 会话，自动恢复执行循环。
5. 前端通过 WebSocket 或 POST `/api/sessions/:id/approve` 提交决策后，触发对应会话恢复。
6. 保持现有测试通过，新增 Checkpoint 与恢复测试。

## 方案

### 模块设计

```
server/src/agent/
  checkpoint.ts       # AgentCheckpoint 类型 + SQLite 读写
  runner.ts           # 将 runAgentTurn 拆分为可恢复的执行器
  orchestrator.ts     # 入口：新请求/恢复请求的统一调度
```

### 数据模型

在 `types.ts` 中新增：

```typescript
export interface AgentCheckpoint {
  sessionId: string;
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  iteration: number;
  status: SessionStatus;
  pendingToolCall?: PendingToolCall; // 当前等待审批的工具调用
  lastToolResults?: ExecutedToolCall[]; // 已执行完、尚未写回 history 的结果
  createdAt: string;
}
```

数据库新增表：

```sql
CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 执行循环重构

将 `runAgentTurn` 拆分为两个阶段：

1. **intake / planning**：处理用户新消息，构建 system prompt + history，生成初始 checkpoint。
2. **runner**：从 checkpoint 恢复，执行一次 LLM 调用，处理 tool_calls；如遇审批，保存 checkpoint 并退出；审批到达后再次 resume。

关键函数：

```typescript
// 处理用户新消息，创建/更新 checkpoint
export async function startAgentTurn(sessionId: string, userMessage: string): Promise<void>;

// 从 checkpoint 恢复执行循环（server 启动或审批后调用）
export async function resumeAgentTurn(sessionId: string, approvalId?: string): Promise<void>;
```

### 审批状态机

当前审批流程：

```
LLM -> tool_call(high risk) -> insertApproval -> emit approval_request -> await Promise
前端 POST /approve -> resolveApprovalDecision -> Promise resolve -> 继续执行
```

新审批流程：

```
LLM -> tool_call(high risk) -> insertApproval -> save checkpoint(status=awaiting_approval) -> emit approval_request -> 退出 runner
前端 POST /approve -> dbDecideApproval -> emit approval_decision -> 调用 resumeAgentTurn(sessionId, approvalId)
resumeAgentTurn -> 加载 checkpoint -> 校验 approval 状态 -> 继续执行
```

### 启动自动恢复

在 `server/src/index.ts` 启动流程中，增加：

```typescript
const awaitingSessions = listAwaitingApprovalSessions();
for (const s of awaitingSessions) {
  resumeAgentTurn(s.id);
}
```

### API 路由调整

- `POST /api/sessions/:id/messages`：用户新消息 → 调用 `startAgentTurn`
- `POST /api/sessions/:id/approve`：前端提交审批决策 → 写入 approvals 表 → 调用 `resumeAgentTurn`

### WebSocket 事件

保留现有 `approval_request` / `approval_decision` 事件。新增：

- `checkpoint_saved`：checkpoint 已持久化，可安全恢复
- `runner_resumed`：执行循环已恢复

## 文件改动清单

### 新增

- `server/src/agent/checkpoint.ts`
- `server/src/agent/runner.ts`
- `server/src/agent/checkpoint.test.ts`
- `server/src/agent/runner.test.ts`

### 修改

- `server/src/agent/orchestrator.ts` — 拆分为 `startAgentTurn` + `resumeAgentTurn`
- `server/src/agent/sessionStore.ts` — 移除内存 `pendingApprovals`，改为持久化审批事件
- `server/src/db/db.ts` — 新增 `session_checkpoints` 表；新增查询 `awaiting_approval` 会话
- `server/src/types.ts` — 新增 `AgentCheckpoint`
- `server/src/routes/api.ts` — `/messages` 调用 `startAgentTurn`；`/approve` 调用 `resumeAgentTurn`
- `server/src/index.ts` — 启动时自动恢复 `awaiting_approval` 会话

## 验证步骤

1. `cd server && npm test` 全部通过。
2. 新增测试覆盖：
   - checkpoint 保存与加载
   - runner 遇到审批时保存 checkpoint 并退出
   - `resumeAgentTurn` 从 checkpoint 恢复后继续执行
   - server 启动时自动恢复 `awaiting_approval` 会话
3. 手动测试：
   - 发送一条需要审批的请求
   - 重启 server
   - 通过 `/approve` 接口批准
   - 确认会话继续执行并给出结论

## 风险与回滚

| 风险 | 应对 |
|---|---|
| 重构破坏现有审批流程 | 保留 approvals 表结构；仅改变 resolver 触发方式；所有现有测试继续覆盖 |
| checkpoint JSON 过大 | history 已切片（tool result 限制 6000 字符）；如仍过大，后续可压缩/分页 |
| 启动时大量 `awaiting_approval` 会话同时恢复 | 逐个 resume，不并行风暴；后续可加并发限制 |
| 前端兼容性 | `/messages` 行为不变；`/approve` 接口已存在，只增加 resume 触发 |

## 计划执行顺序

1. 扩展 `types.ts` 新增 `AgentCheckpoint`。
2. 扩展 `db.ts` 新增 `session_checkpoints` 表与查询。
3. 实现 `checkpoint.ts`（保存/加载/删除）。
4. 实现 `runner.ts`（从 checkpoint 执行一次 LLM 调用并处理 tool_calls/审批）。
5. 重写 `orchestrator.ts` 为 `startAgentTurn` + `resumeAgentTurn`。
6. 修改 `sessionStore.ts` 移除内存 `pendingApprovals`。
7. 修改 `api.ts` 路由。
8. 修改 `index.ts` 启动恢复。
9. 新增测试并跑通全量测试。
