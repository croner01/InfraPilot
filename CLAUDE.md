# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

InfraPilot Agent — AI SRE Agent，面向 Kubernetes / Linux / ELK 基础设施的自主诊断与修复系统。
单后端：`py-server/`（Python/FastAPI，端口 8787）；原 `server/`（Node/TypeScript）已删除，
其独有能力（日志采集管道 logShipper、MCP 客户端通道）已移植进 Python 代码。

### 快速启动

```bash
# 后端 (py-server/)
cd py-server
pip3 install -r requirements.txt   # fastapi, uvicorn, openai, pydantic, httpx, opensearch-py, kubernetes, paramiko...
python3 -m infrapilot              # http://localhost:8787

# 前端 (web/)
cd web
npm install        # 依赖: react 19, vite 8
npm run dev        # vite dev → http://localhost:5173（/api 和 /ws 代理到 :8787）
```

### 数据库

后端自动创建 SQLite 文件 `py-server/data/infrapilot.sqlite`（`INFRAPILOT_DATA_DIR` 可覆盖），
包含 sessions、audit_log、approvals、incident_cases、users、alerts、schedules 等 15+ 张表。
生产环境可挂持久卷（K8s 清单默认 hostPath / PVC）。

### 构建

```bash
docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest py-server
cd web && npm run build     # tsc -b && vite build
```

## 架构概览

```
InfraPilot/
├── py-server/                    # Python/FastAPI 后端（唯一后端）
│   ├── infrapilot/
│   │   ├── main.py               # FastAPI 入口（/ws 时间线、{"error":...} 错误体契约、lifespan 挂 log_shipper）
│   │   ├── models.py             # 共享模型：ToolDef, ToolExecutionResult, AgentSession 等
│   │   ├── llm.py                # OpenAI 兼容客户端（默认 DeepSeek 后端）
│   │   ├── runner.py             # Agent 可恢复执行循环（intake → planning → tool_exec → approval → observation → rca）
│   │   ├── orchestrator.py       # start/resume turn
│   │   ├── gateway.py            # Command Gateway：审批校验(argsHash 防篡改) + 审计，唯一执行入口
│   │   ├── policy.py             # Policy Engine：风险五级分级（readonly/low/medium/high/critical）
│   │   ├── redact.py             # 敏感信息脱敏（密码/token/证书等）
│   │   ├── log_shipper.py        # 日志采集管道：/var/log/pods CRI 日志 → OpenSearch/ES8（原 Node logShipper 移植）
│   │   ├── mcp_client.py         # MCP 客户端：远端节点 JSON-RPC /api/mcp 调用（原 Node gRPC 通道替代）
│   │   ├── remote.py             # SSH 通道：host≠local 时的只读诊断执行
│   │   ├── routes/               # REST API（sessions/alerts/config/data-sources/skills/auth/usage/schedules/mcp/eval/artifacts/a2a）
│   │   ├── skills/               # 各 Skill ToolDef + 执行器（linux/k8s/elk/clickhouse/prom/trace/knowledge/openstack/drawio/...）
│   │   ├── eval_cases/           # 内置评测 case
│   │   └── scripts/, config/     # drawio 导出脚本、API 冒烟、配置示例
│   ├── skills/                   # SKILL.md 技能包（prompt 注入用知识包，与 Python 代码 skills/ 不同）
│   ├── k8s-manifests/            # infrapilot-server（Python 镜像）+ mcp-agent（每节点 MCP Agent DaemonSet）+ order-api 演示负载
│   └── tests/                    # pytest 离线测试
├── web/                          # React 19 + Vite 8 前端（Timeline UI）
└── docs/                         # 完整技术设计文档（17章）
```

### 核心设计思路

1. **Agent 推理循环** — `runner.py` 显式 while 循环 + OpenAI Function Calling 实现状态机，
   支持 checkpoint 持久化与 `awaiting_approval` 中断/恢复。模型经 `REASONING_MODEL`/`FAST_MODEL`
   配置（runtime-config 数据库可能覆盖 env），Key 优先 `GSK_API_KEY`。
2. **Skill 工具系统** — 每个 Skill 模块导出 `TOOLS: list[ToolDef]` + `async def execute(tool, args)`。
   工具命名 `{skill}__{tool}`，风险等级在 ToolDef 声明，Policy Engine/Gateway 自动感知。
3. **Policy Engine + Command Gateway** — 只读工具自动执行；medium+ 强制审批（argsHash 防篡改 +
   审计落盘）；执行结果全量写 audit_log。
4. **真实数据源** — k8s Skill 连接真实集群（kubernetes client），ELK Skill 连接真实
   OpenSearch（SDK 或 ES8 REST 兼容头），Linux Skill 执行宿主机真实命令或经 SSH/MCP 通道到远端节点。
5. **远端执行双通道** — Host Registry 中 `auth.type=mcp` 的主机经 `mcp_client.py` 调用节点上的
   MCP Agent（`MCP_SERVER_MODE=http python3 -m infrapilot.mcp_server`，共享 `MCP_JWT_SECRET`）；
   其余类型走 `remote.py` SSH 白名单只读通道。
6. **前端 Timeline** — WebSocket 推送所有 Agent 事件，右侧面板轮询 Pod 实时状态。

### 关键环境依赖

- k3s 单节点集群（kubeconfig）；OpenSearch 单节点 `http://127.0.0.1:9200`
- API Key 环境变量：`GSK_API_KEY` 或 `OPENAI_API_KEY`
- 日志采集：`/var/log/pods`（容器内需挂载，见 `py-server/k8s-manifests/infrapilot-server/`）

### 演示场景

order-api Deployment 真实内存泄漏 → kubelet OOMKilled → CrashLoopBackOff。
Agent 自主诊断：`k8s.list_pods` → `k8s.describe_pod` → elk 日志检索/时间线（由 log_shipper
真实采集落库）→ `linux.get_process_info` 交叉验证 → 根因结论 →
`k8s.patch_resource_limits` 触发审批 → 批准后修复验证。

### 增量开发指南

- 新增工具：`infrapilot/skills/<name>.py` 中加 `ToolDef` + execute 分支，并在
  `infrapilot/skills/__init__.py` 的 `_MODULES` 注册（无单独 policy 注册步骤）。
- 新增 SKILL.md 知识包：放 `py-server/skills/<name>/SKILL.md`（frontmatter：name/description），
  运行时按 query 相关性注入 prompt。
- 后端调试：`python3 -m infrapilot`（uvicorn 无热重载；开发可 `uvicorn infrapilot.main:app --reload`）。
- 前端调试：Vite HMR + `/api` `/ws` 代理到 8787。
- 测试：`cd py-server && python3 -m pytest tests -q`；契约冒烟 `./scripts/smoke_api.sh 8791`。
