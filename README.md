# InfraPilot Agent

AI SRE Agent（智能运维故障诊断 Agent）—— 面向 Kubernetes / Linux / ELK 的自主诊断与修复系统。

完整技术设计文档见 [`docs/InfraPilot-Agent-设计文档.md`](docs/InfraPilot-Agent-设计文档.md)（17章，覆盖架构/Agent状态机/MCP Skill体系/安全网关/部署方案等）。

## 当前实现（Phase 1 MVP，可运行）

本仓库已落地一个**端到端可运行**的 MVP，而非纯前端 mock：

- **`server/`** — Node.js/TypeScript 后端
  - `src/agent/` — Agent 编排核心：OpenAI Function Calling 推理循环、系统 Prompt、会话状态与 WebSocket 时间线事件
  - `src/skills/linux` — Linux Skill：真实执行本机诊断命令（top/free/ps/df/dmesg等）
  - `src/skills/k8s` — Kubernetes Skill：接口契约对齐 kubectl 语义（describe_pod/get_events/patch_resource_limits等）
  - `src/skills/elk` — ELK Skill：对真实日志文件做检索/聚合/时间线/模板聚类
  - `src/gateway/` — Policy Engine（风险分级）+ Command Gateway（审批校验+审计落盘）+ 敏感信息脱敏
  - `src/demo/` — 演示故障场景：一个真实的 order-api 子进程，会真实泄漏内存直至 OOM 退出（exit code 137），由 supervisor 模拟 kubelet 的 CrashLoopBackOff 重启行为 —— 因此 Agent 诊断的是**真实系统状态**，不是编造数据
  - `src/db/` — SQLite（对应设计文档 §10 PostgreSQL 表结构的简化实现）：会话、审计日志、审批记录、案例库
- **`web/`** — React + Vite 前端，Codex/Trae 风格 Timeline UI：流式工具调用展示、风险等级徽章、审批卡片（批准/拒绝）、右侧 Pod 实时状态面板

### 已验证的端到端能力

1. Agent 收到"生产环境有服务一直重启"这类**未指明具体目标**的模糊描述后，会自主调用 `k8s.list_pods` 发现异常 Pod，而不是反问用户要参数
2. 交叉调用 K8s（Pod状态/事件）+ ELK（日志检索/聚类/时间线）+ Linux（进程内存）三个 Skill 收集证据
3. 生成结构化根因结论（实测置信度 0.95：容器内存 limit 过低导致渐进式 OOMKilled）
4. 发起变更类修复（`patch_resource_limits`）时被 Policy Engine 判定为 `high` 风险并强制进入审批流程
5. 人工批准后 Command Gateway 才真正执行，执行结果与审批人（`approved_by`）完整落审计表
6. 修复后真实验证：内存 limit 从 200Mi 提升到 512Mi 后，进程不再 OOM，Pod 稳定运行

## 快速运行

```bash
# 后端
cd server
npm install
npm run dev        # http://localhost:8787，启动即会拉起演示故障工作负载

# 前端（另一个终端）
cd web
npm install
npm run dev         # http://localhost:5173，已配置 /api 与 /ws 代理到后端
```

打开前端页面，点击「新建排查会话」，输入例如：

> 生产环境有服务一直重启,帮我看看什么原因

即可观察 Agent 自主诊断的完整过程；诊断结论给出修复建议后，回复"帮我执行修复"会触发审批卡片，点击「批准执行」查看修复落地效果。

## 尚未实现 / 后续工作（Phase 2+，见设计文档 §15 路线图）

- OpenStack Skill（Nova/Neutron/Cinder 诊断）—— 当前 sandbox 无可用 OpenStack 环境，未接入
- 真实 Kubernetes 集群接入（`@kubernetes/client-node`）—— 当前 k8s Skill 数据源为本地模拟的真实子进程，接口契约已对齐 kubectl，生产环境可直接替换数据源实现
- 真实 Elasticsearch/OpenSearch 集群接入 —— 当前 ELK Skill 对真实日志文件运算，检索/聚合/聚类算法逻辑已完整实现，替换数据源为 ES REST API 即可复用
- LangGraph 状态机迁移（当前用显式 while 循环实现等价语义，未引入 LangGraph 依赖）
- 双人审批、案例库向量检索（Qdrant）、Skill Marketplace、多 Agent 真正独立进程协同
- 生产级凭据管理（Vault 动态短期凭据）、mTLS MCP Server 部署
- CLI 客户端、Slack/企业微信 ChatOps 集成

## 安全设计落地情况

- ✅ 风险五级分级（readonly/low/medium/high/critical）已实现并生效（Policy Engine）
- ✅ 变更操作强制审批，未批准不执行（Command Gateway 校验 `approved` 标志）
- ✅ 全量审计日志（工具/参数/风险等级/审批人/结果）落盘 SQLite
- ✅ 敏感信息脱敏层（`gateway/redact.ts`）
- ✅ 不可信数据显式标注（`<tool_result trust_level="untrusted_data">`），防 Prompt Injection
- ⏳ 双人审批、审批令牌防篡改哈希绑定、Dry-run 沙箱 —— 设计已在文档中，MVP 阶段未实现
