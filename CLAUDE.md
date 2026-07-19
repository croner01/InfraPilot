# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

InfraPilot Agent — AI SRE Agent，面向 Kubernetes / Linux / ELK 基础设施的自主诊断与修复系统。

### 快速启动

```bash
# 后端 (server/)
cd server
npm install        # 依赖: express, ws, openai, better-sqlite3, @kubernetes/client-node, @opensearch-project/opensearch
npm run dev        # tsx watch src/index.ts → http://localhost:8787

# 前端 (web/)
cd web
npm install        # 依赖: react 19, vite 8
npm run dev        # vite dev → http://localhost:5173（/api 和 /ws 代理到 :8787）
```

### 数据库

后端自动创建 SQLite 文件 `server/data/infrapilot.sqlite`（WAL 模式），包含 sessions、audit_log、approvals、incident_cases 四张表。生产环境可迁移到 PostgreSQL。

### 构建

```bash
cd server && npm run build  # tsc 编译到 dist/
cd web && npm run build     # tsc -b && vite build
```

## 架构概览

```
InfraPilot/
├── server/                    # Node.js/TypeScript 后端
│   └── src/
│       ├── index.ts           # Express + WebSocket 入口，端口 8787
│       ├── types.ts           # 共享类型：ToolDef, AgentSession, RiskLevel 等
│       ├── llm/client.ts      # OpenAI 兼容客户端（默认 DeepSeek 后端）
│       ├── agent/
│       │   ├── orchestrator.ts # 核心推理循环：intake → planning → tool_exec → approval → observation → rca → report
│       │   ├── sessionStore.ts # 会话状态管理（内存+SQLite 持久化）+ 审批中断/恢复
│       │   └── prompts.ts      # System Prompt（SRE 诊断原则、输出格式、故障模式知识）
│       ├── skills/
│       │   ├── elk/tools.ts    # ELK Skill：search_logs / aggregate_by_field / get_error_timeline / cluster_similar_errors（数据源：真实 OpenSearch）
│       │   ├── elk/logShipper.ts # 日志采集管道：Pod CRI 日志 → OpenSearch 索引
│       │   ├── k8s/tools.ts    # K8s Skill：list_pods / get_pod_status / describe_pod / get_events / patch_resource_limits（数据源：真实 k3s 集群）
│       │   ├── k8s/client.ts   # @kubernetes/client-node 封装
│       │   ├── linux/tools.ts  # Linux Skill：get_cpu_usage / get_memory_info / get_disk_usage / get_process_info / tail_recent_dmesg（数据源：宿主机真实命令）
│       ├── gateway/
│       │   ├── policy.ts       # Policy Engine：风险五级分级（readonly/low/medium/high/critical）+ 全局黑名单 + diff 预览
│       │   ├── commandGateway.ts # 命令执行网关：权限校验 + 审计落盘，唯一执行入口
│       │   └── redact.ts       # 敏感信息脱敏（密码/token/证书等）
│       ├── routes/api.ts       # REST API：sessions CRUD、messages、approvals、demo 控制
│       ├── ws/hub.ts           # WebSocket 时间线事件实时推送给前端
│       ├── db/db.ts            # SQLite 数据库层（sessions / audit_log / approvals / incident_cases）
│       └── demo/               # 演示故障场景（order-api 真实 OOM 子进程）
│   └── k8s-manifests/          # 真实 k3s Deployment YAML
├── web/                        # React 19 + Vite 8 前端
│   └── src/
│       ├── App.tsx             # 三栏布局：侧边栏 + Timeline + 右侧 Pod 状态面板
│       ├── index.css           # 全局样式
│       └── lib/types.ts        # 前端类型定义
└── docs/                       # 完整技术设计文档（17章）
```

### 核心设计思路

1. **Agent 推理循环** — `orchestrator.ts` 中一个显式 while 循环 + OpenAI Function Calling 实现状态机（语义对应 LangGraph）。循环上限 10 次迭代。
   - 模型通过环境变量 `REASONING_MODEL`/`FAST_MODEL` 配置，默认 `deepseek-v4-pro` / `deepseek-v4-flash`
   - API Key 优先 `GSK_API_KEY`，其次 `OPENAI_API_KEY`；Base URL 可配置
2. **Skill 工具系统** — 每个 Skill 导出 `ToolDef[]`（name, description, risk 等级, JSON Schema parameters）和 `executeXxxTool()`。工具命名约定 `{skill}__{tool}`，风险标记在描述中（如 `[k8s][risk=high]`）。
3. **Policy Engine + Command Gateway** — 只读工具（readonly/low）自动执行；变更工具（medium/high/critical）触发审批。审批用 Promise 阻塞推理循环等待前端决策。执行结果全量写入 audit_log。
4. **真实数据源** — k8s Skill 连接真实 k3s 集群（`@kubernetes/client-node`），ELK Skill 连接真实 OpenSearch（`@opensearch-project/opensearch`），Linux Skill 执行宿主机真实命令。不再使用模拟数据。
5. **前端 Timeline** — WebSocket 推送所有 Agent 事件（tool_call_start/result、approval_request/decision、rca_conclusion 等），右侧面板轮询 Pod 实时状态。

### 关键环境依赖

- k3s v1.36.2 单节点集群（kubeconfig: `/home/user/.kube/config`）
- OpenSearch v2.19.1 单节点（`http://127.0.0.1:9200`，无认证）
- API Key 环境变量：`GSK_API_KEY` 或 `OPENAI_API_KEY`

### 演示场景

order-api Deployment 存在内存泄漏，触发真实 kubelet OOMKilled 进入 CrashLoopBackOff。Agent 自主诊断流程：
1. `k8s.list_pods` → 发现异常 Pod
2. `k8s.describe_pod` → 查看 restartCount / lastState / resources.limits
3. `elk.search_logs` / `elk.get_error_timeline` → 日志内存增长趋势
4. `linux.get_memory_info` → 交叉验证宿主机 OOM 记录
5. 输出根因结论（内存 limit 过低）
6. `k8s.patch_resource_limits` → 触发审批 → 批准后执行修复

### 增量开发指南

- 新增工具：在对应 Skill 的 tools.ts 中添加 `ToolDef` 条目 + `executeXxxTool()` 分支，风险等级在 ToolDef 中声明
- 新增 Skill：创建 `src/skills/{newSkill}/tools.ts`，在 `policy.ts` 的 `ALL_TOOLS` 和 `commandGateway.ts` 的 `dispatch()` 中注册
- 前端扩展：App.tsx 中 `EventCard` 组件按 `type` 渲染不同 UI，参考已有 approval 卡片实现审批交互
- 后端调试：`npm run dev` 自动热重载（tsx watch）
- 前端调试：Vite HMR + `/api` `/ws` 代理到后端
