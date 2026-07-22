# InfraPilot Phase 2：linux-mcp-server 常驻 Agent

## 1. 概述

Phase 2 引入 **linux-mcp-server** 常驻 Agent，作为 DaemonSet/VM Agent 部署在每台 Linux 主机上，通过 **gRPC + 可选 mTLS + 短期 JWT** 提供结构化诊断接口，替代裸 shell 执行；同时保留 Phase 1 的 SSH Proxy 作为无 Agent 主机的降级通道。

```text
InfraPilot Main Server
├─ Orchestrator / Agent
├─ Policy Engine (risk/approval)
├─ Command Gateway (dispatch + audit)
└─ MCP Client Router
    ├─ gRPC transport → linux-mcp-server (preferred)
    └─ SSH Proxy fallback (Phase 1)

         mTLS + short-lived JWT
linux-mcp-server (per-host DaemonSet/VM Agent)
├─ gRPC service: LinuxDiagnostic
├─ local command handlers (structured output)
├─ command allowlist + audit log
└─ JWT auth + optional mTLS server auth
```

## 2. 与 Phase 1 SSH Proxy 的关系

- **MCP 优先**：若主机注册了 MCP endpoint 且健康检查通过，则走 gRPC。
- **SSH fallback**：无 MCP Agent 时，只读工具自动降级到 SSH Proxy；变更类工具（`restart_service`、`kill_process`）不降级，避免绕过 MCP 审计。
- **统一入口**：Skill 层仍调用 `executeLinuxTool(tool, args)`，`args.host` 决定执行位置。

## 3. 本地启动 standalone MCP server

在 `server/` 目录下：

```bash
npm run mcp-server
```

等价于：

```bash
MCP_SERVER_MODE=true tsx src/index.ts
```

日志示例：

```text
[linux-mcp-server] listening on :8443 (credentials=insecure)
```

> 默认使用 insecure gRPC，仅用于开发/sandbox。生产请配置 mTLS。

## 4. 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `MCP_SERVER_MODE` | 是否以 standalone MCP server 模式启动 | `false` |
| `MCP_SERVER_PORT` | gRPC 监听端口 | `8443` |
| `MCP_JWT_SECRET` | JWT 签名密钥 | `infrapilot-mcp-dev-secret-do-not-use-in-production` |
| `MCP_ENDPOINTS` | 主 server 端 MCP endpoint 映射，JSON 格式 | `"{}"` |
| `MCP_DISABLE_SSH_FALLBACK` | 禁用 SSH fallback | `false` |
| `MCP_PROTO_PATH` | proto 文件绝对路径 | 自动搜索 |
| `MCP_SERVER_CA_PATH` / `MCP_SERVER_CERT_PATH` / `MCP_SERVER_KEY_PATH` | 服务端 mTLS 证书 | 未设置则 insecure |
| `MCP_CA_PATH` / `MCP_CERT_PATH` / `MCP_KEY_PATH` | 客户端 mTLS 证书（别名） | 未设置则 insecure |

主 server 配置示例：

```bash
export MCP_ENDPOINTS='{"node-1":"10.0.0.11:8443","node-2":"10.0.0.12:8443"}'
export MCP_JWT_SECRET='change-me-in-production'
```

## 5. 使用 grpcurl 调用

### 5.1 insecure 模式

```bash
# 生成 JWT（可临时用 node 脚本调用 signMcpJwt）
export TOKEN=$(node -e "const {signMcpJwt}=require('./dist/mcp/auth.js'); console.log(signMcpJwt({sessionId:'cli',tools:['get_cpu_usage']}))")

grpcurl -plaintext \
  -H "authorization: Bearer $TOKEN" \
  -d '{"host":"local","top_n":3}' \
  localhost:8443 infrapilot.linux.LinuxDiagnostic/GetCpuUsage
```

### 5.2 mTLS 模式

```bash
grpcurl -cacert ca.crt -cert client.crt -key client.key \
  -H "authorization: Bearer $TOKEN" \
  -d '{"host":"local","top_n":3}' \
  localhost:8443 infrapilot.linux.LinuxDiagnostic/GetCpuUsage
```

## 6. 容器镜像

远端节点没有 Node/npm 时，使用 Dockerfile 打包：

```bash
cd server
docker build -f Dockerfile.mcp -t infrapilot/linux-mcp-server:latest .

# 导入 k3s
k3s ctr images import <(docker save infrapilot/linux-mcp-server:latest)
```

镜像说明：

- 基于 `server/Dockerfile.mcp`，默认 `MCP_SERVER_MODE=true`。
- 包含 `top/ps/free`、`ss/ip`、`systemctl` 等诊断工具。
- 配合 DaemonSet 的 `hostPID: true` / `hostNetwork: true` / `privileged: true`，可以采集并操作宿主机。

## 7. Kubernetes 部署

### 7.1 部署清单

清单位于 `server/k8s-manifests/linux-mcp-server/`：

| 文件 | 说明 |
|---|---|
| `namespace.yaml` | 命名空间 `infrapilot-mcp` |
| `serviceaccount.yaml` | ServiceAccount |
| `rbac.yaml` | 最小 RBAC（读取 nodes） |
| `service.yaml` | Headless Service |
| `daemonset.yaml` | 每个节点部署一个 Agent |
| `secret.yaml` | JWT secret 示例 |
| `cert-issuer.yaml` | cert-manager mTLS 示例（可选） |

### 7.2 快速部署

```bash
kubectl apply -f server/k8s-manifests/linux-mcp-server/
kubectl get pods -n infrapilot-mcp -o wide
```

默认使用 **insecure gRPC**；如需启用 mTLS：

1. 安装 cert-manager。
2. 取消 `cert-issuer.yaml` 注释并 apply。
3. 取消 `daemonset.yaml` 中 TLS 环境变量与卷挂载的注释。
4. 为主 server 配置客户端证书：

```bash
export MCP_SERVER_CA_PATH=/etc/mcp/tls/ca.crt
export MCP_CLIENT_CERT_PATH=/etc/mcp/tls/client.crt
export MCP_CLIENT_KEY_PATH=/etc/mcp/tls/client.key
```

### 7.3 主 server 映射节点

DaemonSet 使用 `hostNetwork: true` + `hostPort: 8443`，每个节点在 `8443` 端口暴露服务。主 server 通过 `MCP_ENDPOINTS` 按别名映射到节点 IP：

```bash
export MCP_ENDPOINTS='{
  "node-1": "10.0.0.11:8443",
  "node-2": "10.0.0.12:8443"
}'
```

### 7.4 Headless Service DNS 自动发现（暂不实现）

`service.yaml` 中保留了一个 Headless Service，用于未来通过 K8s DNS 自动发现各节点上的 `linux-mcp-server` Pod。当前版本主 server 仍通过 `MCP_ENDPOINTS` 显式映射节点 IP，Headless Service DNS 自动发现被标记为**低优先级**，暂不实现。后续如引入该能力，需要解决：

- DNS 缓存与 Pod 重建后的 TTL 刷新
- 节点级工具调用需绑定到正确的节点身份
- 与 mTLS 证书 SAN 的匹配策略

### 7.5 能否执行宿主机命令？

可以，但需要合理的权限和挂载。

`daemonset.yaml` 已经做了以下配置：

| 配置 | 作用 |
|---|---|
| `hostPID: true` | 与宿主机共享进程命名空间，`ps/top` 看到的是宿主机进程 |
| `hostNetwork: true` | 与宿主机共享网络命名空间，`ss/ip` 看到的是宿主机网络 |
| `privileged: true` | 拥有足够权限执行 `dmesg`、访问 `/proc`、`systemctl` 等 |
| 挂载 `/proc` | `top/ps/free` 读取宿主机进程信息 |
| 挂载 `/sys` | 读取硬件/内核信息 |
| 挂载 `/var/log` | `tail_syslog` 读取宿主机日志 |
| 挂载 `/run/systemd` | `systemctl` 通过 D-Bus 与宿主机 systemd 通信 |

因此，以 Pod 运行的 `linux-mcp-server` 本质上是一个节点 Agent，能够像节点上的守护进程一样诊断甚至重启宿主机服务。这是设计意图，但这也意味着它拥有较高的节点级权限，生产环境务必：

- 只给 DaemonSet 授予以下的最小 RBAC（已在 `rbac.yaml` 中配置）。
- 不要在 DaemonSet 里运行其他无关业务容器。
- 生产环境启用 mTLS 和强 JWT Secret。
- 考虑使用 seccomp/AppArmor/SELinux 进一步限制容器能力。

## 8. 安全设计

1. **MCP 优先、SSH fallback 仅只读**：变更类命令不降级到 SSH。
2. **JWT scope**：每个 token 只包含允许调用的工具列表，服务端校验 `aud=linux-mcp-server`。
3. **命令白名单**：`run_command` 与封装工具只执行 `cat/less/ls/ps/ss/ip/df/free/dmesg/journalctl/systemctl/kubectl/crictl/docker` 等只读命令。`systemctl restart` 等变更子命令被显式拦截。
4. **扩展白名单**：通过环境变量 `MCP_COMMAND_ALLOWLIST=cmd1,cmd2` 可在不改动代码的前提下新增允许的命令。
5. **审计双写**：MCP server 输出 `[MCP_AUDIT]` JSON 到 stderr；Command Gateway 写入 SQLite `audit_log`。
6. **审批链路**：变更类工具在 Policy Engine 中标记为 `high`，需经 Command Gateway 审批。

## 9. 测试

### 9.1 单元/集成测试

```bash
cd server
npm run test
```

当前覆盖：

- `src/skills/linux/tools.test.ts` — Linux Skill 本地/远程路由
- `src/mcp/client.test.ts` — MCP Client Router
- `src/mcp/grpcClient.test.ts` — gRPC 客户端
- `src/mcp/server/service.test.ts` — gRPC 服务端集成
- `src/mcp/server/runner.test.ts` — 本地命令执行与白名单
- `src/mcp/auth.test.ts` — JWT / TLS credentials

### 9.2 E2E 测试

```bash
RUN_MCP_E2E=true npm run test
```

E2E 会启动 standalone `linux-mcp-server` 子进程并验证 health 与 `GetCpuUsage`。

## 10. 工具列表

| 工具 | 风险等级 | 执行通道 | 说明 |
|---|---|---|---|
| `get_cpu_usage` | readonly | MCP / SSH fallback | CPU 使用率与 Top 进程 |
| `get_memory_info` | readonly | MCP / SSH fallback | 内存、OOM 历史、进程内存详情 |
| `get_disk_usage` | readonly | MCP / SSH fallback | 磁盘使用率 |
| `get_network_stats` | readonly | MCP / SSH fallback | 连接数、TCP 状态、接口统计 |
| `get_process_info` | readonly | MCP / SSH fallback | 按名称查找进程 |
| `tail_syslog` | readonly | MCP / SSH fallback | 系统日志 |
| `run_command` | readonly | MCP / SSH fallback | 执行白名单内任意 Linux/K8s 诊断命令 |
| `read_file` | readonly | MCP / SSH fallback | 读取文件内容（`cat` 封装） |
| `tail_file` | readonly | MCP / SSH fallback | 读取文件尾部 N 行（`tail` 封装） |
| `list_directory` | readonly | MCP / SSH fallback | 列出目录内容（`ls -la` 封装） |
| `check_service_status` | readonly | MCP / SSH fallback | 查看服务状态（`systemctl status` 封装） |
| `get_kubernetes_resource` | readonly | MCP / SSH fallback | `kubectl get` 封装 |
| `describe_kubernetes_resource` | readonly | MCP / SSH fallback | `kubectl describe` 封装 |
| `get_pod_logs` | readonly | MCP / SSH fallback | `kubectl logs` 封装 |
| `restart_service` | high | MCP only | 重启白名单服务，需审批 |
| `kill_process` | high | MCP only | 向 PID 发送白名单信号，需审批 |

## 11. 故障排查

### 11.1 主 server 无法连接 MCP Agent

- 检查 `MCP_ENDPOINTS` 配置是否正确。
- 在 Agent 节点执行 `ss -ltnp | grep 8443` 确认端口监听。
- 查看 MCP server Pod 日志：

```bash
kubectl logs -n infrapilot-mcp daemonset/linux-mcp-server
```

### 11.2 JWT 校验失败

- 确认主 server 与 MCP server 的 `MCP_JWT_SECRET` 一致。
- 使用 `signMcpJwt` 签发 token 时，`tools` 数组必须包含要调用的工具名。

### 11.3 mTLS 证书错误

- 确认 ca/cert/key 文件存在且为 PEM 格式。
- 确认 server cert 的 SAN 包含访问地址。
