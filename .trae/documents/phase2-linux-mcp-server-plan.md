# InfraPilot Phase 2：linux-mcp-server 常驻 Agent 实现计划

## Context

Phase 1 已基于 SSH Proxy + Host Registry 实现 Linux 远程命令执行，但本质上仍是“裸 shell”，存在协议开销高、输出非结构化、依赖长期静态凭据等问题。

Phase 2 目标：引入 **linux-mcp-server** 常驻 Agent，作为 DaemonSet/VM Agent 部署在每台 Linux 主机上，通过 **gRPC + mTLS + 短期 JWT** 提供结构化诊断接口，替代裸 shell 执行；同时保留 SSH Proxy 作为无 Agent 主机的降级通道。

## 用户决策

1. **协议形态**：gRPC MCP Server（严格对齐设计文档 §5 / §7.1）
2. **工具范围**：只读诊断工具 + 变更类工具（restart_service / kill_process）
3. **安全级别**：生产级 mTLS + 短期 JWT

## 总体架构

```text
InfraPilot Main Server
├─ Orchestrator / Agent
├─ Policy Engine (risk/approval)
├─ Command Gateway (dispatch + audit)
└─ MCP Client Router
    ├─ gRPC transport → linux-mcp-server (preferred)
    └─ SSH Proxy fallback (existing)

         mTLS + short-lived JWT
linux-mcp-server (per-host DaemonSet/VM Agent)
├─ gRPC service: LinuxDiagnostic
├─ local command handlers (structured output)
├─ command allowlist + audit log
└─ JWT auth + optional mTLS server auth
```

## 关键设计原则

1. **MCP Client Router 屏蔽 transport**：Skill 层和 Command Gateway 不感知底层是 gRPC 还是 SSH。
2. **MCP 优先、SSH fallback**：某主机若注册了 MCP endpoint 且健康检查通过则走 gRPC；否则尝试 SSH Proxy；变更类命令无 MCP 时不自动降级 SSH（避免绕过审批）。
3. **结构化输出**：每个 RPC 返回 JSON schema，便于 LLM 理解和后续证据链存储。
4. **安全默认**：服务端仅暴露白名单命令；变更类命令（restart_service / kill_process）必须经 Command Gateway 审批。
5. **审计双写**：MCP Server 本地输出 `[MCP_AUDIT]` JSON 日志；Command Gateway 写入 SQLite `audit_log`。

## 新增依赖

```json
{
  "dependencies": {
    "@grpc/grpc-js": "^1.12.0",
    "@grpc/proto-loader": "^0.7.13",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "@types/jsonwebtoken": "^9.0.6"
  }
}
```

## 文件清单

### 1. 新增文件

| 文件 | 说明 |
|---|---|
| `server/proto/linux_diagnostic.proto` | gRPC service + message 定义 |
| `server/src/mcp/types.ts` | MCP transport 共享类型 |
| `server/src/mcp/discovery.ts` | host → MCP endpoint / SSH fallback 发现 |
| `server/src/mcp/auth.ts` | JWT 签发/校验 + mTLS HTTPS/gRPC credentials 工厂 |
| `server/src/mcp/client.ts` | MCP Client Router，对外暴露 `executeLinuxToolOnHost` |
| `server/src/mcp/grpcClient.ts` | gRPC linux-mcp-server 客户端实现 |
| `server/src/mcp/server/index.ts` | standalone linux-mcp-server 入口 |
| `server/src/mcp/server/service.ts` | gRPC service 实现（handlers） |
| `server/src/mcp/server/auth.ts` | server 侧 JWT + mTLS 校验 |
| `server/src/mcp/server/allowlist.ts` | server 侧命令白名单与参数校验 |
| `server/src/mcp/server/runner.ts` | 本地命令执行与结构化解析 |
| `server/src/skills/linux/mcpExecutor.ts` | Linux Skill 对接 MCP Client Router |
| `server/src/skills/linux/agentTools.ts` | Phase 2 扩展工具定义 |
| `server/src/mcp/client.test.ts` | MCP Client Router 单元测试 |
| `server/src/mcp/grpcClient.test.ts` | gRPC 客户端测试 |
| `server/src/mcp/server/service.test.ts` | gRPC 服务端 handlers 测试 |
| `server/src/mcp/e2e.test.ts` | 端到端测试（需 standalone server） |
| `server/k8s-manifests/linux-mcp-server/daemonset.yaml` | DaemonSet 部署 |
| `server/k8s-manifests/linux-mcp-server/service.yaml` | Headless Service |
| `server/k8s-manifests/linux-mcp-server/rbac.yaml` | 最小权限 RBAC |
| `server/k8s-manifests/linux-mcp-server/cert-issuer.yaml` | cert-manager ClusterIssuer（mTLS） |
| `docs/linux-mcp-server-phase2.md` | Phase 2 技术文档与使用说明 |

### 2. 修改文件

| 文件 | 修改点 |
|---|---|
| `server/package.json` | 新增 grpc、jsonwebtoken 依赖 |
| `server/tsconfig.json` | 配置 proto 输出目录/类型生成（可选） |
| `server/src/types.ts` | 扩展 `SkillName`、`ToolExecutionResult` meta、新增 HostTransportConfig |
| `server/src/gateway/commandGateway.ts` | 无需大改，继续调用 `executeLinuxTool`；transport 选择下沉 |
| `server/src/gateway/policy.ts` | 注册 Phase 2 Linux MCP 工具到 `ALL_TOOLS` |
| `server/src/skills/linux/tools.ts` | 重构：local / MCP / SSH 三路路由 |
| `server/src/skills/linux/remoteExecutor.ts` | 保留 SSH 路径；暴露给 MCP Client Router fallback |
| `server/src/index.ts` | 新增启动入口：若 `MCP_SERVER_MODE=true` 则启动 standalone MCP server |

## Proto 设计

```protobuf
syntax = "proto3";
package infrapilot.linux;

service LinuxDiagnostic {
  rpc GetCpuUsage(CpuRequest) returns (CpuResponse);
  rpc GetMemoryInfo(MemoryRequest) returns (MemoryResponse);
  rpc GetDiskUsage(DiskRequest) returns (DiskResponse);
  rpc GetNetworkStats(NetworkRequest) returns (NetworkResponse);
  rpc GetProcessInfo(ProcessRequest) returns (ProcessResponse);
  rpc TailSyslog(SyslogRequest) returns (SyslogResponse);
  rpc RestartService(ServiceRequest) returns (ServiceResponse);
  rpc KillProcess(KillRequest) returns (KillResponse);
  rpc Health(HealthRequest) returns (HealthResponse);
}

message CpuRequest { string host = 1; int32 top_n = 2; }
message CpuResponse {
  bool success = 1;
  double usage_percent = 2;
  repeated ProcessInfo top_processes = 3;
  string error = 4;
  int32 duration_ms = 5;
}

message ProcessInfo {
  int32 pid = 1;
  string cmd = 2;
  double cpu_percent = 3;
  int64 rss_mb = 4;
}

message MemoryRequest { string host = 1; int32 pid = 2; }
message MemoryResponse {
  bool success = 1;
  int64 total_mb = 2;
  int64 used_mb = 3;
  int64 available_mb = 4;
  string oom_history = 5;
  ProcessMemory process_detail = 6;
  string error = 7;
  int32 duration_ms = 8;
}

message ProcessMemory {
  int32 pid = 1;
  int64 rss_mb = 2;
  int64 vm_size_mb = 3;
}

message DiskRequest { string host = 1; }
message DiskResponse {
  bool success = 1;
  repeated DiskInfo disks = 2;
  string error = 3;
  int32 duration_ms = 4;
}

message DiskInfo {
  string filesystem = 1;
  int64 size_mb = 2;
  int64 used_mb = 3;
  int64 available_mb = 4;
  double use_percent = 5;
  string mounted_on = 6;
}

message NetworkRequest { string host = 1; string iface = 2; }
message NetworkResponse {
  bool success = 1;
  int32 total_connections = 2;
  int32 tcp_established = 3;
  int32 tcp_time_wait = 4;
  repeated InterfaceStats interfaces = 5;
  string error = 6;
  int32 duration_ms = 7;
}

message InterfaceStats {
  string name = 1;
  int64 rx_bytes = 2;
  int64 tx_bytes = 3;
  int64 rx_errors = 4;
  int64 tx_errors = 5;
}

message ProcessRequest { string host = 1; string name_pattern = 2; }
message ProcessResponse {
  bool success = 1;
  repeated ProcessInfo processes = 2;
  string error = 3;
  int32 duration_ms = 4;
}

message SyslogRequest { string host = 1; int32 lines = 2; }
message SyslogResponse {
  bool success = 1;
  repeated string lines = 2;
  string error = 3;
  int32 duration_ms = 4;
}

message ServiceRequest { string host = 1; string service_name = 2; }
message ServiceResponse {
  bool success = 1;
  string stdout = 2;
  string stderr = 3;
  int32 exit_code = 4;
  string error = 5;
  int32 duration_ms = 6;
}

message KillRequest { string host = 1; int32 pid = 2; string signal = 3; }
message KillResponse {
  bool success = 1;
  string stdout = 2;
  string stderr = 3;
  int32 exit_code = 4;
  string error = 5;
  int32 duration_ms = 6;
}

message HealthRequest {}
message HealthResponse { bool ok = 1; string version = 2; }
```

## 核心模块设计

### 1. MCP Client Router（`server/src/mcp/client.ts`）

```typescript
export async function executeLinuxToolOnHost(
  tool: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult>;
```

路由逻辑：
1. 读取 `args.host`。
2. 调用 `discoverTransport(host)` 获取 `HostTransport`。
3. 若 `mcpEnabled && health.ok`：走 gRPC client。
4. 否则若 `sshFallback && tool 是 readonly`：走 SSH Proxy。
5. 否则返回错误 `该主机未注册 MCP Agent 且无 SSH fallback`。
6. 统一返回 `ToolExecutionResult`，并在 `meta.transport` 中记录 `grpc` 或 `ssh_proxy`。

### 2. gRPC Client（`server/src/mcp/grpcClient.ts`）

- 使用 `@grpc/proto-loader` 加载 `proto/linux_diagnostic.proto`。
- 创建 `LinuxDiagnostic` client。
- 每个 RPC 调用携带 metadata：`authorization: Bearer <JWT>`。
- mTLS：从环境变量/文件加载 client cert/key/ca，构造 `grpc.credentials.createSsl()`。
- 超时：默认 10s，变更类 30s。

### 3. Auth（`server/src/mcp/auth.ts`）

服务端：
- 校验 metadata `authorization` Bearer token。
- JWT payload：`{ sub: "<session-id>", aud: "linux-mcp-server", tools: ["get_cpu_usage"], exp: <now+5min> }`。
- 可选 mTLS：server credentials 要求 client cert。

客户端：
- 从 Vault/环境变量获取短期 JWT（MVP 可先由主 server 本地签发）。
- 构造 `grpc.Metadata` 注入 token。

### 4. Server 实现（`server/src/mcp/server/service.ts`）

每个 RPC handler：
1. 校验 JWT scope（是否允许调用该 tool）。
2. 执行对应本地命令（复用现有 `localRunner.ts` 逻辑或新 `runner.ts`）。
3. 解析 stdout 为结构化 proto 消息。
4. 对 stdout/stderr 调用 `redact()` 脱敏。
5. 输出 `[MCP_AUDIT]` 日志。
6. 返回 proto response。

变更类命令白名单：
- `restart_service`：仅允许 `systemctl restart <service>`，service 名来自允许列表（如 `nginx`, `docker`, `kubelet`）。
- `kill_process`：仅允许 `kill -<signal> <pid>`，signal ∈ {TERM, HUP, USR1, USR2}，禁止 KILL 默认需审批。

### 5. Discovery（`server/src/mcp/discovery.ts`）

支持两种来源：
1. 环境变量 `MCP_ENDPOINTS`：JSON map `{ "node-1": "dns:///linux-mcp-server-node-1:8443", ... }`。
2. K8s Headless Service 自动发现：`dns:///linux-mcp-server.<node-name>.infrapilot-mcp.svc.cluster.local:8443`。
3. 回退：查询 SSH Host Registry，若存在则 `sshFallback=true`。

## 与现有系统集成

### Command Gateway

`commandGateway.ts` 的 `dispatch()` 不变：

```typescript
case "linux":
  return executeLinuxTool(tool, args);
```

`executeLinuxTool` 内部完成 MCP/SSH 选择。审批、审计、风险分级完全复用现有 Policy Engine。

### Policy Engine

在 `policy.ts` 中新增 Linux MCP 工具定义：

```typescript
{ name: "get_network_stats", skill: "linux", risk: "readonly", ... }
{ name: "restart_service", skill: "linux", risk: "high", ... }
{ name: "kill_process", skill: "linux", risk: "high", ... }
```

`restart_service` 和 `kill_process` 需要 `approvedBy` 才能执行。

### SSH Fallback

当主机无 MCP Agent 时，只读工具自动降级到 SSH Proxy；变更类工具不降级，避免 SSH 通道执行高危操作且绕过 MCP 审计。

## 部署方案

### 1. Kubernetes DaemonSet

每个节点部署一个 `linux-mcp-server` Pod：
- `hostPID: false`，挂载 `/proc`、`/sys`、`/var/log` 只读。
- 需要网络诊断时赋予 `CAP_NET_RAW`（可选）。
- 监听 `8443`，mTLS 双向认证。
- Headless Service 提供按节点 DNS：`linux-mcp-server-<node>.infrapilot-mcp.svc.cluster.local`。

### 2. 证书管理

使用 cert-manager：
- `ClusterIssuer` 签发 server cert。
- server cert 包含 SAN：`linux-mcp-server.<namespace>.svc.cluster.local`、节点 hostname。
- client cert 由主 server 所在 namespace 的 cert-manager 签发，挂载到主 server Pod。

### 3. 主 Server 配置

```yaml
env:
  - name: MCP_ENDPOINTS
    value: '{"node-1":"dns:///linux-mcp-server-node-1.infrapilot-mcp.svc.cluster.local:8443"}'
  - name: MCP_SERVER_CA_PATH
    value: /etc/mcp/tls/ca.crt
  - name: MCP_CLIENT_CERT_PATH
    value: /etc/mcp/tls/client.crt
  - name: MCP_CLIENT_KEY_PATH
    value: /etc/mcp/tls/client.key
  - name: MCP_JWT_SECRET
    valueFrom:
      secretKeyRef:
        name: mcp-jwt
        key: secret
```

## 测试策略

### 单元测试

| 测试文件 | 覆盖 |
|---|---|
| `server/src/mcp/client.test.ts` | transport 选择、MCP 失败 fallback SSH、变更类不降级 |
| `server/src/mcp/grpcClient.test.ts` | JWT metadata 注入、超时处理、连接错误 |
| `server/src/mcp/server/service.test.ts` | 各 RPC 结构化输出、命令白名单、JWT scope 拒绝 |
| `server/src/mcp/auth.test.ts` | JWT 签发/校验/过期、工具 scope 校验 |

### 集成测试

- 启动 in-process gRPC server（绑定到随机端口）。
- 调用所有只读 RPC，验证返回 JSON schema。
- 调用变更类 RPC，验证服务端执行结果。

### E2E 测试

- 条件运行：`RUN_MCP_E2E=true`。
- 启动 standalone `linux-mcp-server`。
- 主 server 通过 gRPC + mTLS + JWT 调用。
- 验证：CPU/内存/磁盘/网络/进程/syslog，以及 restart_service 审批链路。

## 实施顺序

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| W1 | proto 定义、gRPC server/client 骨架、本地 in-process 启动 | `Health` RPC 通过 |
| W1 | 只读工具迁移到 gRPC handlers（CPU/内存/磁盘/网络/进程/syslog） | 所有只读 RPC 返回结构化数据 |
| W2 | mTLS + JWT 双向认证 | 无 cert/token 调用返回 UNAUTHENTICATED |
| W2 | 变更类工具（restart_service / kill_process）+ 服务端白名单 | 需审批，服务名/PID 受控 |
| W3 | MCP Client Router + SSH fallback | 无 MCP 主机自动 fallback SSH；变更类不降级 |
| W3 | K8s DaemonSet / Service / RBAC / cert-manager 配置 | `kubectl apply` 后 Pod Running |
| W4 | 单元/集成/E2E 测试补齐 + 文档更新 | `npm test` 全绿；`RUN_MCP_E2E=true` 通过 |

## 验证步骤

1. **本地启动 standalone server**
   ```bash
   MCP_SERVER_MODE=true npm run dev
   ```
2. **Health check**
   ```bash
   grpcurl -cacert ca.crt -cert client.crt -key client.key \
     -H "authorization: Bearer $JWT" \
     localhost:8443 infrapilot.linux.LinuxDiagnostic/Health
   ```
3. **调用 CPU 诊断**
   ```bash
   grpcurl -cacert ca.crt -cert client.crt -key client.key \
     -H "authorization: Bearer $JWT" \
     -d '{"host":"local","top_n":5}' \
     localhost:8443 infrapilot.linux.LinuxDiagnostic/GetCpuUsage
   ```
4. **Linux Skill 路由测试**
   ```bash
   npm test
   ```
5. **端到端测试**
   ```bash
   RUN_MCP_E2E=true npm test
   ```
6. **K8s 部署验证**
   ```bash
   kubectl apply -f server/k8s-manifests/linux-mcp-server/
   kubectl get pods -n infrapilot-mcp
   ```

## 风险与应对

| 风险 | 应对 |
|---|---|
| gRPC 调试链路复杂 | 提供 `grpcurl` 示例；server 输出详细 audit log |
| mTLS 证书轮转 | cert-manager 自动轮转；server/client 监听 cert 文件变化 |
| 变更类命令误执行 | Command Gateway 审批 + server 白名单 + JWT tool scope 三重校验 |
| 节点 Agent 全部不可达 | 保留 SSH fallback 用于只读诊断；变更类拒绝执行 |
| proto 变更导致不兼容 | 使用 proto3，字段只增不减；client/server 同时升级 |

## 决策总结

- **协议**：gRPC（严格对齐设计文档）。
- **运行模式**：in-process（开发调试）+ standalone（K8s DaemonSet/VM Agent）。
- **安全**：mTLS 双向认证 + 短期 JWT（tool scope + exp ≤ 5min）。
- **工具范围**：只读诊断 + 变更类（restart_service / kill_process）。
- **降级**：保留 SSH Proxy 作为只读诊断 fallback；变更类不降级。
