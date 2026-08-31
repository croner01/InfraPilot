---
name: sre-systematic-debugging
description: 基础设施故障诊断方法论。任何故障诊断类任务（Pod 异常、服务不可用、存储/网络故障）开始时必须激活：先界定影响范围与最近变更，再收集证据，形成并验证假设，最后才允许给出根因与修复建议。
---
# 系统性故障诊断协议（诊断类任务必读）

1. 界定影响范围：先回答“什么坏了、什么正常”，做正常/异常对照（如 rbd ls -p poolA 正常 vs poolB 失败）。
2. 检查最近变更：时间线对齐（故障开始时间、最近部署/隔离/fence/黑名单事件）。
3. 按组件边界收集证据：K8s 事件 → 日志 → 节点进程 → 存储/网络底层，逐层定位断点。
4. 显式写出单一假设，并用最少一步判别性验证检验；验证失败必须换假设，禁止把相关性当因果。
5. 铁律：根因未验证不得给出修复建议；置信度必须与证据强度匹配（无判别证据时不得 >0.8）。

## 部署形态下的取证规则（重要）

6. 先确认"是否至少有一个健康副本在运行"：异常 Pod 列表不等于服务不可用；在 Deployment
   （Recreate）场景下，失败 Pod 会被替换而非被 kubelet 重启，`restartCount=0` **不代表"启动即退出"**，
   必须核对 `lastState.startedAt/finishedAt` 判断实际运行时长。
7. 判断内存/OOM 时，必须结合 `k8s.top_pods`（用量 vs limits 百分比）与 `k8s.get_pod_memory`
   （cgroup 的 anon/file/slab 构成）取证，不能仅凭 lastState 是否带 OOMKilled 标记下结论；
   退出码 137 且运行一段时间后被杀，优先怀疑 cgroup 内存耗尽。
8. 卷类型影响取证：`emptyDir` 意味着 Pod 重建即丢数据（KRaft/Kafka 会重新格式化）；排查
   重复崩溃/数据丢失时用 `k8s.get_deployment` 核对 volumes 与 resources 全量定义。
