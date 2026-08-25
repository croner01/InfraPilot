# InfraPilot 前端改版（方案 C）设计文档

| 项目 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-08-25 |
| 状态 | 设计确认稿，待用户审阅 |
| 范围 | 前端布局重构 + 对话区 Kimi 式改版 + 组件库/主题/图表/推理树/测试基建 |
| 配套原型 | `prototypes/m0.html`（可点击静态原型，已确认） |

---

## 1. 背景与目标

当前前端存在四个问题：

1. 对话区是"事件日志"而非"对话"：13+ 种事件类型全部渲染成"彩色图标 + 标题 + 内容"的独立卡片，用户消息和 AI 结论没有视觉主权。
2. 信息没有层级：用户问题、AI 正文、工具执行、证据、结论全部平铺，根因结论只是时间线里的一条普通条目。
3. Markdown 渲染器只有 7 行正则（`formatMarkdown`），只支持粗体/行内码/代码块/换行，无法呈现专业排版。
4. 代码结构是巨石：`web/src/App.tsx` 1151 行、`web/src/styles/app.css` 3949 行单文件，无测试基建、无组件库、无主题系统。

目标：将前端改造为**专业、清晰、明确的 AI SRE 运维工作台**，对话输出对齐 Kimi 风格（无边框内容展示、过程折叠、引用角标、干净排版），并按方案 C 完整落地：设计系统、组件库、Storybook、测试、告警中心、图表与推理树。

## 2. 已确认的设计决策

| 决策项 | 结论 |
|---|---|
| 方案 | C（全面改版，分里程碑交付） |
| 主题 | 浅色优先；主题机制按双主题设计（token 预留深色），深色 M8 补全 |
| 布局 | 双栏：左对话 + 右统一调查面板；右栏可折叠 |
| 右栏结构 | 三个 Tab：调查过程 / 证据链 / 对象上下文 |
| 对话区 | Kimi 式：用户右对齐浅色底、AI 无框纯排版、内容列 max-width 760px 居中 |
| 过程展示 | 工具/状态/证据全部收进可折叠"过程小节"，默认全折叠 + 顶部进度摘要 |
| 结论 | 对话底部常驻结论卡片（根因/置信度/影响面/修复建议/审批），正文证据用 [证据#N] 角标回链 |
| 视觉方向 | "精密工程台面"：克制的配色、明确的层级、精确的 1px 边框 |
| 主色 | 工程青 #0F766E |
| 字体 | IBM Plex Sans（西文 UI）+ IBM Plex Mono（代码/日志/ID）+ 中文系统回退 |
| 图标 | 统一内联 SVG（stroke 1.5、20px），emoji 仅限空态插画 |
| 首屏 | 未选中会话时显示"服务健康总览 + 最近告警 + 快捷入口" |
| 告警入口 | "告警中心"为左导航一级入口，告警列表提供"一键开查" |

## 3. 信息架构与布局

```
┌──────────────────────────────────────────────────────────┐
│ 顶栏：品牌 · 连接状态 · 待审批 n · 告警 n        + 新建会话 │
├────────┬──────────────────────────────┬──────────────────┤
│ 左导航  │       中央工作台              │ 右栏（可折叠）     │
│ 告警中心│  对话区（Kimi 式）            │ 调查过程/证据链/  │
│ 会话中心│  过程小节（默认折叠）          │ 对象上下文        │
│ 知识库  │  结论卡片 + 修复 + 审批       │                  │
│ 拓扑   │                              │                  │
│ 技能   │                              │                  │
│ 设置   │                              │                  │
└────────┴──────────────────────────────┴──────────────────┘
```

### 3.1 顶栏（全局状态）

- 左侧：品牌标识 + 产品名 + 副标题。
- 右侧：连接状态 pill、待审批数 pill、活跃告警数 pill、"+ 新建会话"主按钮。
- 待审批/告警数变化时 pill 高亮（M2 先静态，M5 接真实数据）。

### 3.2 左导航

- 工作区：告警中心（含活跃告警数 badge）、会话中心。
- 资源：知识库、拓扑、技能、设置。
- 当前选中项用 `accent-soft` 底 + 工程青文字标识。

### 3.3 中央工作台

- 未选中会话：显示告警中心视图（服务健康网格 + 最近告警 + 快捷入口）。
- 选中会话：显示会话工作台（会话头 + 对话区 + 底部输入框；右栏为统一调查面板）。
- 会话头：标题、会话 ID（等宽字体、可复制）、状态、迭代/证据/工具统计。

### 3.4 右栏（统一调查面板）

- 宽度 356px，`border-left` 分隔，可整体折叠（折叠后对话区全宽）。
- 三个 Tab：
  - **调查过程**：假设树（M7）+ 工具调用记录（M3 起先显示工具列表）。
  - **证据链**：证据卡片列表，支持来自正文角标的高亮定位。
  - **对象上下文**：当前调查对象详情（见 §5.4）。

## 4. 对话区规范（Kimi 式）

### 4.1 消息模型

对话区只保留两种身份的内容：

1. **对话本体**：
   - 用户消息：右对齐、`accent-soft` 浅底、无边框、圆角 12px（右上角 4px）。
   - AI 正文：左对齐、无边框无背景、30px 工程青头像；内容用排版层级表达结构。
2. **过程小节**：工具执行、状态更新、证据收集收进一个可折叠分组，不单独占用视觉空间。

### 4.2 内容容器与排版

- 对话列内 `max-width: 760px` 居中，条目间距 24px。
- AI 正文：15px / 行高 1.7；标题层级 15/16/18px；列表、表格、引用、链接均支持。
- Markdown 渲染：引入 `react-markdown` + 消毒（替换现有 7 行正则 `formatMarkdown`），封装为 `web/src/lib/markdown.ts`。

### 4.3 代码与日志块

- 浅色主题下代码块保持深色底（#0F172A），等宽字体，右上角语言标签 + 复制按钮。
- 日志内容按级别着色：ERROR 红 / WARN 琥珀 / INFO 蓝；暂不做语法高亮。

### 4.4 过程小节

- 一行浅色分组头："诊断过程 · 已执行 N 个工具 · 收集 M 条证据"，默认**全折叠**。
- 展开后为紧凑工具行：状态（✓/运行中）+ 等宽工具名 + 耗时。
- 顶部进度摘要（stream-line）在 Agent 运行期间显示当前动作，不打断内容流。

### 4.5 结论卡片

- 位于对话底部、输入框上方，常驻展示（边框 + 左侧 3px 工程青强调线）。
- 内容：标题"根因分析结论" + 置信度 pill + 根因文本 + 证据角标链 + 影响面 + 修复步骤（含风险等级 badge）+ 审批/拒绝按钮。
- 正文中的证据引用以 `[证据#N]` 角标呈现，点击后右栏切换到"证据链"并高亮定位（前端由 `EvidenceCitation` 组件 + 事件实现）。

### 4.6 空态

- 去掉大圆球"等待开始"。
- 未选中会话时显示告警中心视图；会话内无事件时显示简洁引导 + 三张快捷入口卡（排查 Pod 异常 / 查询日志 / 查看告警）。

## 5. 右栏调查面板细则

### 5.1 调查过程（M7 完整，M3 先展示工具记录）

- 假设卡片：状态色条（已确认=绿 / 已排除=灰）+ 状态标签 + 假设文本 + 证据角标。
- 工具记录：等宽工具名 + 状态 + 耗时，与过程小节内容一致。

### 5.2 证据链

- 证据卡片：类型标签（等宽小字）+ 置信度 + 摘要 + 原始内容块 + 采集时间。
- 支持 `ev-card--highlight` 高亮态，配合正文/结论角标定位。

### 5.3 对象上下文

当前 Pod 静态字段信息太少，按以下结构丰富：

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 对象头 | 名称 + 状态 dot + 状态 badge | 现有 Pod API |
| 字段网格 | 命名空间/节点/资源限额/重启次数/IP/启动时间 | 现有 Pod API |
| 资源曲线 | 内存/CPU 近 30 分钟 sparkline | M6 指标数据源 |
| 最近日志 | 级别着色日志行 | M6 新增只读查询端点 |
| 关联告警 | 告警列表 | M5 告警数据 |
| 操作 | "就此对象发起诊断" | 现有会话 API |

M0-M4 阶段对象上下文用 mock 数据占位，M5/M6 接真实数据。

## 6. 告警中心

- **服务健康网格**：服务卡片（状态 dot、名称、副本/元信息、sparkline、关键指标），异常服务红色描边。
- **最近告警列表**：等级 badge（P0 红 / P1 琥珀 / P2 蓝）、标题、来源、时间、处理状态、"一键开查"按钮（点击创建/进入诊断会话）。
- **快捷入口**：排查 Pod 异常 / 查询日志 / 查看告警。
- M5 起接入后端 `/api/alerts`（见 §7.4）。

## 7. 数据契约变更

### 7.1 Markdown 与样式（纯前端）

- `web/src/lib/markdown.ts`：react-markdown + sanitize 封装。
- `web/src/styles/tokens.css`：设计 token（浅色默认 + `[data-theme="dark"]` 预留覆盖）。

### 7.2 TimelineEvent 新增事件类型

| 事件 | payload | 里程碑 |
|---|---|---|
| `hypothesis_update` | `{ hypothesis: Hypothesis }` | M7 |
| `process_summary` | `{ executed: number, evidence: number, current?: string }`（前端可自行聚合，事件为可选增强） | M3 |
| `alert_created` | `{ alert: Alert }` | M5 |

### 7.3 Evidence 扩展（M6）

```ts
interface Evidence {
  id: string;
  sourceSkill?: string;
  type: string; // 'log_cluster' | 'metric' | 'k8s_event' | ...
  content: any;
  confidence: number;
  collectedAt: string;
  summary: string;
  chart?: { series: { name: string; points: [number, number][] }[] };
}
```

### 7.4 Alert 模型与接口（M5）

```ts
interface Alert {
  id: string;
  severity: 'p0' | 'p1' | 'p2';
  title: string;
  source: string;   // 'Prometheus' | 'node_exporter' | ...
  service: string;
  status: 'firing' | 'resolved' | 'acknowledged';
  startedAt: string;
  sessionId?: string;
}
```

- 后端新增 `GET /api/alerts`；demo seed 提供 3 条告警；Alertmanager webhook 接收列为二期（设计文档 §11.5 既有规划）。

### 7.5 Hypothesis 模型（M7）

```ts
interface Hypothesis {
  id: string;
  statement: string;
  status: 'active' | 'confirmed' | 'ruled_out';
  evidenceIds: string[];
  toolCallIds: string[];
  updatedAt: string;
}
```

- `AgentSession` 增加 `hypotheses: Hypothesis[]`；runner 在计划阶段生成假设、执行/反思阶段更新状态并 emit `hypothesis_update`；`sessionStore` 持久化同步扩展。

### 7.6 对象日志只读端点（M6）

- `GET /api/objects/:namespace/:name/logs?since=30m`：复用 ELK skill 查询逻辑，readonly 权限，供右栏"最近日志"使用。

## 8. 组件与文件结构

```
web/src/
  components/
    console/          # 布局骨架
      TopBar.tsx
      SideNav.tsx
      Workspace.tsx
      RightPanel.tsx
    conversation/     # 对话区
      Conversation.tsx
      MessageUser.tsx
      MessageAssistant.tsx
      ProcessSection.tsx
      StreamStatusLine.tsx
      Composer.tsx
    conclusion/
      ConclusionCard.tsx
      EvidenceCitation.tsx
    panels/           # 右栏
      InvestigationPanel.tsx
      HypothesisTree.tsx
      EvidenceList.tsx
      ObjectContext.tsx
    alerts/
      AlertCenter.tsx
      HealthGrid.tsx
      AlertList.tsx
    ui/               # 基础组件库
      Button.tsx / Badge.tsx / Card.tsx / Tabs.tsx / Dialog.tsx
      CodeBlock.tsx / Markdown.tsx / Sparkline.tsx
  lib/
    markdown.ts
    charts.ts         # uPlot 封装（M6）
  styles/
    tokens.css
    base.css
```

拆分原则：现有 `App.tsx`/`app.css` 按上述目录逐步迁移，每个里程碑保持 `npm run build` 通过；不一次性重写。

## 9. 视觉系统

### 9.1 设计 token（浅色默认）

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | #F6F7F9 | 页面底 |
| `--panel` | #FFFFFF | 卡片/侧栏/右栏 |
| `--border` | #E3E6EA | 1px 分隔 |
| `--text / --text-2 / --text-3` | #1A1D21 / #5A6472 / #8A94A3 | 主/次/弱文本 |
| `--accent` | #0F766E | 主色（按钮/选中/链接/焦点环） |
| 语义色 | 红 #DC2626 / 琥珀 #D97706 / 绿 #059669 / 蓝 #2563EB | 风险与状态 |
| `--code-bg` | #0F172A | 深色代码块 |

### 9.2 字体与字号

- 西文：IBM Plex Sans（UI/正文）、IBM Plex Mono（代码/日志/ID/时间）。
- 中文回退：PingFang SC / Microsoft YaHei / Noto Sans SC。
- 字号：对话正文 15px、界面 13px、紧凑表格 13px、标题 16/18/22px；数字使用 tabular-nums。

### 9.3 形状与层次

- 圆角：控件 6px、卡片 8px、对话框 12px。
- 阴影极轻：1px 边框 + 极淡投影；交互态用边框变色 + 2px 焦点环。
- 图标：统一内联 SVG（stroke 1.5、20px）；emoji 仅限空态插画。
- 动效：120-160ms 淡入、骨架屏加载；不做弹跳类动画。

### 9.4 风险色映射（全局统一）

readonly=蓝 / low=绿 / medium=琥珀 / high=橙（#EA580C）/ critical=红。

## 10. 测试策略

- 组件单测：Vitest + React Testing Library；覆盖 MessageAssistant（Markdown/引用角标）、ProcessSection（折叠）、ConclusionCard、HypothesisTree、Sparkline、ApprovalCard、AlertList。
- Storybook：每个 `ui/` 组件 1-2 个 story；3 个页面级 story（告警中心、对话区、右栏）。
- E2E（M8，Playwright）：建会话 → 发送 → 工具执行 → 审批 → 结论渲染。
- 验收门槛：每个里程碑 `npm run build` 通过 + 新增组件测试通过。

## 11. 里程碑计划

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M0 | 静态可点击原型 | ✅ 已完成（`prototypes/m0.html`，用户已确认） |
| M1 | 工程地基 | 引入 react-markdown、@fontsource/ibm-plex-sans/mono、uPlot、vitest、@testing-library/react、storybook；tokens.css + 主题机制；vitest/RTL/Storybook 配置跑通；build 通过 |
| M2 | 布局骨架 | TopBar/SideNav/Workspace/RightPanel 落地；告警中心静态页；导航切换、右栏折叠可用 |
| M3 | 对话区重构 | Markdown 渲染升级；用户/AI 消息组件；过程小节折叠 + 进度摘要；空态 |
| M4 | 结论卡片 | ConclusionCard + [证据#N] 角标联动右栏高亮 |
| M5 | 告警数据 | 后端 Alert 模型 + seed + `/api/alerts`；前端接真实接口 |
| M6 | 图表与对象数据 | Evidence.chart 契约；Sparkline（uPlot）；对象日志只读端点 |
| M7 | 推理树 | 后端 Hypothesis 模型 + `hypothesis_update`；前端 HypothesisTree |
| M8 | 打磨收尾 | 深色主题切换；动效走查；E2E；组件测试补全；全量视觉走查清单通过 |

## 12. 风险与依赖

1. **回归面大**：布局与对话区重构影响现有全部页面，每里程碑需手动回归审批流与 WebSocket 实时事件。
2. **后端依赖顺序**：M5（告警）和 M7（推理树）依赖后端改动，不能纯前端完成；前端先以 mock 数据开发交互。
3. **npm 网络限制**：实现阶段安装新依赖需要一次审批。
4. **巨石拆分**：App.tsx / app.css 拆分过程中需保持行为一致，按组件逐步迁移。

## 13. 明确不做（YAGNI）

- 不做移动端适配（桌面优先）。
- 不做语法高亮（日志按级别着色即可）。
- 不做 Storybook 视觉回归测试。
- 不做多语言 i18n。
- 不做推理树"并行假设验证"（当前 runner 为单线程顺序循环，M7 先做顺序树）。

## 14. 后续可决策项（非阻塞）

- 对象日志端点鉴权/访问范围（M6 确定）。
- 深色主题精确色值（M8 确定）。
- 告警 webhook 真实接入（Alertmanager，二期）。
