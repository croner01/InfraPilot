# InfraPilot 计划：OpenStack Skill + 审批防篡改 + DNS 发现优先级调整

## Context

根据最新需求，对项目做以下三处调整：

1. **Headless Service DNS 自动发现**：明确标记为低优先级，暂不实现，仅更新文档与注释。
2. **OpenStack Skill**：补齐设计文档 §7.3 规划的 OpenStack 诊断能力，支持 Nova/Neutron/Placement 等只读查询及虚机重启变更操作。
3. **审批令牌与 tool+args 哈希绑定**：在 Command Gateway 执行前校验 approval 记录与当前命令参数的 SHA256 哈希，防止"审批 A 命令、执行 B 命令"的 TOCTOU 篡改。

## 推荐执行顺序

1. 任务三：文档/注释标记（零风险）。
2. 任务二：审批哈希绑定（安全基础设施，影响所有 high-risk 工具）。
3. 任务一：OpenStack Skill（含 `server_reboot` 等 high-risk 工具，依赖任务二的保护）。

---

## 任务一：OpenStack Skill

### 新增文件

- `server/src/skills/openstack/client.ts` — Keystone token 获取与缓存、通用 REST 请求、工具级 API 封装。
- `server/src/skills/openstack/tools.ts` — `openstackTools: ToolDef[]` + `executeOpenStackTool()`。
- `server/src/skills/openstack/client.test.ts` — client 层单元测试。
- `server/src/skills/openstack/tools.test.ts` — 工具分发与结果测试。

### 修改文件

- `server/src/gateway/policy.ts` — `ALL_TOOLS` 展开 `openstackTools`。
- `server/src/gateway/commandGateway.ts` — `dispatch()` 增加 `case "openstack"`。

### 实现要点

#### client.ts

```typescript
export interface OpenStackConfig {
  authUrl: string;
  username: string;
  password: string;
  projectName: string;
  projectDomainId: string;
  userDomainId: string;
  regionName?: string;
}

interface AuthCache {
  token: string;
  expiresAt: number;
  catalog: ServiceCatalog;
}

function fromEnv(): OpenStackConfig;
async function authenticate(config: OpenStackConfig): Promise<AuthCache>;
export async function getAuthToken(): Promise<string>;
export async function openstackRequest(
  serviceType: "compute" | "network" | "placement",
  path: string,
  options?: { method?: "GET" | "POST"; body?: unknown; region?: string }
): Promise<{ status: number; data: unknown }>;

// 工具级封装
export async function showServer(serverId: string): Promise<NormalizedServer>;
export async function listServerEvents(serverId: string): Promise<NormalizedEvent[]>;
export async function listHypervisors(): Promise<NormalizedHypervisor[]>;
export async function listAllocationCandidates(resources: string): Promise<unknown>;
export async function listNeutronAgents(): Promise<NormalizedAgent[]>;
export async function listNovaServices(): Promise<NormalizedService[]>;
export async function rebootServer(serverId: string, rebootType: "SOFT" | "HARD"): Promise<void>;
```

- 使用 Node.js 内置 `fetch`（项目运行 Node 20），无需新增 npm 依赖。
- 通过 `POST {authUrl}/v3/auth/tokens` 获取 token，解析 `X-Subject-Token` 与 catalog。
- Token 缓存至过期前 60 秒，遇到 401 自动重认证一次。
- Catalog 按 `serviceType`、`interface=public`、可选 `regionName` 匹配 endpoint。
- 错误响应解析 JSON 错误体；日志中脱敏 password/token。

#### tools.ts

实现的工具清单：

| 工具名 | 风险 | 说明 |
|---|---|---|
| `server_show` | readonly | 虚机详情，含 fault、hypervisor_hostname |
| `server_list_events` | readonly | 虚机 instance action / event |
| `hypervisor_list` | readonly | 计算节点资源余量 |
| `allocation_candidate_list` | readonly | Placement API 资源候选 |
| `neutron_agent_list` | readonly | Neutron agent 状态 |
| `nova_service_list` | readonly | Nova 服务状态 |
| `server_reboot` | high | 虚机重启，需审批 |

所有工具返回统一 `ToolExecutionResult`，异常捕获后包装为 `success: false`。

### 测试策略

- `client.test.ts`：mock `fetch`，验证环境变量读取、token 缓存、401 重试、catalog 解析、错误处理。
- `tools.test.ts`：mock client 层函数，验证 7 个工具的分发与参数透传；验证未知工具错误。

---

## 任务二：审批令牌与 tool+args 哈希绑定

### 新增文件

- `server/src/gateway/argsHash.ts` — canonical JSON + SHA256 计算工具。
- `server/src/gateway/argsHash.test.ts` — 哈希稳定性与防篡改测试。
- `server/src/gateway/commandGateway.test.ts` — 审批校验逻辑测试。

### 修改文件

- `server/src/types.ts` — `PendingToolCall` 增加 `argsHash?: string`。
- `server/src/db/db.ts` — `approvals` 表新增 `args_hash TEXT NOT NULL`，增加迁移逻辑。
- `server/src/agent/orchestrator.ts` — 创建 approval 时计算并存储 `argsHash`。
- `server/src/gateway/commandGateway.ts` — 执行前校验 approval 记录、决策状态与 argsHash。

### 实现要点

#### argsHash.ts

```typescript
import crypto from "node:crypto";
import { SkillName } from "../types.js";

export function canonicalize(value: unknown): unknown;
export function computeArgsHash(
  skill: SkillName,
  tool: string,
  args: Record<string, unknown>
): string;
```

- `canonicalize` 对对象 key 递归排序，数组保持顺序。
- `computeArgsHash` 返回 `sha256(skill + ":" + tool + ":" + canonicalJSON(args))` 的 hex。

#### db.ts 迁移

```typescript
const columns = db.pragma("table_info(approvals)") as Array<{ name: string }>;
if (!columns.some((c) => c.name === "args_hash")) {
  db.exec(`ALTER TABLE approvals ADD COLUMN args_hash TEXT NOT NULL DEFAULT ''`);
}
```

#### orchestrator.ts

在创建 approval 前：

```typescript
const argsHash = computeArgsHash(skill, tool, args);
pending.argsHash = argsHash;
insertApproval({ id: approvalId, sessionId, skill, tool, args: JSON.stringify(args), argsHash, riskLevel: risk.level, diffPreview });
```

#### commandGateway.ts

`executeToolCall` 中，对需审批且携带 `approvalId` 的调用：

1. 检查 `pendingCall.approved === true`。
2. 从数据库读取 approval 记录。
3. 校验 `approval.decision === "approved"`。
4. 重新计算当前 `pendingCall` 的 `argsHash`，与 `approval.args_hash` 比对；不一致则拒绝执行并记录审计。
5. 任一校验失败返回明确错误信息。

### 测试策略

- `argsHash.test.ts`：相同参数哈希一致、key 顺序无关、skill/tool 变化改变哈希。
- `commandGateway.test.ts`：mock `dispatch`/`insertAudit`/`getApproval`，覆盖只读自动执行、未批准拒绝、approval 不存在、状态非 approved、args 篡改导致哈希不匹配、正常批准执行。

---

## 任务三：Headless Service DNS 自动发现优先级调整

### 修改文件

- `server/k8s-manifests/linux-mcp-server/service.yaml` — 更新注释，说明 Headless Service 为未来预留，当前走 `MCP_ENDPOINTS`。
- `server/src/mcp/discovery.ts` — 文件顶部注释说明当前不支持 DNS 自动发现。
- `docs/linux-mcp-server-phase2.md` — 增加章节明确标记该能力为低优先级、暂不实现。

### 修改内容

`service.yaml` 顶部注释：

```yaml
# Headless Service，为未来“基于 DNS 自动发现 linux-mcp-server Pod”预留。
# 当前版本暂不实现 DNS 自动发现，主 server 通过 MCP_ENDPOINTS 环境变量按节点 IP 访问。
```

`discovery.ts` 顶部注释：

```typescript
// 注：Headless Service DNS 自动发现已评估但优先级标记为低，暂不实现；
// 后续如需扩展，可在此模块增加 DNS SRV/A 记录解析。
```

`docs/linux-mcp-server-phase2.md` 增加：

```markdown
### Headless Service DNS 自动发现（暂不实现）

`service.yaml` 保留 Headless Service 为未来预留。当前主 server 仍通过 `MCP_ENDPOINTS` 显式映射节点 IP，DNS 自动发现标记为**低优先级**，暂不实现。
```

---

## 验证步骤

1. 运行 `cd server && npm test`，确保新增测试与既有测试全部通过。
2. 手动验证 OpenStack Skill：配置 `OS_*` 环境变量，调用 `server_show` / `hypervisor_list` 等工具。
3. 手动验证审批防篡改：通过 Web UI 触发 `patch_resource_limits` 或 `server_reboot` 审批，然后在后端临时篡改 `pendingCall.args`，确认 `executeToolCall` 返回"参数不匹配"错误。
4. 检查文档与注释是否已正确标记 DNS 自动发现为低优先级。

---

## 风险与回滚

| 风险 | 应对 |
|---|---|
| OpenStack 环境缺失影响开发 | client.ts 统一封装，测试全部 mock；不配置 OS_* 变量时 OpenStack 工具仅执行失败，不影响其他功能 |
| 旧 approvals 表缺少 args_hash | db.ts 启动时自动 `ALTER TABLE ADD COLUMN` |
| 旧 pending approval 哈希为空 | 迁移后空哈希只影响极少数旧记录；可在迁移时清理 24 小时前未决策的 approval |
| canonical JSON 不稳定 | 测试覆盖 key 顺序、嵌套对象、数组；合入前跑通 |
| 新增 high-risk 工具绕过审批 | Policy Engine 自动分级，Command Gateway 校验 approvalId + argsHash |
