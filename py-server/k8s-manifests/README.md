# K8s Manifests（真实集群接入）

Terraform/Ansible 不在本仓库范围；本目录的项目直接 `kubectl apply -f <子目录>/`。

## 前置基础设施（单节点 k3s 沙箱已就绪）

- **真实单节点 K8s 集群**：k3s（systemd 托管），kubeconfig 可读，
  已禁用 traefik/servicelb/metrics-server/local-storage 等非必要组件；flannel 使用 host-gw。
- **真实 OpenSearch 单节点**（v2.19.x，heap 256MB，systemd 托管，green）：
  `http://127.0.0.1:9200`（安全插件已移除，无需认证，仅供本机访问）。

## 子目录

| 子目录 | 内容 |
| --- | --- |
| `infrapilot-server/` | 主 server（Python/FastAPI，`localhost:5000/infrapilot/server` 镜像）+ RBAC/Secret/ConfigMap |
| `mcp-agent/` | 远程节点 MCP Agent DaemonSet（HTTP 模式 MCP JSON-RPC，见其 README.md） |
| `order-api-*` | `order-service` 命名空间的演示工作负载（制造真实内存增长与 OOMKilled 故障场景） |

## 演示数据链路（全链路真实数据，无编造）

1. order-api Deployment 真实泄漏内存 → kubelet 真实 OOMKilled → CrashLoopBackOff；
2. 容器日志由 containerd 按 CRI 格式落盘 `/var/log/pods/<ns>_<pod>_<uid>/<container>/*.log`；
3. 主 server 内置采集管道 `infrapilot/log_shipper.py`
   tail 该目录（deployment.yaml 已只读挂载），增量解析后写入 OpenSearch `order-api-logs-*`；
4. Agent 排查时经 ELK Skill 检索/聚合真实日志，经 K8s Skill 读真实 Pod/Event；
5. 修复建议落地前经过 Policy Gateway 风险分级 + 人工审批。

## 部署顺序

```bash
kubectl apply -f py-server/k8s-manifests/infrapilot-server/   # 主 server（含 namespace/rbac/secret）
kubectl apply -f py-server/k8s-manifests/mcp-agent/          # 可选：远程节点 MCP Agent（DaemonSet）
kubectl apply -f py-server/k8s-manifests/order-api-*.yaml    # 可选：演示工作负载
```

镜像构建与推送到 `localhost:5000` 见 `docs/deployment.md`。
