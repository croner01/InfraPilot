# 远端 K8s 集群接入

> 对应设计文档：§8.3 安全网关、§13.2 部署架构

## 1. 功能概述

让 K8s Skill 面向**任意已登记的远端集群**执行检查与变更：

- 不指定 `cluster` 时使用**默认集群**；未登记任何集群时回退到进程内 kubeconfig（本地集群，行为与改造前完全一致）。
- 只读检查（列出 Pod / 事件 / 节点 / Deployment / cgroup 内存 …）自动执行。
- 变更类操作（如 `patch_resource_limits`）仍由 Policy Engine 定级为 high，**必须人工审批**后经 Command Gateway 执行，审批卡会标注目标集群与 apiserver 地址。

## 2. 架构

```text
Agent
  │  skill=k8s tool=describe_pod args={..., "cluster": "prod-a"}
  ▼
Policy Engine (infrapilot/policy.py)          —— 风险定级；审批文案带目标集群
  ▼
Command Gateway (infrapilot/gateway.py)       —— 校验审批令牌 + argsHash，写审计
  ▼
K8s Skill (infrapilot/skills/k8s.py)
  │  _core(cluster) / _apps(cluster) / _custom(cluster)
  ▼
k8s_clusters (infrapilot/k8s_clusters.py)     —— 集群登记表 + ApiClient 工厂（按配置指纹缓存）
  │  ref 为空 → 默认集群 ／ 无登记集群 → 进程内 kubeconfig
  ▼
目标 K8s apiserver
```

**安全关键点**

- 显式指定了 `cluster` 却查不到时**直接报错**，绝不静默回退到本地集群 —— 避免「改错集群」被当成合法变更送进审批。
- 密钥（kubeconfig / token / clientKey / CA）只在保存时上行；`GET /api/config/k8s-clusters` 一律脱敏，仅返回 `hasToken` / `hasKubeconfig` / `hasClientCert` / `hasCaCert` 标记。
- 需要落盘的凭据写入 `data/k8s/<cluster-id>/`（目录 0700、文件 0600），只有构造 ApiClient 时才写入。
- 变更审批的 `argsHash` 覆盖 `cluster` 字段：批准后若集群被改，令牌校验失败并拒绝执行。

## 3. 配置

落盘于 `data/runtime-config.json` 的 `k8sClusters`（与 `logSystems` / `metricSystems` 同构）：

```json
{
  "k8sClusters": [
    {
      "id": "prod-a",
      "name": "生产集群 A",
      "authType": "token",
      "server": "https://10.0.0.1:6443",
      "tokenEnv": "K8S_PROD_A_TOKEN",
      "insecureSkipTlsVerify": false,
      "enabled": true,
      "isDefault": true
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | URL 安全标识。由名称生成；非 ASCII 名称（中文等）回落到 `cluster-<短哈希>`，重复保存得到同一 id |
| `authType` | `kubeconfig`（粘贴 kubeconfig 文本）／`token`（server + Bearer Token）／`clientCert`（server + 证书与私钥路径） |
| `tokenEnv` | 令牌所在环境变量，优先级高于明文 `token`，适合生产环境 |
| `caCert` / `caCertPath` | 内联 PEM 或宿主机路径；自签证书可改用 `insecureSkipTlsVerify` |
| `isDefault` | 默认集群；首个登记的集群自动成为默认，删除默认后自动顺延 |

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config/k8s-clusters` | 集群列表（脱敏）+ `defaultClusterId` + `localFallback` |
| POST | `/api/config/k8s-clusters` | 新增/更新（按 `id` upsert；未回传的密钥沿用原值） |
| DELETE | `/api/config/k8s-clusters/{id}` | 移除集群 |
| POST | `/api/config/k8s-clusters/{id}/test` | 连通性探测：返回 apiserver 版本与节点数 |

## 4. 使用

前端入口：**系统设置 → K8s 集群**（新增/编辑/连接测试/设为默认/移除）。

Agent 侧：

```
k8s.list_clusters()                                        # 查看可用集群与默认集群
k8s.list_pods    { "cluster": "prod-a", "namespace": "order-service" }
k8s.describe_pod { "cluster": "prod-a", "namespace": "order-service", "pod_name": "order-api-xxx" }
k8s.patch_resource_limits { "cluster": "prod-a", ... }     # 变更 → 进入审批
```

所有 k8s 工具的返回体统一带 `cluster` 字段，标明实际命中的集群，便于证据链与审计定位来源。

## 5. 验证

```bash
cd py-server && python3 -m pytest tests/test_k8s_clusters.py -q
```

覆盖：登记与脱敏、编辑时沿用未回传密钥、首个集群自动设为默认、删除默认后顺延、
未知集群不回退本地、`list_clusters` 工具输出、变更类审批文案与 diff 预览包含目标集群、
所有 k8s 工具均暴露 `cluster` 参数。
