# mcp-agent —— 远程节点 MCP Agent（原 linux-mcp-server，HTTP 模式）

每个节点部署一个 Agent，与主 server 共用同一份 `infrapilot` Python 镜像，
以 **MCP HTTP 模式**运行：`MCP_SERVER_MODE=http python3 -m infrapilot.mcp_server`，
在该节点上提供 `POST /api/mcp`（标准 MCP JSON-RPC 2.0：initialize / tools/list / tools/call）。

## 传输协议（与旧 gRPC linux-mcp-server 的差异）

- ❌ 旧方案：gRPC（`server/` Node 版 + `infrapilot/linux-mcp-server` 镜像 + mTLS），已随 Node 后端删除。
- ✅ 新方案：HTTP JSON-RPC —— 无 gRPC/proto 依赖，任何实现 MCP tools/call 的 HTTP 端点均可接入；
  鉴权为主 server 签发的短期 JWT（HS256，`aud=infrapilot-mcp`，`tools=<白名单>`），
  双方共享 `mcp-jwt-secret` Secret，不再需要证书签发设施（原 cert-issuer.yaml 已删除）。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `namespace.yaml` | `infrapilot-mcp` 命名空间 |
| `daemonset.yaml` | 每节点一个 Agent（hostPID+hostNetwork，只挂只读诊断用的 /proc、/sys、/var/log） |
| `service.yaml` | Headless Service（预留 DNS 自动发现，当前按节点 IP 直连） |
| `rbac.yaml` | Agent 侧只读 K8s 诊断权限 |
| `serviceaccount.yaml` | `linux-mcp-server` 服务账号 |
| `secret.yaml` | `mcp-jwt-secret`（须与主 server 的 `MCP_JWT_SECRET` 一致） |

## 部署

```bash
kubectl apply -f py-server/k8s-manifests/mcp-agent/
```

## 主 server 侧接入

任选其一（见 `docs/deployment.md`）：

1. **Host Registry**（UI 或 API 注册主机，`auth.type=mcp` + `endpoint=<节点IP>:8443`）；
2. **MCP_ENDPOINTS 环境变量**：`{"node-1": "10.0.0.11:8443", ...}`（示例见
   `py-server/config/mcp-endpoints.json.example`）。

本地/裸机单台主机也可不用本 DaemonSet：在目标机器上
`MCP_SERVER_MODE=http MCP_SERVER_PORT=8443 python3 -m infrapilot.mcp_server` 即可。
