# InfraPilot Phase 2 后续开发计划

## 摘要

继续完成 Phase 2 `linux-mcp-server` 的剩余工作：
1. 补齐并修复单元/集成测试，使 `npm test` 全部通过；
2. 增加 Kubernetes 部署清单（DaemonSet/Service/RBAC/证书），支持把 `linux-mcp-server` 常驻到各节点；
3. 补充 Phase 2 技术文档与使用说明。

本计划严格基于当前已实现的代码（`server/src/mcp/*`、`server/src/skills/linux/*`、`server/proto/linux_diagnostic.proto`、`server/src/index.ts`），不再改动协议与核心路由逻辑。

---

## 当前状态分析

已完成的 Phase 2 核心代码：

| 文件 | 状态 | 说明 |
|---|---|---|
| `server/proto/linux_diagnostic.proto` | 已完成 | gRPC 服务与消息定义 |
| `server/src/mcp/types.ts` | 已完成 | MCP transport 共享类型 |
| `server/src/mcp/auth.ts` | 已完成 | JWT 签发/校验、mTLS credentials 工厂 |
| `server/src/mcp/discovery.ts` | 已完成 | `MCP_ENDPOINTS` → gRPC；否则 SSH Host Registry fallback |
| `server/src/mcp/client.ts` | 已完成 | MCP Client Router：`MCP 优先 → SSH fallback` |
| `server/src/mcp/grpcClient.ts` | 已完成 | gRPC 客户端实现 |
| `server/src/mcp/protoLoader.ts` | 已完成 | proto 多路径加载 |
| `server/src/mcp/server/index.ts` | 已完成 | standalone gRPC server 入口 |
| `server/src/mcp/server/service.ts` | 已完成 | gRPC service handlers |
| `server/src/mcp/server/auth.ts` | 已完成 | 服务端 JWT scope 校验 |
| `server/src/mcp/server/allowlist.ts` | 已完成 | 变更类命令白名单 |
| `server/src/mcp/server/runner.ts` | 已完成 | 本地命令执行与结构化解析 |
| `server/src/skills/linux/agentTools.ts` | 已完成 | Phase 2 新增工具定义 |
| `server/src/skills/linux/tools.ts` | 已完成 | `local / MCP / SSH` 三路路由 |
| `server/src/index.ts` | 已完成 | `MCP_SERVER_MODE=true` 时启动 standalone MCP server |

当前问题：
1. `npm test` 在 `server/` 目录下会同时扫描 `dist/` 中的旧测试，且 `src/skills/linux/tools.test.ts` 仍按旧版 `executeOnHost` 逻辑编写，与当前 `executeLinuxToolOnHost` 不匹配，导致 16 个测试失败。
2. MCP 模块（client/grpcClient/server/auth/runner）缺少单元/集成测试。
3. 没有 K8s 部署清单，无法把 `linux-mcp-server` 部署到节点。
4. 缺少 Phase 2 使用文档。

---

## 计划变更

### 1. 修复测试基础设施

**文件**: `server/vitest.config.ts`（新增）

**原因**: 当前 `npm test` 同时跑 `src/` 与 `dist/` 下的测试，导致旧构建产物重复执行并失败。

**实现**: 新增 vitest 配置，排除 `dist`、`node_modules`、`*e2e*` 默认不跑（通过 `RUN_MCP_E2E=true` 开启）。

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist", "node_modules", "**/*.e2e.test.ts"],
    globals: true,
  },
});
```

---

### 2. 重写 `src/skills/linux/tools.test.ts`

**文件**: `server/src/skills/linux/tools.test.ts`（覆盖）

**原因**: 当前测试只 mock 了 `executeOnHost`，但 `tools.ts` 对远程主机已改为调用 `executeLinuxToolOnHost`；本地工具仍走 `executeOnHost`。

**实现**:
- `vi.mock("./remoteExecutor.js", ...)` 控制本地执行。
- `vi.mock("../../mcp/client.js", ...)` 控制远程 MCP/SSH fallback 执行。
- 保留并修正本地工具测试：`get_cpu_usage`、`get_memory_info`、`get_disk_usage`、`get_process_info`、`tail_recent_dmesg_or_syslog`。
- 新增远程路由测试：
  - `get_cpu_usage` with `host: "node-1"` → `executeLinuxToolOnHost` 被调用，返回结果直接透传。
  - `get_network_stats` / `restart_service` / `kill_process` 远程调用 → `executeLinuxToolOnHost` 被调用。
  - 异常捕获：mock `executeLinuxToolOnHost` reject，验证 `success=false` 且 error 包含异常信息。
- 修正 unknown tool 断言，匹配当前错误文案 `本地不支持的linux工具`。

---

### 3. MCP Client Router 单元测试

**文件**: `server/src/mcp/client.test.ts`（新增）

**原因**: 验证路由决策（MCP 优先、健康失败 fallback、变更类不降级）。

**实现**:
- mock `grpcMcpClient.health` / `grpcMcpClient.call`。
- mock `discoverTransport` 与 `isReadonlyTool`。
- mock `executeOnHost` 用于 SSH fallback 路径。
- 测试用例：
  1. `host === "local"` → 走 SSH fallback（本地执行）。
  2. MCP 健康通过 → 走 gRPC，`data.transport === "grpc"`。
  3. MCP 健康失败 + 只读工具 + sshFallback=true → 走 SSH fallback，`data.transport === "ssh_proxy"`。
  4. MCP 健康失败 + 变更工具 → 返回明确错误，禁止 SSH 执行。
  5. 无 MCP 且无 SSH 配置 → 返回“未找到可用执行通道”。

---

### 4. gRPC 客户端单元测试

**文件**: `server/src/mcp/grpcClient.test.ts`（新增）

**原因**: 验证工具名到 gRPC 方法映射、JWT metadata 注入、错误处理。

**实现**:
- mock `../protoLoader.js` 的 `getLinuxDiagnosticClient`，返回一个带 fake `GetCpuUsage/.../Health` 方法的对象。
- mock `../auth.js` 的 `signMcpJwt`，返回固定 token。
- 测试用例：
  1. `health()` 成功返回 `{ ok: true }`。
  2. `call("get_cpu_usage")` 调用对应 gRPC 方法并传入 JWT metadata。
  3. `call("restart_service")` 调用 `RestartService`。
  4. 不支持的 tool 返回 `success=false`。
  5. gRPC 错误回调返回 `success=false` 并保留错误信息。

---

### 5. gRPC 服务端集成测试

**文件**: `server/src/mcp/server/service.test.ts`（新增）

**原因**: 在测试进程内启动真实 gRPC server，验证每个 RPC 的结构化输出与 JWT 鉴权。

**实现**:
- 使用 `startMcpServer(0)` 绑定随机端口（`0` 让系统分配端口）。
- 测试 setup 中设置 `process.env.MCP_PROTO_PATH = "/root/InfraPilot/server/proto/linux_diagnostic.proto"`，确保 `protoLoader.ts` 找到 proto。
- 使用 `signMcpJwt` 签发只含目标工具 scope 的 token。
- 用 `grpcMcpClient` 或原始 client 发起调用。
- 测试用例：
  1. `Health` 无需鉴权，返回 `ok=true`。
  2. `GetCpuUsage` / `GetMemoryInfo` / `GetDiskUsage` / `GetNetworkStats` / `GetProcessInfo` / `TailSyslog` 带正确 token 返回成功，且字段类型符合 proto。
  3. `RestartService` 白名单外服务返回失败。
  4. `KillProcess` 非法信号返回失败。
  5. 缺少 token → `UNAUTHENTICATED`。
  6. token scope 不允许该工具 → `PERMISSION_DENIED`。
  7. 错误 token → `UNAUTHENTICATED`。
- teardown 调用 `server.tryShutdown()`。

> 说明：这些测试依赖本地命令（`top/free/df/ss/ps`），在 Linux sandbox 中可正常执行；如果未来在缺少这些命令的环境运行，可通过环境变量 `SKIP_SERVICE_INTEGRATION=true` 跳过。

---

### 6. MCP Auth 单元测试

**文件**: `server/src/mcp/auth.test.ts`（新增）

**原因**: 验证 JWT 生命周期、scope 校验与不同 secret 的隔离。

**实现**:
- 测试 `signMcpJwt` / `verifyMcpJwt` 正常 roundtrip。
- 测试过期 token 校验失败。
- 测试错误 secret 校验失败。
- 测试 `isToolAllowed`。
- 测试 `createServerCredentials`：无 TLS 时返回 insecure；有完整 ca/cert/key 路径时返回 SSL/mTLS。

---

### 7. Server Runner 单元测试

**文件**: `server/src/mcp/server/runner.test.ts`（新增）

**原因**: 验证变更类命令白名单与参数解析。

**实现**:
- mock `node:child_process` 的 `execFile`。
- 测试用例：
  1. `restartService("nginx")` 成功执行 `systemctl restart nginx`。
  2. `restartService("mysql")` 因不在白名单返回失败。
  3. `killProcess(1234, "SIGTERM")` 成功执行 `kill -SIGTERM 1234`。
  4. `killProcess(1234, "SIGKILL")` 因信号不在白名单失败。
  5. `killProcess(0, "SIGTERM")` 因 pid 不合法失败。
  6. `sanitizePattern` 去除危险字符。

---

### 8. E2E 测试（默认跳过）

**文件**: `server/src/mcp/e2e.test.ts`（新增）

**原因**: 覆盖主 server → standalone MCP server 的完整链路，但依赖真实子进程启动，默认不跑。

**实现**:
- 文件顶部判断 `process.env.RUN_MCP_E2E !== "true"` 时 `describe.skip`。
- 用 `spawn` 启动 `MCP_SERVER_MODE=true tsx src/index.ts`（随机端口）。
- 主 server 侧通过 `executeLinuxTool("get_cpu_usage", { host: "local" })` 调用；`host=local` 会走本地 SSH fallback，不经过 gRPC。因此 E2E 更直接验证：
  - 启动 standalone MCP server；
  - `grpcMcpClient.health()` 可达；
  - `grpcMcpClient.call()` 调用 `GetCpuUsage` 成功。
- teardown kill 子进程。

---

### 9. Kubernetes 部署清单

目录：`server/k8s-manifests/linux-mcp-server/`

#### 9.1 `namespace.yaml`

创建命名空间 `infrapilot-mcp`。

#### 9.2 `serviceaccount.yaml`

创建 `linux-mcp-server` ServiceAccount。

#### 9.3 `rbac.yaml`

最小 RBAC：允许读取节点信息用于节点身份展示，不包含集群修改权限。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: linux-mcp-server-reader
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
...
```

#### 9.4 `service.yaml`

Headless Service（`clusterIP: None`），用于在集群内通过 DNS 发现 Pod。

```yaml
selector:
  app: linux-mcp-server
ports:
  - name: grpc
    port: 8443
    targetPort: 8443
```

#### 9.5 `daemonset.yaml`

每个节点部署一个 `linux-mcp-server` Pod：
- 使用镜像占位符 `infrapilot/linux-mcp-server:latest`（构建流程见文档）。
- `hostPID: true` 与 `privileged: true`：允许执行 `systemctl restart` 与 `kill` 等主机级变更操作。
- `hostNetwork: true` + `hostPort: 8443`：主 server 可通过节点 IP 直接访问。
- 环境变量：
  - `MCP_SERVER_MODE=true`
  - `MCP_SERVER_PORT=8443`
  - `MCP_JWT_SECRET` 来自 Secret `mcp-jwt-secret`
- 挂载卷：
  - `/proc` 只读
  - `/sys` 只读
  - `/var/log` 只读
  - `/run/systemd`（可选，便于 systemctl 通信）
- 资源请求/限制：CPU 100m/500m，内存 128Mi/512Mi。

#### 9.6 `secret.yaml`（示例）

提供 `mcp-jwt-secret` 与 TLS secret 的示例模板（生产应使用 Vault/cert-manager，不提交真实密钥）。

#### 9.7 `cert-issuer.yaml`（可选，生产）

提供 cert-manager `ClusterIssuer`（SelfSigned）与 `Certificate` 示例，用于 mTLS 场景。

> 决策：当前 sandbox/开发环境默认使用 **insecure gRPC**，通过不挂载 TLS secret、不设置 `MCP_SERVER_CA_PATH` 等变量实现。生产环境再启用 mTLS。

---

### 10. 脚本与文档

**文件**: `server/package.json`（修改）

新增便捷脚本：

```json
"mcp-server": "MCP_SERVER_MODE=true tsx src/index.ts",
"mcp-server:prod": "MCP_SERVER_MODE=true node dist/index.js"
```

**文件**: `docs/linux-mcp-server-phase2.md`（新增）

内容：
- Phase 2 架构概述（附与 Phase 1 SSH Proxy 的关系图）。
- 本地启动 standalone MCP server 命令。
- 环境变量说明（`MCP_ENDPOINTS`、`MCP_JWT_SECRET`、`MCP_SERVER_PORT`、TLS 相关变量）。
- 如何签发测试 JWT 并用 `grpcurl` 调用。
- K8s 部署步骤（apply 清单、配置主 server 的 `MCP_ENDPOINTS`）。
- 安全说明：MCP 优先、SSH fallback 仅只读、变更类需审批。
- 测试说明：默认跑单元/集成；`RUN_MCP_E2E=true npm test` 跑 E2E。

---

## 假设与决策

1. **测试环境**: 假设运行测试的主机是 Linux，且具备 `top/free/df/ss/ps/systemctl/kill` 命令；service 集成测试依赖这些命令。
2. **gRPC TLS**: 当前 sandbox 使用 insecure gRPC 以简化部署；生产通过 cert-manager + mTLS secret 启用，清单中保留示例但不强制。
3. **K8s 部署形态**: 采用 **DaemonSet + hostNetwork + hostPort 8443**，让每台节点暴露固定端口，主 server 通过 `MCP_ENDPOINTS` JSON 映射别名到节点 IP。Headless Service 作为可选的集群内 DNS 发现补充。
4. **权限**: DaemonSet 需要 `hostPID: true` 与 `privileged: true` 才能执行主机级变更命令；生产可通过更细粒度 capabilities 收紧。
5. **不改动现有业务接口**: `executeLinuxTool` 的 inputSchema/输出结构保持不变，前端与 Agent Prompt 无需改动。

---

## 验证步骤

1. 在 `server/` 目录执行：
   ```bash
   npm run build
   npm run test
   ```
   期望结果：所有非 E2E 测试通过，`dist/` 测试不再重复执行。

2. 启动 standalone MCP server：
   ```bash
   npm run mcp-server
   ```
   期望看到日志：`[linux-mcp-server] listening on :8443 (credentials=insecure)`。

3. 用 `grpcurl` 验证（insecure 模式）：
   ```bash
   # 先生成 token（通过临时脚本或环境）
   grpcurl -plaintext -H "authorization: Bearer $TOKEN" \
     -d '{"host":"local","top_n":3}' \
     localhost:8443 infrapilot.linux.LinuxDiagnostic/GetCpuUsage
   ```

4. K8s 部署验证：
   ```bash
   kubectl apply -f server/k8s-manifests/linux-mcp-server/
   kubectl get pods -n infrapilot-mcp -o wide
   ```
   期望每个节点一个 Pod Running。

5. E2E 验证（可选）：
   ```bash
   RUN_MCP_E2E=true npm run test
   ```

---

## 实施顺序

| 顺序 | 内容 | 验收标准 |
|---|---|---|
| 1 | 新增 `vitest.config.ts` 并排除 `dist` | `npm test` 不再执行 `dist/` 测试 |
| 2 | 重写 `tools.test.ts` | 本地/远程路由测试通过 |
| 3 | 新增 `client.test.ts`、`grpcClient.test.ts` | MCP Client Router / gRPC 客户端覆盖通过 |
| 4 | 新增 `auth.test.ts`、`runner.test.ts` | JWT / 白名单覆盖通过 |
| 5 | 新增 `service.test.ts` | 真实 gRPC server 集成测试通过 |
| 6 | 新增 `e2e.test.ts`（默认跳过） | `RUN_MCP_E2E=true` 时通过 |
| 7 | 新增 K8s 清单 | `kubectl apply` 成功，Pod Running |
| 8 | 新增 `docs/linux-mcp-server-phase2.md` | 文档包含启动、配置、部署、测试说明 |
| 9 | 更新 `package.json` 脚本 | `npm run mcp-server` 可启动 standalone server |
| 10 | 全量验证 | `npm run build && npm run test` 全绿 |
