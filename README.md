# InfraPilot Agent

AI SRE Agent（智能运维故障诊断 Agent）—— 面向 Kubernetes / Linux / ELK 的自主诊断与修复系统。

完整技术设计文档见 [`docs/InfraPilot-Agent-设计文档.md`](docs/InfraPilot-Agent-设计文档.md)（17章，覆盖架构/Agent状态机/MCP Skill体系/安全网关/部署方案等）。

前端更新内容（数据源工作台 / Cortex 风格诊断会话 / 告警中心 / 技能市场与 Skill Factory / 用量统计 / 用户隔离）见 [`docs/前端更新说明.md`](docs/前端更新说明.md)。

## 实现（端到端可运行）

本仓库已落地一个**端到端可运行**的系统，而非纯前端 mock。单后端：`py-server/`（Python/FastAPI）；
原 Node 后端（`server/`）已删除，其独有能力已移植（日志采集管道、MCP 客户端通道）。

- **`py-server/`** — Python/FastAPI 后端（端口 8787）
  - `infrapilot/runner.py` — Agent 编排核心：OpenAI Function Calling 推理循环（可恢复/checkpoint）、
    系统_PROMPT、会话状态与 WebSocket 时间线事件
  - `infrapilot/skills/` — 各 Skill 的 ToolDef 与执行器：
    - `linux` — Linux Skill：真实执行诊断命令（top/free/ps/df/dmesg 等）；`host != local` 时经 SSH
      或 MCP 通道到远端节点
    - `k8s` — Kubernetes Skill：连接真实集群（kubernetes client，describe_pod/get_events/patch_resource_limits 等）
    - `elk` — ELK Skill：对真实 OpenSearch/ES8 索引做检索/聚合/时间线/模板聚类
  - `infrapilot/log_shipper.py` — 日志采集管道：tail `/var/log/pods` 容器 CRI 日志 →
    真实写入 OpenSearch/ES8 索引（原 Node logShipper 移植），供 ELK Skill 查询
  - `infrapilot/mcp_client.py` — MCP 客户端通道：远端节点 MCP Agent（JSON-RPC over HTTP），
    替代原 Node gRPC linux-mcp-server；SSH 通道见 `infrapilot/remote.py`
  - `infrapilot/policy.py` + `gateway.py` — Policy Engine（风险五级分级）+ Command Gateway
    （审批校验 + argsHash 防篡改 + 审计落盘）+ 敏感信息脱敏（`redact.py`）
  - SQLite 持久层（会话、审计日志、审批记录、案例库、用户/用量/定时任务等 15+ 表）
  - Python 侧扩展能力：认证 RBAC、Token 用量、告警接入、服务拓扑、Skill Factory、Trace 数据源、
    定时任务、MCP Server 模式、A2A、LLM-as-judge 评测、会话产物、沙箱代码执行、CLI/ChatOps
- **`py-server/skills/`** — SKILL.md 技能包（prompt 知识包，如 sre-systematic-debugging）
- **`web/`** — React + Vite 前端，Codex/Trae 风格 Timeline UI：流式工具调用展示、风险等级徽章、
  审批卡片（批准/拒绝）、右侧 Pod 实时状态面板

### 已验证的端到端能力

1. Agent 收到"生产环境有服务一直重启"这类**未指明具体目标**的模糊描述后，会自主调用 `k8s.list_pods` 发现异常 Pod，而不是反问用户要参数
2. 交叉调用 K8s（Pod状态/事件）+ ELK（日志检索/聚类/时间线）+ Linux（进程内存）三个 Skill 收集证据
3. 生成结构化根因结论（容器内存 limit 过低导致渐进式 OOMKilled）
4. 发起变更类修复（`patch_resource_limits`）时被 Policy Engine 判定为 `high` 风险并强制进入审批流程
5. 人工批准后 Command Gateway 才真正执行，执行结果与审批人（`approved_by`）完整落审计表
6. 修复后真实验证：内存 limit 提升后进程不再 OOM，Pod 稳定运行

## 快速运行

```bash
# 后端
cd py-server
pip3 install -r requirements.txt
python3 -m infrapilot        # http://localhost:8787

# 前端（另一个终端）
cd web
npm install
npm run dev         # http://localhost:5173，已配置 /api 与 /ws 代理到后端
```

打开前端页面，点击「新建排查会话」，输入例如：

> 生产环境有服务一直重启,帮我看看什么原因

即可观察 Agent 自主诊断的完整过程；诊断结论给出修复建议后，回复"帮我执行修复"会触发审批卡片，点击「批准执行」查看修复落地效果。

K8s 生产部署（Python 镜像 + `/var/log/pods` 挂载 + mcp-agent DaemonSet）见
[`py-server/k8s-manifests/`](py-server/k8s-manifests/README.md) 与 [`docs/deployment.md`](docs/deployment.md)。

## 后续工作

- OpenStack Skill（Nova/Neutron/Cinder 诊断）—— 当前 sandbox 无可用 OpenStack 环境，未接入
- LangGraph 状态机迁移（当前用显式 while 循环实现等价语义，未引入 LangGraph 依赖）
- 案例库向量检索升级（Qdrant 目前为可选依赖，默认内嵌 TF-IDF）
- 生产级凭据管理（Vault 动态短期凭据）
- CLI 客户端扩展、Slack/企业微信 ChatOps 集成

## 安全设计落地情况

- ✅ 风险五级分级（readonly/low/medium/high/critical）已实现并生效（Policy Engine）
- ✅ 变更操作强制审批，未批准不执行（Command Gateway 校验 `approved` 标志）
- ✅ 审批令牌防篡改哈希绑定（argsHash）
- ✅ 全量审计日志（工具/参数/风险等级/审批人/结果）落盘 SQLite
- ✅ 敏感信息脱敏层（`py-server/infrapilot/redact.py`）
- ✅ 不可信数据显式标注（`<tool_result trust_level="untrusted_data">`），防 Prompt Injection
- ⏳ 双人审批、Dry-run 沙箱 —— 设计已在文档中，未实现
