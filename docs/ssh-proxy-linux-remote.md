# SSH Proxy 远程主机命令执行

> 对应设计文档：§7.1 linux-mcp-server、§8.3 安全网关、§13.2 部署架构

## 1. 功能概述

本功能实现了 Linux Skill 对**远程主机**执行只读诊断命令的能力。

- 当 `host="local"` 时，命令在 InfraPilot 后端所在主机本地执行（原有行为）。
- 当 `host` 为 Host Registry 中注册的主机别名时，命令通过 **SSH Proxy** 路由到目标主机执行。

Agent、Prompt、前端 UI 无需改动，`host` 参数自然从 `"local"` 扩展到任意已注册主机。

## 2. 架构

```text
用户/Agent
   │
   ▼
Linux Skill (server/src/skills/linux/tools.ts)
   │
   ▼
remoteExecutor (server/src/skills/linux/remoteExecutor.ts)
   │ host="local"          │ host="node-1"
   ▼                       ▼
localRunner              SSH Proxy (server/src/gateway/sshProxy.ts)
(本机 execFile)              │
                             ▼
                        ssh2 Client
                             │
                             ▼
                        目标远程主机
                             │
                             ▼
                        Host Registry (server/src/gateway/sshHosts.ts)
                        提供 IP/端口/用户名/私钥/密码
```

**安全关键点**：
- SSH Proxy 是项目中**唯一直接持有 SSH 私钥/密码**的模块。
- Agent 不直接接触凭据，只传递 `host` 和命令参数。
- 所有命令必须先通过**白名单校验**。
- 输出结果经过 `redact()` 脱敏处理。

## 3. 配置文件

### 3.1 配置文件方式（推荐）

创建 `/etc/infrapilot/ssh-hosts.yaml` 或 `.json`：

```yaml
hosts:
  - name: node-1
    hostname: 192.168.1.10
    port: 22
    username: ops
    auth:
      type: privateKey
      privateKeyPath: /etc/infrapilot/keys/node1
      # 或 privateKeyEnv: NODE1_SSH_KEY

  - name: network-node-2
    hostname: 192.168.1.11
    port: 22
    username: ops
    auth:
      type: password
      passwordEnv: NODE2_PASSWORD

  - name: k8s-master-1
    hostname: 10.0.0.5
    username: root
    auth:
      type: agent
```

### 3.2 环境变量方式（适合容器/CI）

```bash
export SSH_HOSTS='{
  "hosts": [
    {
      "name": "node-1",
      "hostname": "192.168.1.10",
      "username": "ops",
      "auth": { "type": "privateKey", "privateKeyEnv": "NODE1_SSH_KEY" }
    }
  ]
}'
```

### 3.3 配置优先级

1. `SSH_HOSTS` 环境变量
2. `SSH_HOSTS_CONFIG` 环境变量指定的文件
3. `/etc/infrapilot/ssh-hosts.yaml` / `.yml` / `.json`
4. 空注册表（仅支持 `local`）

## 4. 环境变量

| 变量 | 说明 |
|---|---|
| `SSH_HOSTS` | JSON 格式的主机注册表 |
| `SSH_HOSTS_CONFIG` | 配置文件路径 |
| `SSH_COMMAND_ALLOWLIST` | 逗号分隔的允许命令列表，覆盖默认白名单 |
| `CLICKHOUSE_*` | ClickHouse 连接配置（与本功能无关，保留说明） |

## 5. 命令白名单

默认只允许只读诊断命令：

```text
top, htop, ps, free, vmstat, mpstat, iostat, pidstat, df, du, lsblk, fdisk, ls,
dmesg, journalctl, uptime, uname, cat, tail, head, grep, zgrep,
ss, netstat, ip, ifconfig, ping, traceroute, nslookup, dig, curl, wget,
systemctl, service, virsh, ovs-vsctl, ovs-ofctl, brctl, ipvsadm,
find, lsof, stat, file,
sleep, echo
```

`systemctl` 仅允许 `status` / `is-active` / `is-enabled` / `is-failed` 等只读子命令，禁止 `restart` / `stop` / `start` / `reload` / `enable` / `disable` / `mask` / `unmask`。

如需扩展白名单：

```bash
export SSH_COMMAND_ALLOWLIST="top,ps,free,df,dmesg,custom-readonly-cmd"
```

## 6. 前端/Agent 使用

Agent 调用方式不变，只需在参数中指定 `host`：

```json
{
  "skill": "linux",
  "tool": "get_cpu_usage",
  "args": { "host": "node-1" }
}
```

或本机：

```json
{
  "skill": "linux",
  "tool": "get_cpu_usage",
  "args": { "host": "local" }
}
```

## 7. 审计日志

远程命令执行会产生两层审计：

1. **SSH Proxy 层审计**（`server/src/gateway/sshProxy.ts`）
   - 每次远程执行都会向 `stderr` 输出结构化 JSON 日志，包含：
     - `id`: 唯一事件 ID
     - `host`: 逻辑主机别名
     - `hostname`: 真实 SSH 地址
     - `command`: 执行的命令
     - `caller`: 调用方标识
     - `allowed`: 是否通过白名单校验
     - `success`: 执行是否成功
     - `durationMs`: 执行耗时
   - 示例：`[SSH_AUDIT] {"id":"...","host":"node-1","command":"uptime ","allowed":true,"success":true,"durationMs":50}`
   - 便于接入企业日志采集系统（ELK/Loki/Splunk）。

2. **Command Gateway 层审计**（`server/src/gateway/commandGateway.ts`）
   - 所有工具调用（包括本地和远程）都会写入 SQLite `audit_log` 表。
   - 可通过 API `/api/sessions/:id/audit` 查询会话级审计记录。

## 8. 测试

### 8.1 单元/集成测试

```bash
cd /root/InfraPilot/server
npm test
```

测试覆盖：
- Host Registry 文件/环境变量加载
- 命令白名单与危险命令拦截（含 `systemctl restart` 等危险子命令）
- 受信任的 `cmdLine` 管道模板与未授权模板拦截
- 私钥/密码/SSH Agent 连接配置与凭据环境变量解析
- SSH 连接失败、命令超时、非零退出码等错误场景
- 本地/远程路由切换
- 输出脱敏（密码、Token、私钥、身份证、AWS Key）
- Linux Skill 全部工具（CPU/内存/磁盘/进程/dmesg）

### 8.2 端到端测试（需要真实 SSH 服务）

端到端测试默认跳过，需要本地运行 SSH 服务并配置免密登录：

```bash
# 1. 确保本地 sshd 运行，且本机私钥已在 authorized_keys 中
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 root@127.0.0.1 "echo ok"

# 2. 运行端到端测试
cd /root/InfraPilot/server
RUN_E2E_TESTS=true npx vitest run src/gateway/sshProxy.e2e.test.ts
```

端到端测试会验证：
- 通过真实 SSH 连接执行 `uptime`
- 通过受信任模板执行 `top -b -n 1 | head -n 5` 管道命令
- 危险命令（如 `rm`）被拦截
- 输出脱敏生效

## 9. 生产部署建议

1. **凭据管理**：
   - 私钥文件通过 K8s Secret 挂载到 `/etc/infrapilot/keys/`
   - 密码通过环境变量或 Vault 注入
   - 最终目标：使用 Vault 动态短期凭据

2. **NetworkPolicy**：
   - SSH Proxy 只允许从 Command Gateway 访问
   - 禁止 Pod 直接访问目标主机 SSH 端口

3. **审计**：
   - SSH Proxy 层输出结构化审计日志到 stderr，接入企业日志平台。
   - Command Gateway 层写入 SQLite `audit_log`，支持会话级审计查询。
   - 记录调用方、目标主机、命令、风险等级、结果摘要。

4. **后续演进**：
   - Phase 2 将 SSH Proxy 替换/补充为 `linux-mcp-server` 常驻 Agent
   - 常驻 Agent 以 gRPC 提供结构化接口，避免裸 shell 执行

## 10. Python 后端（py-server，当前线上实现）

线上部署的是 `py-server`（FastAPI）。同一能力在 Python 侧等价实现如下：

| 文件 | 说明 |
|---|---|
| `py-server/infrapilot/remote.py` | SSH 通道：主机注册表读取、只读白名单校验、paramiko 执行、输出脱敏 |
| `py-server/infrapilot/skills/linux.py` | `execute_on_host()` 路由（local / SSH）+ `inspect_files` 工具 |
| `py-server/infrapilot/policy.py` | `host != local` 时把只读工具升级为 `medium`（强制人工审批） |
| `py-server/tests/test_remote_host.py` | 白名单/审批升级/指纹差分单元测试 |

### 10.1 审批规则（Python）

- `host="local"`：按工具声明的风险级执行（只读工具自动执行）。
- `host=<别名>` 或 `hosts` 含非 local 项：**一律要求人工审批**（`level=medium`），
  审批卡片展示 `blastRadius`（目标主机 + 只读白名单说明）与 `ssh <host> -- <cmd>` 预览。

### 10.2 `inspect_files`：跨主机宿主路径指纹差分

```jsonc
{
  "hosts": ["node-1", "node-2", "node-3"],   // Host Registry 别名，可含 "local"
  "paths": ["/usr/local/bin/helm"],          // 必须绝对路径
  "hash": false                              // true 时额外比对 sha256
}
```

返回每个主机的 `type/size/mtime/mode`（可选 `sha256`），并给出 `differing` 差异清单。
用途：当同一 Deployment 的副本"只在与某节点上崩溃"时，直接比对各节点共享的
hostPath 组件（二进制/驱动/配置）是否发生版本漂移 —— 这是"多轮排查找不到真实根因"
时最有效的判别量。

> 注意：`differing` 只在**实际比对到多个主机**时才有意义；目标主机必须能被 SSH 登录，
> 且目标节点上的路径在容器视角可读（宿主文件系统路径，而非 Pod 内路径）。

## 11. 文件清单

| 文件 | 说明 |
|---|---|
| `server/src/gateway/sshHosts.ts` | 主机注册表 |
| `server/src/gateway/sshProxy.ts` | SSH 代理核心（含审计日志） |
| `server/src/skills/linux/localRunner.ts` | 本机命令执行器 |
| `server/src/skills/linux/remoteExecutor.ts` | 本地/远程路由 |
| `server/src/skills/linux/tools.ts` | Linux Skill 工具 |
| `server/src/gateway/sshHosts.test.ts` | Host Registry 单元测试 |
| `server/src/gateway/sshProxy.test.ts` | SSH Proxy 单元/集成测试 |
| `server/src/gateway/sshProxy.e2e.test.ts` | SSH Proxy 端到端测试（需真实 sshd） |
| `server/src/skills/linux/remoteExecutor.test.ts` | 路由单元测试 |
| `server/src/skills/linux/tools.test.ts` | Linux Skill 工具单元测试 |
