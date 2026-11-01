# InfraPilot Agent 能力差距分析报告

> 生成时间：2026-09-28 · 基于对 `server/src` / `web/src` 全量代码审计
> 对标对象：LangGraph / Dify / Coze / OpenAI AgentKit / Claude Code / n8n 等业内主流 Agent 平台的标准能力集

---

## 一、结论总览

| 能力域 | 现状评级 | 说明 |
|---|---|---|
| Skill 安装（开源） | 🟡 部分具备 | GitHub sparse-clone 安装 + 本地 curated 清单已通，生态/搜索/版本管理缺 |
| Skill 自主生成 | 🔴 缺失 | 无诊断过程→playbook→新 skill 的沉淀链路 |
| 多数据源 | 🟡 部分具备 | OpenSearch/CH(日志通道)/Prom/PgSQL/MySQL/SQLite 已通；MariaDB 差标注、CH/ES 的 SQL 查询通道缺 |
| 服务拓扑 | 🔴 占位 | topology/trace skill 为空壳，TopoPage 无真实数据 |
| Token 消耗统计 | 🔴 完全缺失 | llm/client.ts 未捕获 usage，无成本核算 |
| 用户隔离 | 🔴 完全缺失 | 无认证中间件，approvals 硬编码 "demo-user"，sessions 无 user_id |
| 审批/安全网关 | 🟢 业内领先 | Policy Engine 五级风险 + argsHash 防篡改 + 全量审计 + 脱敏 |
| 评测框架 | 🟡 基础具备 | eval/cases 已有，缺 LLM-as-judge 与线上回流 |
| MCP | 🟡 半套 | 只有 client（gRPC linux-mcp-server），未暴露 MCP Server 模式 |

---

## 二、用户点名能力的逐项差距

### 1. 开源 Skills 安装与自主生成

**已有**：`skills/packages/`（installer.ts 支持 `installFromGitHub` sparse clone + loader 校验 + registry embedding 检索 + select 启停）；curated-skills.json 已对接 `openai/skills` 仓库（2 条）。

**差距**：
- [ ] **Skill 市场生态**：curated 清单只有 2 条，需扩充索引源（anthropics/skills、社区仓库列表），支持关键词搜索远程仓库
- [ ] **自主生成（Skill Factory）**：诊断结束 → 从时间线/结论提取 playbook → LLM 生成 SKILL.md + tools 定义 → 人工审核 → 入库。全链路缺失，这是差异化能力
- [ ] 版本管理 / 升级 / 卸载回滚
- [ ] 安装安全扫描（SKILL.md 内嵌命令 allowlist 校验、恶意指令检测）
- [ ] Skill 依赖声明与隔离执行（子进程沙箱）

### 2. 多数据源（MariaDB / ClickHouse / ES 等）

**已有**：日志后端 `elk | clickhouse | generic`；指标后端 Prometheus（多实例）；数据库后端 `sqlite | mysql | pg`（只读 SELECT 白名单）。

**差距**（按用户点名项）：
- [ ] **MariaDB**：协议与 MySQL 完全兼容，`mysql2` 驱动原生支持 → 只需在 UI/文档标注"MariaDB ✓"，加 URL scheme 识别
- [ ] **ClickHouse 作为 SQL 查询数据源**：目前只走日志四件套通道，`databaseSystems` 不含 clickhouse 类型 → 新增 `@clickhouse/client` + clickhouse 方言白名单（SHOW TABLES / DESCRIBE / SELECT）
- [ ] **Elasticsearch（ES 8+）**：现有 OpenSearch 客户端兼容 ES 7.x；ES 8.x 需引入 `@elastic/elasticsearch` 客户端或开启兼容头（`compatible-with: 8`），ELK Skill 的四件套接口不变
- [ ] 其他常见源：SQL Server / Oracle / MongoDB / Redis（可按需排期）
- [ ] 数据源元数据浏览：库表结构发现、字段采样、行数统计（Agent 生成 SQL 时需要 schema 上下文）
- [ ] 查询结果缓存 + 连接池 + 慢查询熔断

### 3. 服务拓扑生成与发现

**已有**：`skills/topology/tools.ts` 空占位；前端 TopologyPage 骨架；drawio skill（诊断流程图导出，非服务拓扑）。

**差距**：
- [ ] **K8s 拓扑发现**（无需额外数据源即可做）：Namespace → Workload → Pod → Service/Endpoint → Ingress 关系图，从 k8s API 聚合；加上 NetworkPolicy 依赖
- [ ] **指标驱动依赖推断**：从 Prometheus `istio_tcp_*` / kube-state-metrics 服务间流量指标推断调用关系
- [ ] **Trace 数据源接入**：Jaeger / Tempo / SkyWalking OTLP，拉取调用链构建真实拓扑（trace skill 同步落地）
- [ ] 拓扑与诊断联动：告警对象在拓扑上高亮、根因路径标注、一键跳转诊断会话
- [ ] 拓扑导出（drawio skill 已有导出能力，复用）

### 4. Token 消耗统计

**现状**：`llm/client.ts` 用 OpenAI SDK，响应中的 `usage`（prompt/completion/total tokens）完全未捕获；sessions 表无 token 列；无成本核算。

**差距**：
- [ ] runner 每次 LLM 调用捕获 `response.usage`，落库（timeline_events 或独立 llm_calls 表：session_id、model、prompt_tokens、completion_tokens、latency、cost）
- [ ] 模型单价表（可配置）→ 成本核算
- [ ] 聚合维度：会话 / 用户 / 模型 / 天；配额与限流（超阈值熔断）
- [ ] 前端：会话详情 token 消耗、全局用量仪表盘

### 5. 用户隔离与多租户

**现状**：无任何认证（`app.use(cors())` 裸奔）；`decideApproval(... "demo-user")` 硬编码；sessions/audit/approvals/alerts/knowledge 全部无 `user_id`；无 RBAC。

**差距**：
- [ ] **认证**：最小版本地用户表 + bcrypt + JWT 中间件；或对接 OIDC/LDAP（企业场景）
- [ ] **行级隔离**：user_id 贯穿 sessions/audit/approvals/alerts/skills/knowledge，所有查询强制 WHERE user_id
- [ ] **RBAC**：角色（admin/on-call/viewer）；审批权限分离——设计文档 §15 已规划"双人审批：发起人 ≠ 审批人"
- [ ] 数据源/主机/Skill 的按用户/团队授权
- [ ] API Key 管理（对外集成场景）

---

## 三、对标业内 Agent 标准能力的完整清单

### 已具备（🟢）

| 能力 | 说明 |
|---|---|
| Function-calling 编排循环 | runner.ts，`parallel_tool_calls: true` 已开启 |
| 流式输出 + 实时事件 | SSE/WS → 前端 Cortex 风格时间线 |
| 检查点与中断恢复 | session_checkpoints + resumeAgentTurn |
| 长期记忆 | session_memories + 自动抽取 |
| Human-in-the-loop 审批 | 五级风险 + argsHash + 审计，业内少见的完整度 |
| 上下文安全 | 脱敏 redact + `trust_level=untrusted_data` 防注入标注 |
| RAG 知识库 | incident_cases + embedding 相似检索 |
| 评测框架 | agent/eval cases + evaluate（缺 judge，见下） |
| MCP Client | gRPC + discovery + JWT |
| 结构化 Prompt 体系 | prompts.ts + 假设树/计划管理 |

### 缺失（🔴）或薄弱（🟡）

| # | 能力 | 业内参照 | 优先级建议 |
|---|---|---|---|
| 1 | Token/成本统计与配额 | LangFuse、OpenAI Usage | **P0**（改动小价值大） |
| 2 | 认证与多租户 | Dify workspace、Coze 团队空间 | **P0** |
| 3 | LLM 调用级 Trace 可观测 | LangSmith / LangFuse：每次调用的输入输出/延迟/token/成本全记录，OTel 导出 | **P0**（与 #1 同一条链路） |
| 4 | Skill 自主生成（Skill Factory） | Claude Code skill-creator 思路 | P1（差异化） |
| 5 | 拓扑/Trace 落地 | 借助 Jaeger/Tempo | P1 |
| 6 | ClickHouse/ES 查询数据源 | — | P1 |
| 7 | 定时任务 / 自动化运行（含告警自动触发诊断） | n8n、Dify workflow cron | P1 |
| 8 | 外部触发入口：Webhook / API 触发会话 | Dify API、Coze API | P1（告警联动依赖） |
| 9 | MCP Server 模式（把 InfraPilot 自身暴露为 MCP 工具供其他 Agent 调用） | 各主流平台互相调用趋势 | P2 |
| 10 | 多 Agent 协作 / 子 Agent 任务分解 | 设计文档 §15 已规划 | P2 |
| 11 | 沙箱代码执行（interpreter） | e2b / code interpreter | P2（SRE 场景做日志分析脚本很有用） |
| 12 | 结构化输出（JSON Schema 约束） | OpenAI structured outputs | P2 |
| 13 | 上下文超长自动压缩 | Claude/各家 summarization | P2（memoryStore 部分覆盖） |
| 14 | LLM-as-judge 评测 + 线上数据回流 | LangSmith evals | P2 |
| 15 | Artifact 文件管理（会话产物下载） | Claude Artifacts | P3 |
| 16 | A2A 协议 / Agent 互操作 | Google A2A | P3 |
| 17 | 端侧/CLI 入口（ChatOps） | 设计文档 §15 已规划 | P3 |

---

## 四、建议落地路线

### P0 — 两个 sprint 内可完成（高价值低改动）
1. **Token 统计 + LLM Trace**：`llm_calls` 表 + client.ts 捕获 usage + 模型单价配置 + 前端用量页（会话维度已有页面挂载点）
2. **最小认证与隔离**：users 表 + JWT 中间件 + user_id 贯穿三张核心表（sessions/audit/approvals）+ 前端登录页
3. **MariaDB 标注兼容** + **ClickHouse 数据源类型**（databaseSystems 扩展，SQL 只读白名单复用）

### P1 — 一个迭代
4. Skill Factory 自主生成（诊断结论 → playbook → 审核入库）
5. K8s 服务拓扑发现（纯 k8s API 聚合，不依赖新数据源）+ 拓扑页接真实数据
6. 告警自动触发诊断（webhook 入口 + P0 告警自动开会话）

### P2 — 按需排期
7. ES 8 客户端兼容、Trace 数据源（Jaeger/Tempo）、定时任务框架、MCP Server 模式、多 Agent、沙箱执行
