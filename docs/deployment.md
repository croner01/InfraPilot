# InfraPilot 部署指南

本文档覆盖 **本地开发**、**容器镜像构建** 与 **Kubernetes 生产部署** 三种方式。

## 1. 环境要求

- Node.js 22（仅本地开发需要）
- k3s / Kubernetes 1.28+
- DeepSeek/Groq API Key（`GSK_API_KEY`）
- （可选）OpenSearch / Elasticsearch（用于 ELK Skill）
- （可选）ClickHouse（用于 ClickHouse Skill，位于 `islap` 命名空间时会自动发现）

## 2. 部署架构

```text
┌─────────────────┐
│   用户浏览器     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────────────────────┐
│  infrapilot-web │────▶│  infrapilot-server (Deployment)│
│   (React + Vite)│     │  - HTTP API / WebSocket        │
└─────────────────┘     │  - Agent / LLM / Skill 路由    │
                        │  - MCP Client / SSH Proxy      │
                        └──────────────┬───────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │ gRPC (MCP)                │ SSH                       │ K8s API
           ▼                           ▼                           ▼
┌─────────────────────┐    ┌─────────────────┐         ┌─────────────────┐
│ linux-mcp-server    │    │ 远程主机/VM      │         │ k3s / Kubernetes │
│ (DaemonSet, 每节点)  │    │ (SSH Proxy)     │         │ (K8s Skill)     │
└─────────────────────┘    └─────────────────┘         └─────────────────┘
```

## 3. 本地开发部署

```bash
# 1. 后端
cd server
npm install
export GSK_API_KEY="your-key"
npm run dev          # http://localhost:8787

# 2. 前端（另一个终端）
cd web
npm install
npm run dev          # http://localhost:5173
```

前端 dev server 已配置代理，所有 `/api` 与 `/ws` 请求会转发到 `http://localhost:8787`。

## 4. 本地开发连接远程主机

本地 `npm run dev` 时，后端同样可以通过 **SSH Proxy** 或 **linux-mcp-server** 连接到远程设备。

### 4.1 方式一：SSH Proxy（Phase 1，只读命令）

启动后端前注入 `SSH_HOSTS` 或配置文件：

```bash
export SSH_HOSTS='{
  "hosts": [
    {
      "name": "node-1",
      "hostname": "192.168.3.100",
      "port": 22,
      "username": "ops",
      "auth": { "type": "privateKey", "privateKeyPath": "/home/ops/.ssh/id_ed25519" }
    }
  ]
}'

npm run dev
```

或使用配置文件（推荐）：

```bash
export SSH_HOSTS_CONFIG=/root/InfraPilot/server/config/ssh-hosts.yaml
npm run dev
```

配置文件示例见 `server/config/ssh-hosts.yaml.example`。

### 4.2 方式二：linux-mcp-server（Phase 2，推荐）

在目标主机上启动 MCP server：

```bash
# 在远程主机 node-1 上（已安装本项目依赖）
MCP_SERVER_MODE=true npm run mcp-server
# [linux-mcp-server] listening on :8443 (credentials=insecure)
```

然后在 InfraPilot 后端配置 endpoint 映射：

```bash
export MCP_ENDPOINTS='{"node-1":"192.168.3.100:8443"}'
export MCP_JWT_SECRET='your-shared-secret'   # 与服务端保持一致
npm run dev
```

JSON 示例见 `server/config/mcp-endpoints.json.example`。

### 4.3 Agent 使用方式

Agent/前端调用方式不变，只需在参数中指定 `host`：

```json
{
  "skill": "linux",
  "tool": "get_cpu_usage",
  "args": { "host": "node-1" }
}
```

后端会优先尝试 MCP；如果 MCP 不可用且是只读工具，则降级到 SSH；变更类工具（`restart_service` / `kill_process`）只允许通过 MCP 执行。

## 5. 容器镜像构建

### 5.1 后端镜像

```bash
cd server
docker build -t infrapilot-server:latest .
```

### 5.2 前端镜像

```bash
cd web
docker build -t infrapilot-web:latest .
```

### 5.3 linux-mcp-server 镜像

```bash
cd server
docker build -f Dockerfile.mcp -t infrapilot/linux-mcp-server:latest .
```

### 5.4 加载镜像到 k3s 节点

如果 k3s 使用 containerd，执行：

```bash
docker save infrapilot-server:latest | k3s ctr images import -
docker save infrapilot-web:latest | k3s ctr images import -
docker save infrapilot/linux-mcp-server:latest | k3s ctr images import -
```

如果是多节点集群，请推送到私有镜像仓库并修改镜像名。

## 6. Kubernetes 部署

### 6.1 部署后端与前端

```bash
kubectl apply -f server/k8s-manifests/infrapilot-server/
kubectl apply -f web/k8s-manifests/
```

### 6.2 配置密钥

编辑：

- `server/k8s-manifests/infrapilot-server/secret.yaml`

替换：

- `GSK_API_KEY`：LLM API Key
- `MCP_JWT_SECRET`：MCP 服务端/客户端共享的 JWT 签名密钥（生产务必使用强随机字符串）

然后重新 apply：

```bash
kubectl apply -f server/k8s-manifests/infrapilot-server/secret.yaml
```

### 6.3 配置 MCP endpoint 映射（可选）

编辑 `server/k8s-manifests/infrapilot-server/configmap.yaml`：

```yaml
MCP_ENDPOINTS: |-
  {
    "node-1": "10.0.0.11:8443",
    "node-2": "10.0.0.12:8443"
  }
```

> `linux-mcp-server` DaemonSet 默认使用 `hostNetwork: true` + `hostPort: 8443`，因此可直接使用节点 IP。

### 5.4 部署 linux-mcp-server 常驻 Agent

```bash
kubectl apply -f server/k8s-manifests/linux-mcp-server/
```

验证：

```bash
kubectl get pods -n infrapilot-mcp -o wide
```

### 5.5 验证服务

```bash
kubectl get pods -n infrapilot
kubectl get svc -n infrapilot
```

后端服务名：`infrapilot-server:8787`  
前端服务名：`infrapilot-web:80`

## 7. 访问前端

在集群内可通过 port-forward 临时访问：

```bash
kubectl port-forward -n infrapilot svc/infrapilot-web 8080:80
```

浏览器打开 http://localhost:8080。

生产环境建议通过 Ingress 暴露 `infrapilot-web` Service，并配置 TLS。

## 6. 与 OpenSearch / ClickHouse 的集成

- **OpenSearch**：LogShipper 默认向 `http://opensearch:9200` 推送日志（可通过环境变量覆盖）。如需使用 ELK Skill，请确保集群内存在可访问的 OpenSearch 服务。
- **ClickHouse**：ClickHouse Skill 默认自动发现 `clickhouse.islap.svc.cluster.local`。若 ClickHouse 部署在 `islap` 命名空间，无需额外配置。

## 9. 远程设备命令执行

部署后，Linux Skill 支持三种执行通道：

1. `host="local"`：在 InfraPilot Server 容器内执行。
2. `host=<MCP endpoint 别名>`：优先通过 `linux-mcp-server` gRPC 调用。
3. `host=<SSH Host Registry 别名>`：无 MCP Agent 时只读工具降级到 SSH Proxy。

SSH 主机注册表可通过 `SSH_HOSTS` 环境变量或 `SSH_HOSTS_CONFIG` 配置，详见 `docs/ssh-proxy-linux-remote.md`。

## 10. 升级与回滚

升级服务端：

```bash
cd server
docker build -t infrapilot-server:latest .
docker save infrapilot-server:latest | k3s ctr images import -
kubectl rollout restart deployment/infrapilot-server -n infrapilot
```

回滚：

```bash
kubectl rollout undo deployment/infrapilot-server -n infrapilot
```
