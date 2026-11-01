# InfraPilot Python Backend（py-server）

与 `server/`（Node/TypeScript）**API 契约完全一致**的 Python 实现，目标是把后端整体迁移到
Python（FastAPI）。既有接口（会话/告警/配置/数据源/技能等）保持字节级兼容；`web/` 已进一步
对接 Python 侧独有能力：用量统计与单价、服务拓扑、JWT 登录与用户管理、Skill Factory、
Trace 数据源、定时任务、LLM-as-judge 评测、会话产物下载、会话级免审批白名单，以及知识库
单条详情与逐次 LLM 调用明细。

## 运行

```bash
cd py-server
pip3 install -r requirements.txt
python3 -m infrapilot            # http://localhost:8787（与 Node 版同端口，二者择一启动）
```

环境变量（与 Node 版同名）：

- `PORT`（默认 8787）、`OPENAI_BASE_URL` / `GSK_API_KEY` / `OPENAI_API_KEY` / `REASONING_MODEL`
- `INFRAPILOT_DATA_DIR`（默认 `py-server/data`，与 Node 版 `server/data` 相互隔离）
- `INFRAPILOT_SKILLS_DIR`（默认复用 `server/skills` 下的 SKILL.md 技能包）
- `KUBECONFIG` / `KUBERNETES_SERVICE_HOST`（K8s Skill）
- `INFRAPILOT_REQUIRE_AUTH=1`（开启强制鉴权；默认关闭以兼容既有前端）
- `INFRAPILOT_FACTORY_USE_LLM=1`（Skill Factory 改用 LLM 生成，默认确定性模板）
- `INFRAPILOT_FACTORY_STRICT_TOOLS=1`（入库时强校验 `skill__tool` 引用是否注册）
- `INFRAPILOT_SCHEDULER=0`（关闭定时任务后台循环，默认开启）、`INFRAPILOT_SCHEDULER_TICK`（轮询秒数，默认 15）
- `LOG_BACKEND_TYPE=elk|es8`、`OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD`（ES8/OpenSearch 基本鉴权）
- `MCP_SERVER_MODE=stdio|http|true`（独立 MCP 进程，见下）、`MCP_SERVER_PORT`、`MCP_JWT_SECRET`
- `INFRAPILOT_MCP_ALLOW_WRITE=1`（放开 MCP 写类工具，默认仅只读）
- `INFRAPILOT_STRUCTURED_RCA=0`（关闭结论的 JSON Schema 约束输出，默认开启）
- `INFRAPILOT_CONTEXT_COMPRESS=0`（关闭会话内上下文压缩，默认开启）、`INFRAPILOT_CONTEXT_MAX_TOKENS`（压缩阈值，默认 60000）
- `INFRAPILOT_EVAL_CASES_DIR`（评测 case 目录；默认复用 `server/src/agent/eval/cases`）

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | FastAPI 骨架、SQLite（11 表 + 迁移）、时间线事件、WebSocket Hub、sessions/alerts CRUD | ✅ 已完成 |
| Phase 2 | Agent 可恢复执行循环、checkpoint、Policy Engine 五级风险、Command Gateway（审批 + argsHash 防篡改 + 审计）、跨会话记忆、知识库 RAG、Skill 注册与召回 | ✅ 已完成 |
| Phase 3 | 全部 Skill（共 59 个工具）：`linux`(16) `k8s`(11) `elk`(4) `clickhouse`(4) `prom`(3) `trace`(5) `knowledge`(3) `openstack`(7) `drawio`(2) `skills`(2) `subagent`(1) `interpreter`(1) `topology`(占位) | ✅ 已完成 |
| Phase 4 | `/api/config/*`（日志/指标/数据库/主机/LLM/MCP/记忆/模型单价）、`/api/data-sources/*`（Prometheus + 只读 SQL）、`/api/skills/*`（技能包 + drawio） | ✅ 已完成 |
| Phase 5 · P0 | Token 用量统计（`llm_calls` 表 + `GET /api/usage/summary`）；认证与 RBAC（`users` 表 + bcrypt + JWT + `/api/auth/*`）；MariaDB/ClickHouse/ES 方言标注 | ✅ 已完成 |
| Phase 5 · P1 | 告警接入（`PATCH /api/alerts/:id` + `POST /api/webhooks/alertmanager` + P0/P1 自动开会话诊断）；服务拓扑发现（`GET /api/topology`）；Skill Factory（`/api/skills/factory/*`） | ✅ 已完成 |
| Phase 5 · P2 | ES8 客户端兼容（REST + `compatible-with: 8`）、Trace 数据源（Jaeger/Tempo，5 工具）、定时任务框架（cron 表 + asyncio 循环 + `/api/schedules/*`）、MCP Server 模式（JSON-RPC `/api/mcp` + stdio）、多 Agent 子任务（`subagent__task`）、沙箱代码执行（`interpreter__run_python`） | ✅ 已完成 |
| Phase 5 · P2（§三 #12–#14） | 结构化输出（JSON Schema 约束 + 三级降级）、上下文超长自动压缩（会话内历史摘要）、LLM-as-judge 评测（`/api/eval/*` + CLI + 线上数据回流） | ✅ 已完成 |
| Phase 7 · P3 | Artifact 会话产物管理（`/api/artifacts/*`，工具产物自动登记）、A2A 协议服务端（Agent Card + `/api/a2a` JSON-RPC）、端侧 CLI / ChatOps（`python3 -m infrapilot.cli`） | ✅ 已完成 |
| Phase 6 | 契约对拍（`scripts/contract_diff.py`：静态路由表 + 双后端动态响应形状）、端口切换（`scripts/cutover_check.sh`：py-server 直接监听 8787，经 Vite 代理验证 `/api` + `/ws`）、双跑灰度（文档化策略） | ✅ 已完成 |

> 说明：Phase 5 的 P0/P1/P2 划分与 `docs/Agent能力差距分析.md` 第四节路线图一致。

## 验证

```bash
cd py-server
python3 -m pytest tests -q                    # 143 项：解析/脱敏/白名单/风险分级/网关/审批/Skill/路由/用量/认证/告警/ES8/定时任务/MCP/子 Agent/沙箱/结构化输出/上下文压缩/评测/产物/会话白名单/A2A(流式+重连)/CLI
./scripts/smoke_api.sh 8791                   # 76 项 HTTP/WS 端到端契约（需非沙箱环境：本地 socket + 线程）

# 离线评测（真实调用 Agent，消耗 LLM）
python3 -m infrapilot.eval_run http://localhost:8787

# Phase 6：契约对拍（自动起停 Node + Python 两个后端）
python3 scripts/contract_diff.py                  # 静态路由表 + 动态响应形状
python3 scripts/contract_diff.py --static-only    # 仅静态（无需 Node 依赖）

# Phase 6：端口切换验证（py-server 监听 8787 → Vite(5173) 代理 → 前端页面）
bash scripts/cutover_check.sh 8787 5173
```

> 本沙箱禁止进程创建本地 socket，且 `asyncio.to_thread` 在沙箱内退出时会挂起；
> `smoke_api.sh` 与含 `TestClient` 的用例需在放开沙箱的环境执行。

## 目录结构

```
infrapilot/
  main.py            # FastAPI 入口 + WebSocket /ws + 可选鉴权中间件 + {"error":...} 错误体
  routes/
    api.py           # sessions/alerts/demo/k8s/elk/knowledge/memories/topology
    config.py        # /api/config/*（日志/指标/数据库/主机/LLM/MCP/记忆/模型单价）
    datasources.py   # /api/data-sources/*（Prometheus 查询 + 只读 SQL）
    skills.py        # /api/skills/*（技能包列表/安装/启停 + drawio + Skill Factory）
    usage.py         # /api/usage/*（Token 用量/成本）
    auth.py          # /api/auth/*（登录/me/用户管理）
    schedules.py     # /api/schedules/*（定时任务 CRUD/校验/手动触发/状态）
    mcp.py           # /api/mcp（MCP JSON-RPC 端点）
    eval.py          # /api/eval/*（评测 case/judge/回流/评测记录）
    artifacts.py     # /api/artifacts/*（会话产物登记/列表/下载/删除）
    a2a.py           # /api/a2a（A2A JSON-RPC：message/send、message/stream、tasks/get、tasks/cancel、tasks/resubscribe）
  db.py              # SQLite 表结构 + 迁移（对应 db/db.ts）
  sessions.py        # 会话状态与时间线事件
  runner.py          # Agent 可恢复执行循环（含 usage 落库）
  orchestrator.py    # start/resume turn
  policy.py          # 风险五级分级
  gateway.py         # 唯一执行入口 + 审计
  auth.py            # users + bcrypt + JWT
  usage.py           # llm_calls 聚合 + 模型单价
  alerts_ingest.py   # Alertmanager webhook → alerts + 自动诊断
  skill_factory.py   # 会话 → SKILL.md 草稿 → 审核入库
  topology.py        # K8s 服务拓扑发现
  datasource_client.py # 日志数据源 REST 客户端（OpenSearch + ES8 兼容头）
  scheduler.py       # 定时任务框架（cron 解析 + asyncio 轮询 + 到期触发诊断）
  mcp_server.py      # MCP Server（JSON-RPC：initialize/tools/list/tools/call；stdio/http 传输）
  subagent.py        # 子 Agent 派发（独立会话 + 结论回传 + 递归护栏）
  interpreter.py     # 沙箱代码执行（rlimit + audit hook + 超时/输出截断）
  structured.py      # 结构化输出（JSON Schema 校验/抽取 + 三级降级调用 + 结论解析）
  compression.py     # 上下文超长自动压缩（token 估算 + LLM 摘要 + 确定性兜底）
  judge.py           # LLM-as-judge（schema 评分 + 离线启发式兜底）
  eval.py            # 评测框架（确定性 check + case 存储 + 线上回流）
  eval_run.py        # 评测 CLI（python3 -m infrapilot.eval_run [base]）
  artifacts.py       # 会话产物（白名单路径校验 + 从工具结果自动登记）
  a2a.py             # A2A 协议（Agent Card + Task↔Session 映射 + 产物透出 + message/stream / tasks/resubscribe SSE）
  cli.py             # 端侧 CLI / ChatOps（python3 -m infrapilot.cli）
  eval_cases/        # 内置 case（Node cases 目录不存在时的副本）
  skills/            # 各 Skill 的 ToolDef 与执行器（14 个模块）
  scripts/
    smoke_api.sh       # HTTP/WS 端到端冒烟（59 项）
    contract_diff.py   # Phase 6 契约对拍（Node vs Python：路由表 + 响应形状）
    cutover_check.sh   # Phase 6 端口切换验证（8787 + Vite 代理）
tests/               # pytest（纯离线；路由用例需线程，见上）
```

## P3 新增能力

### 会话产物管理（§三 #15）
- `artifacts` 表 + `/api/artifacts/*`：登记 / 列表 / 下载 / 删除；`GET /api/sessions/:id/artifacts` 按会话查看。
- **自动登记**：Command Gateway 在工具成功后从结果中提取产物（drawio 的 `output_path`、沙箱的
  `workdir` + `files`、批量 `outputs[]`），失败不影响工具主链路。
- **路径白名单**：只允许 `data/artifacts`、`data/diagrams`、`data/sandbox` 下的文件，`realpath` 校验防穿越；
  记录 `mime`/`size`/`sha256`，下载带 `Content-Disposition`。

### A2A 协议服务端（§三 #16）
- Agent Card：`GET /.well-known/agent.json`（同时提供 `/.well-known/agent-card.json`）。
- JSON-RPC：`POST /api/a2a`，实现 `message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`、`ping`。
- Task↔Session：task id 即会话 id；状态映射 `intake→submitted`、`planning/executing/reflecting/remediating→working`、
  `awaiting_approval→input-required`、`concluded→completed`、`closed→canceled`。
- `message/send` 支持 `configuration.blocking=true` 阻塞等待（带超时）；会话产物以 A2A `file` part 透出。
- `message/stream` 走 `text/event-stream`：先推完整 `Task` 快照，再推 `status-update`
  （状态变化 / assistant 文本 / RCA 结论）与 `artifact-update`（新登记产物），
  最后以 `final=true` 的 `status-update` 收尾；空闲期发送 `: ping` 心跳保持连接。
  Agent Card 声明 `capabilities.streaming=true`。
- `tasks/resubscribe` 支持断线重连：先回放已持久化时间线，再续订实时事件并收尾；
  每帧带 SSE `id:`（时间线事件 id），可用 `Last-Event-ID` 头或 `params.lastEventId`
  做增量补齐；任务无活跃轮次时回放完立即收尾。

### 端侧 CLI / ChatOps（§三 #17）
```bash
python3 -m infrapilot.cli ask "分析 islap 下 kafka 起不来的原因"   # 诊断 + 实时跟随时间线
python3 -m infrapilot.cli sessions / show <id> / artifacts <id> / judge <id> --offline
python3 -m infrapilot.cli --base http://host:8787 --json ask "..."   # 便于接入 Slack/飞书机器人
```
`--json` 输出原始 JSON；`--base`/`INFRAPILOT_BASE_URL`、`--token`/`INFRAPILOT_TOKEN` 控制连接与鉴权；
`judge` 返回码 0/2 表示 pass/fail，便于 CI 与 ChatOps 判断。

## Phase 6：契约对拍与端口切换

### 契约对拍（`scripts/contract_diff.py`）
两层比对，结论可复现：
- **静态路由表**：从 Node 源码提取 `router.<method>("<path>")` + 挂载前缀，与 FastAPI 路由表逐条比对。
  当前结果：**Node 68 条路由在 Python 侧全部存在（缺失 0）**，Python 额外追加 53 条（P0/P1/P2/P3 新增能力）。
- **动态响应形状**：隔离数据目录同时启动两个后端（Node 8788 / Python 8789），对同一批端点发请求，
  递归比较 JSON key/type 签名，并校验错误体是否都是 `{"error": ...}`。
  判定规则：**缺失字段/类型变化 = 破坏性**；**纯新增字段 = 兼容**（对 JS 前端安全）；
  Python 独有路由返回 200 而 Node 404 视为追加能力；真实集群端点（k8s）仅作信息性提示。
  当前结果：**契约一致**（仅 Python 侧追加字段/路由），错误体一致。

### 端口切换（`scripts/cutover_check.sh`）
前端 `web/vite.config.ts`（dev）与 `web/nginx.conf`（prod）都指向 `8787`/`infrapilot-server:8787`，
因此切换**无需改前端**，只要让 py-server 占用该端口：

```bash
# 1) 停掉 Node 后端；2) 以同样端口启动 Python 后端
cd py-server && PORT=8787 python3 -m infrapilot
# 3) k8s 环境：把 Deployment/Service 的镜像换成 py-server，Service 端口保持 8787
```

k8s 生产镜像见 `py-server/Dockerfile`（构建上下文为仓库根目录，需一并打包 `server/skills`）：

```bash
docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest .
```

对应的 Deployment/ConfigMap 已切到 Python 镜像（`server/k8s-manifests/infrapilot-server/`），
详见 `docs/deployment.md` 第 5、6 节。

`cutover_check.sh` 会启动 py-server(8787) + Vite(5173)，并验证：后端健康检查、前端页面、
经代理创建/查询会话、错误体、配置/用量/MCP 端点、前端已对接的 auth/topology/skill factory/
告警 PATCH、trace-systems/schedules/eval/artifacts、会话白名单 / 知识库详情 / 逐调用用量，
以及经代理的 WebSocket 事件投递。

### 双跑灰度（策略）
两个后端可同时运行（不同 `PORT` 与 `INFRAPILOT_DATA_DIR`）。灰度做法：
1. Node 保持 8787（全量流量），Python 跑 8790；
2. 在 nginx/vite 侧按权重或按路径分组切换（例如先切 `/api/config/*`、`/api/data-sources/*` 等只读前缀）；
3. 用 `contract_diff.py` + `smoke_api.sh` 对两侧定期对拍，`INFRAPILOT_REQUIRE_AUTH=1` 下核对认证行为；
4. 观察 `llm_calls` 用量与审计表无异常后，再把主流量切到 Python 并回收 Node 实例。
> 注意：两侧 `INFRAPILOT_DATA_DIR` 必须隔离，否则会同时写同一份 SQLite/runtime-config。

## P2 新增能力速览

### 会话级免审批白名单
`session_allowlist` 表 + `/api/sessions/:id/allowlist`（`GET`/`POST`/`DELETE`）：用户对某个
`skill.tool` 点「始终允许」后，**同一会话内**该工具后续调用免审批。安全约束：
- **仅 `medium` 风险**工具可加入（`high`/`critical` 仍强制人工审批，未注册工具直接拒绝）；
- 仍写入审批记录并走 Command Gateway 的 `argsHash` 防篡改校验，审计 `approved_by=session-allowlist`，
  时间线落 `approval_decision(auto=true)` 事件，全程可追溯；
- 白名单随会话生命周期存在，不做跨会话继承。

### ES 8 / OpenSearch 兼容
日志后端类型新增 `es8` / `elasticsearch`：走 `datasource_client` 的 httpx REST 通道并带
`compatible-with: 8` 兼容头，其余 OpenSearch 后端仍走 SDK；ELK Skill 四件套接口与索引模式解析不变。

### Trace 数据源（Jaeger / Tempo）
`trace` Skill 提供 5 个只读工具：`list_services` / `list_operations` / `find_traces` / `get_trace`
/ `get_dependencies`；后端来自 `/api/config/trace-systems`，未配置时回退 `JAEGER_URL` / `TEMPO_URL`。

### 定时任务
- `schedules` 表 + `/api/schedules/*`（CRUD、`POST /validate` 预览下次触发、`POST /:id/run` 手动触发）。
- 支持 5 段 cron（`分 时 日 月 周`，含 `*/n`、`a-b`、`a,b`、月份/星期英文名）与 `@every 30m`、`@hourly` 等。
- 后台 asyncio 轮询（默认 15s）到点自动开会话并触发一次 Agent 诊断；`INFRAPILOT_SCHEDULER=0` 可关闭。

### MCP Server 模式
把 InfraPilot 自身暴露为标准 MCP 工具（`{skill}__{tool}`，共 59 个），供其他 Agent 调用：
```bash
# HTTP（随主服务提供）：POST http://localhost:8787/api/mcp
curl -s -X POST localhost:8787/api/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 独立进程：stdio 或 http
MCP_SERVER_MODE=stdio python3 -m infrapilot.mcp_server
MCP_SERVER_MODE=http MCP_SERVER_PORT=8443 python3 -m infrapilot.mcp_server
```
默认只放行只读工具（写类返回"需审批"）；配置 `MCP_JWT_SECRET` 后需 `Authorization: Bearer <jwt>`。

### 多 Agent（子 Agent）
`subagent__task` 派发一个独立会话完成子任务并回传结构化结论（结论/置信度/证据数/是否等待审批），
用于隔离长链路调查、避免主会话上下文膨胀；递归深度上限 2。

### 沙箱代码执行
`interpreter__run_python`（风险 `medium`，需审批）在 `python3 -I` 子进程中运行代码：独立工作目录、
rlimit（CPU/内存/文件大小/句柄数）、audit hook 拦截网络 / 子进程 / ctypes / 沙箱外写文件、硬超时、输出截断、脱敏。
> 说明：这是进程级沙箱（护栏），不等价于容器/gVisor 级安全边界；生产环境建议再包一层容器。

### 结构化输出（§三 #12）
`structured.py` 提供 JSON Schema 约束的 LLM 调用，三级降级保证不阻塞主链路：
`response_format=json_schema(strict)` → `json_object` + 内嵌 schema → 纯文本 + JSON 抽取，最后用内置
轻量校验器（type/required/properties/items/enum/min/max）验证。已接入结论生成路径
（`_conclude_from_existing_evidence` 请求 schema 化结论，解析失败自动回退原有正则解析），
并被 judge / 压缩 / 评测复用。`INFRAPILOT_STRUCTURED_RCA=0` 可关闭。

### 上下文超长自动压缩（§三 #13）
`compression.py` 在每轮 LLM 调用前估算 `checkpoint.history` token 数，超阈值时把较早历史压成一条
system 摘要（LLM 结构化摘要，失败则用确定性摘要兜底），保留 system prompt + 最近 N 条并发送
`context_compressed` 时间线事件。切分点会避免把 `tool` 结果与它的 `assistant.tool_calls` 拆散。

### LLM-as-judge 评测 + 线上数据回流（§三 #14）
- `judge.py`：按「证据支撑 / 根因准确 / 可执行性 / 幻觉风险」四维打分，输出 `score/verdict/rationale`；
  LLM 不可用时自动降级为确定性启发式评分。
- `eval.py`：确定性 check（`hasTool` / `rootCauseMatches` / `hypothesisStatus`，与 Node 逐字对齐）
  + 新增 `judgeScore` 阈值 check；case 复用 `server/src/agent/eval/cases/*.json`。
- **线上回流**：`POST /api/eval/promote` 把真实会话固化为回归 case（自动带上用过的工具、金标准结论与
  judge 阈值）；`POST /api/eval/judge` 随时打分；`GET /api/eval/runs` 查历史记录；
  `python3 -m infrapilot.eval_run <base>` 跑全套（参考 `docs/agent-eval.md`）。

## 新增 Skill 的方式

1. 在 `infrapilot/skills/<name>.py` 中导出 `TOOLS: list[ToolDef]` 与 `async def execute(tool, args) -> ToolExecutionResult`
2. 在 `infrapilot/skills/__init__.py` 的 `_MODULES` 中注册（key 为 ToolDef 里的 `skill` 名）

Policy Engine 与 Command Gateway 会自动感知（风险等级来自 `ToolDef.risk`）。

## 与 Node 版的差异（已确认）

- `redact`/`plan` 等正则用 `[0-9]` 等价替换 JS `\d` 的 Unicode 语义，输出保持一致。
- 错误体统一为 `{"error": "..."}`（Node/Express 风格），非 FastAPI 默认的 `detail`。
- 远程主机执行（`host != "local"`）尚未接入 MCP/SSH 通道，返回明确的“尚未实现”错误。
- 后台日志采集循环（logShipper）未移植；`/config/log-systems/:id/ship-status` 返回“尚未采集”占位状态。
- P0 的认证/用量，P2 的定时任务 / MCP Server / 子 Agent / 沙箱执行 / 结构化输出 / 上下文压缩 /
  LLM-as-judge / 会话级免审批白名单，以及 P3 的会话产物 / A2A / CLI 均为 Python 版新增能力
  （Node 版缺失；Node 仅有确定性 check 的 CLI 评测）。
- P3 的 A2A 与 MCP Server 均为**追加**端点，契约对拍确认 Node 68 条路由在 Python 侧全部保留。
- P2 的「MCP Server 模式」按差距分析 §3 #9 落地为**标准 MCP 协议**（JSON-RPC 2.0），
  而非 Node 版 gRPC `linux-mcp-server`（后者需 protoc 生成的桩，Python 环境未预装 `grpc_tools`）。
