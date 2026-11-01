# InfraPilot 部署指南

本文档覆盖 **本地开发**、**容器镜像构建** 与 **Kubernetes 生产部署** 三种方式。

## 1. 环境要求

- Python 3.11+（后端，`py-server/`，唯一后端）
- Node.js 22（仅前端 `web/` 构建需要）
- k3s / Kubernetes 1.28+
- DeepSeek/Groq API Key（`GSK_API_KEY`）
- （可选）OpenSearch / Elasticsearch（用于 ELK Skill 与日志采集管道）
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
                        │  - log_shipper 日志采集         │
                        └──────────────┬───────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │ MCP (HTTP JSON-RPC)       │ SSH                       │ K8s API
           ▼                           ▼                           ▼
┌─────────────────────┐    ┌─────────────────┐         ┌─────────────────┐
│ mcp-agent            │    │ 远程主机/VM      │         │ k3s / Kubernetes │
│ (DaemonSet, 每节点)   │    │ (SSH Proxy)     │         │ (K8s Skill)     │
│ /api/mcp + JWT       │    └─────────────────┘         └─────────────────┘
└─────────────────────┘
```

主 server 容器还需要只读挂载宿主机 `/var/log/pods`（采集管道读取容器 CRI 日志，
清单 `infrapilot-server/deployment.yaml` 已配置）。

## 3. 本地开发部署

```bash
# 1. 后端（Python / FastAPI）
cd py-server
pip3 install -r requirements.txt
export GSK_API_KEY="your-key"
python3 -m infrapilot      # http://localhost:8787

# 2. 前端（另一个终端）
cd web
npm install
npm run dev          # http://localhost:5173
```

> 后端数据目录默认 `py-server/data`（`INFRAPILOT_DATA_DIR` 可覆盖）；
> SKILL.md 技能包默认取 `py-server/skills`（`INFRAPILOT_SKILLS_DIR` 可覆盖）。

前端 dev server 已配置代理，所有 `/api` 与 `/ws` 请求会转发到 `http://localhost:8787`。

## 4. 本地开发连接远程主机

本地开发时，后端可以通过 **MCP Agent 通道** 或 **SSH Proxy** 连接到远程设备。

### 4.1 方式一：SSH Proxy（只读命令）

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

python3 -m infrapilot
```

或使用配置文件（推荐）：

```bash
export SSH_HOSTS_CONFIG=/root/InfraPilot/py-server/config/ssh-hosts.yaml
python3 -m infrapilot
```

配置文件示例见 `py-server/config/ssh-hosts.yaml.example`。

### 4.2 方式二：MCP Agent 通道（推荐）

在目标主机上启动 MCP Agent（同一份后端代码，HTTP 模式；无需重复安装依赖）：

```bash
# 在远程主机 node-1 上（已 pip install -r py-server/requirements.txt）
MCP_SERVER_MODE=http MCP_SERVER_PORT=8443 \
MCP_JWT_SECRET='your-shared-secret' \
python3 -m infrapilot.mcp_server
# 端点 POST /api/mcp（标准 MCP JSON-RPC 2.0）
```

然后在主 server 侧配置 endpoint 映射：

```bash
export MCP_ENDPOINTS='{"node-1":"192.168.3.100:8443"}'
export MCP_JWT_SECRET='your-shared-secret'   # 双方一致（HS256）
python3 -m infrapilot
```

JSON 示例见 `py-server/config/mcp-endpoints.json.example`。
更推荐「设置 → 主机注册表」逐主机注册（`auth.type=mcp` + `endpoint`），语义等价。

### 4.3 Agent 使用方式

Agent/前端调用方式不变，只需在参数中指定 `host`：

```json
{
  "skill": "linux",
  "tool": "get_cpu_usage",
  "args": { "host": "node-1" }
}
```

路由规则（与主机注册表逐主机匹配，不做跨通道降级）：

- `host="local"`：主 server 本机直接执行；
- 注册表 `auth.type=mcp` 的主机（或 `MCP_ENDPOINTS` 命中）：经 MCP JSON-RPC 调远端 Agent
  （转发时 `host` 归一为 `local`，由对端在本机执行）；
- 其余类型（ssh/password/privateKey/agent）：SSH Proxy 白名单**只读**诊断；
  变更类工具（`restart_service` / `kill_process`）不提供 SSH 通道执行。

## 5. 容器镜像构建

镜像统一推送到本机私有 registry（`localhost:5000`，k3s 与 registry 同机可直连）。
如需改名/换仓库，同步修改 `py-server/k8s-manifests/*/deployment.yaml`、
`py-server/k8s-manifests/mcp-agent/daemonset.yaml` 与 `web/k8s-manifests/deployment.yaml`
中的 `image` 字段。

### 5.1 后端镜像（Python / FastAPI）

```bash
# 构建上下文是 py-server/ 目录本身（后端已自包含）
docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest py-server
docker push localhost:5000/infrapilot/server:latest
```

### 5.2 前端镜像

```bash
cd web
docker build -t localhost:5000/infrapilot/web:latest .
docker push localhost:5000/infrapilot/web:latest
```

### 5.3 加载镜像到 k3s 节点

**方式一（推荐）**：推送到 `localhost:5000` registry，Deployment 用
`imagePullPolicy: Always` 自动拉取，无需在节点上导入。

```bash
# 见 5.1 / 5.2：docker build → docker push localhost:5000/infrapilot/{server,web}:latest
```

**方式二（无 registry / 多节点）**：用与 Deployment 一致的 tag 直接导入 containerd：

```bash
docker save localhost:5000/infrapilot/server:latest | k3s ctr images import -
docker save localhost:5000/infrapilot/web:latest | k3s ctr images import -
```

> 多节点集群请推送到各节点可达的私有仓库，并同步修改 Deployment 的 `image` 字段。
> 每节点的 mcp-agent 与主 server 共用同一份 `infrapilot/server` 镜像（只是启动命令/模式不同）。

## 6. Kubernetes 部署

### 6.1 部署后端与前端

```bash
kubectl apply -f py-server/k8s-manifests/infrapilot-server/
kubectl apply -f web/k8s-manifests/

# 可选：每节点 MCP Agent（远程节点执行通道，见 py-server/k8s-manifests/mcp-agent/README.md）
kubectl apply -f py-server/k8s-manifests/mcp-agent/
```

### 6.2 配置密钥

编辑 `py-server/k8s-manifests/infrapilot-server/secret.yaml` 与
`py-server/k8s-manifests/mcp-agent/secret.yaml`，替换：

- `GSK_API_KEY`：LLM API Key
- `MCP_JWT_SECRET`：MCP 服务端/客户端共享的 JWT 签名密钥（生产务必使用强随机字符串；两处必须一致）

然后重新 apply：

```bash
kubectl apply -f py-server/k8s-manifests/infrapilot-server/secret.yaml
```

### 6.3 配置 MCP endpoint 映射（可选，也可用 mcp-agent DaemonSet 后按节点 IP 直连）

编辑 `py-server/k8s-manifests/infrapilot-server/configmap.yaml`：

```yaml
data:
  MCP_ENDPOINTS: '{"node-1":"10.0.0.11:8443","node-2":"10.0.0.12:8443"}'
```

> mcp-agent DaemonSet 默认 `hostNetwork: true` + `hostPort: 8443`，因此可直接使用节点 IP。

### 6.4 验证服务

```bash
kubectl get pods -n infrapilot
kubectl get pods -n infrapilot-mcp -o wide   # 若部署了 mcp-agent
kubectl get svc -n infrapilot
```

后端服务名：`infrapilot-server:8787`；前端服务名：`infrapilot-web:80`。

## 7. 访问前端

在集群内可通过 port-forward 临时访问：

```bash
kubectl port-forward -n infrapilot svc/infrapilot-web 8080:80
```

浏览器打开 http://localhost:8080。

生产环境建议通过 Ingress 暴露 `infrapilot-web` Service，并配置 TLS。

### 7.1 NodePort 访问（单节点快速验证）

当 port-forward 不可用（如 k3s 使用 docker 运行时缺少 socat）时，可创建 NodePort Service：

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: infrapilot-web-nodeport
  namespace: infrapilot
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: infrapilot-web
  ports:
    - name: http
      port: 80
      targetPort: 80
      nodePort: 30080
EOF
```

然后通过 `http://<节点IP>:30080` 访问前端（`/api` 与 `/ws` 由 nginx 代理到后端 Service）。

### 7.2 LLM / OpenSearch 部署要点

- `OPENAI_BASE_URL` 环境变量会覆盖默认 LLM Provider 的 baseURL（`py-server/infrapilot/llm.py`），
  部署到 k3s 时在 ConfigMap 中指向实际的 DeepSeek/OpenAI 兼容端点即可；
  也可在「设置 → 模型配置」写入 runtime-config（优先级更高）。
- `OPENSEARCH_NODE` 可覆盖 ELK 数据源地址；单节点 k3s 场景可直接指向宿主机 OpenSearch 端口。

## 8. 与 OpenSearch / ClickHouse 的集成

- **OpenSearch**：日志采集管道（`infrapilot/log_shipper.py`）把 `/var/log/pods` 的容器 CRI 日志
  解析后写入 `OPENSEARCH_NODE`（或 runtime-config logSystems）指定的 OpenSearch/ES8，
  索引按 `<indexPrefix>-YYYY-MM-DD` 每日滚动；容器内需挂载宿主机 `/var/log/pods`（清单已配好）。
  `INFRAPILOT_LOG_SHIPPER=0` 可关闭（mcp-agent 模式默认关闭）。
- **ClickHouse**：ClickHouse Skill 默认自动发现 `clickhouse.islap.svc.cluster.local`。若 ClickHouse 部署在
  `islap` 命名空间，无需额外配置。

## 9. 远程设备命令执行

部署后，Linux Skill 按主机注册表分流执行通道：

1. `host="local"`：在 InfraPilot Server 容器内执行。
2. `host=<mcp 类型主机别名>`：经 MCP JSON-RPC（HTTP）调用该节点上的 mcp-agent。
3. `host=<SSH 类型主机别名>`：SSH Proxy 白名单只读诊断。

SSH 主机注册表可通过 `SSH_HOSTS` 环境变量或 `SSH_HOSTS_CONFIG` 配置，详见 `docs/ssh-proxy-linux-remote.md`。

## 10. 升级与回滚

升级服务端：

```bash
# 1) 重新构建并推送 Python 后端镜像
docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest py-server
docker push localhost:5000/infrapilot/server:latest
# 2) 触发滚动重启（imagePullPolicy=Always 会拉取新镜像）
kubectl rollout restart deployment/infrapilot-server -n infrapilot
kubectl rollout status deployment/infrapilot-server -n infrapilot
```

回滚：

```bash
kubectl rollout undo deployment/infrapilot-server -n infrapilot
```
