# K8s Manifests (真实集群接入 - 进行中)

本目录用于存放 order-api 演示工作负载迁移到真实 Kubernetes Deployment 后的 YAML 清单。

## 当前 sandbox 基础设施状态(已就绪)

- **真实单节点 K8s 集群**: 通过 k3s v1.36.2 安装并以 systemd 托管(`systemctl status k3s`),
  已验证真实调度/拉取镜像/运行容器(测试用 nginx:alpine pod 成功运行)。
  - kubeconfig: `/home/user/.kube/config` (world-readable, 非 root 用户可直接 `kubectl get pods` 等)
  - 已禁用 traefik/servicelb/metrics-server/local-storage 等非必要组件以降低内存占用
  - flannel backend 使用 host-gw(sandbox 不支持 vxlan)
- **真实 OpenSearch 单节点**: v2.19.1,已移除所有非核心插件(ml/knn/security等)以降至最小内存占用
  (heap 256MB),通过 systemd 托管(`systemctl status opensearch`),集群健康状态 green。
  - 端点: `http://127.0.0.1:9200` (安全插件已移除,无需认证,仅供本机访问)

## 后续代码集成计划(尚未完成,不要认为已完成)

1. 将 `server/src/demo/orderApiWorker.mjs` 打包为容器镜像(或直接用 node:22-alpine + ConfigMap 挂载脚本),
   通过本目录下的 Deployment YAML 部署到 order-service namespace,使用真实 resources.limits.memory
   触发真实 kubelet OOMKilled(不再是 supervisor.ts 模拟的子进程)。
2. 日志采集管道: 读取 `/var/log/pods/<namespace>_<pod>_<uid>/<container>/*.log` (containerd CRI 日志格式),
   解析后真实写入/索引到 OpenSearch(`order-api-logs-*` 索引),替代原先直接解析本地文件的 ELK Skill 实现。
3. 重写 `server/src/skills/k8s/tools.ts`: 使用 `@kubernetes/client-node` 调用真实 K8s API
   (CoreV1Api.listNamespacedPod / readNamespacedPodStatus / listNamespacedEvent /
   patchNamespacedDeployment 等),替换 `orderApiSupervisor` 依赖。
4. 重写 `server/src/skills/elk/tools.ts`: 使用 `@opensearch-project/opensearch` 客户端对真实索引做
   search/aggregate/date_histogram 查询,替换本地文件解析逻辑。
5. 相应更新 Agent system prompt 中的环境说明、orchestrator 的证据展示格式、前端 pod-state 面板的字段映射。
6. 端到端重新验证:真实 K8s Event 时间线 + 真实 OpenSearch 日志查询 + Agent 自主排查修复全链路。
