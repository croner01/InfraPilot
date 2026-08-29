# InfraPilot 前端改版 M5（告警后端数据）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后端新增告警数据模型、demo seed 与 `GET /api/alerts` 接口，前端告警中心从静态 demo 切换为真实接口数据，TopBar/SideNav 的活跃告警数改为实时计算。

**Architecture:** 后端在 `server/src/db/db.ts` 增加 `alerts` 表与 store 函数，`server/src/demo/seedAlerts.ts` 幂等播种 3 条 demo 告警（服务启动时调用），`server/src/routes/api.ts` 新增 `GET /api/alerts`（支持 status/severity 过滤）；前端 `web/src/lib/api.ts` 增加 `fetchAlerts`，`AlertCenter` 改为受控组件（接收 alerts/loading/error），App 挂载时拉取并在 TopBar 计算活跃告警数。

**Tech Stack:** 后端 Express + better-sqlite3 + Vitest（globals: true，共享临时数据目录）；前端 React 19 + Vitest。

**前置依赖：** M1-M4 已完成；后端测试需要先在 worktree 的 `server/` 下执行 `npm ci`。

**执行前注意：**
- 工作目录分别为 `.worktrees/frontend-redesign-m1/server` 与 `.worktrees/frontend-redesign-m1/web`。
- 代码编辑通过 apply_patch 写入 `.worktrees/frontend-redesign-m1/` 路径。
- 提交命令单独执行（不要与测试命令用 `&&` 串联）。
- 服务端启动完整集成验证依赖 K8s/OpenSearch 环境，本计划以 store/路由单元测试 + 前端测试/构建为验收；`GET /api/alerts` 路由按 server 现有 `callRoute` 模式（不 listen）测试。

---

### Task 0: 准备 server 测试环境（前置）

**Files:** 无代码改动。

- [ ] **Step 1: 安装 server 依赖**

Run: `npm ci`

Expected: 成功（若网络受限，使用已批准的前缀重试）。

- [ ] **Step 2: 基线测试**

Run: `npm test`

Expected: 现有 server 测试全部通过（作为改动前基线）。

---

### Task 1: 后端 Alert 类型与数据表（TDD）

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/db/db.ts`
- Create: `server/src/db/alerts.test.ts`

- [ ] **Step 1: 写失败测试**

Create `server/src/db/alerts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db, insertAlert, listAlerts, getAlert } from "./db.js";

describe("alerts store", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM alerts").run();
  });

  it("inserts and reads back an alert", () => {
    insertAlert({
      id: "a1",
      severity: "p0",
      title: "order-api Pod CrashLoopBackOff",
      source: "order-service/order-api · Prometheus",
      service: "order-api",
      status: "firing",
      started_at: "2026-08-25T10:24:00Z",
      session_id: null,
    });
    const row = getAlert("a1");
    expect(row?.severity).toBe("p0");
    expect(row?.status).toBe("firing");
    expect(row?.title).toBe("order-api Pod CrashLoopBackOff");
  });

  it("lists alerts with status and severity filters", () => {
    insertAlert({
      id: "a1",
      severity: "p0",
      title: "t1",
      source: "s",
      service: "svc1",
      status: "firing",
      started_at: "2026-08-25T10:24:00Z",
      session_id: null,
    });
    insertAlert({
      id: "a2",
      severity: "p1",
      title: "t2",
      source: "s",
      service: "svc2",
      status: "acknowledged",
      started_at: "2026-08-25T09:00:00Z",
      session_id: null,
    });
    expect(listAlerts({ status: "firing" })).toHaveLength(1);
    expect(listAlerts({ severity: "p1" })).toHaveLength(1);
    expect(listAlerts()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/db/alerts.test.ts`

Expected: FAIL（`insertAlert` 未定义 / `no such table: alerts`）。

- [ ] **Step 3: 添加 Alert 类型**

`server/src/types.ts` 末尾新增：

```ts
export type AlertSeverity = "p0" | "p1" | "p2";
export type AlertStatus = "firing" | "resolved" | "acknowledged";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  source: string;
  service: string;
  status: AlertStatus;
  startedAt: string;
  sessionId?: string;
}
```

- [ ] **Step 4: 添加 alerts 表与 store 函数**

`server/src/db/db.ts` 的 `db.exec(\`...\`)` 中、`skills` 表之后追加：

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  service TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  session_id TEXT
);
```

在 `db.ts` 文件末尾（`listAwaitingApprovalSessions` 之后）追加：

```ts
export interface AlertRow {
  id: string;
  severity: string;
  title: string;
  source: string;
  service: string;
  status: string;
  started_at: string;
  session_id: string | null;
}

export function insertAlert(row: AlertRow) {
  db.prepare(
    `INSERT OR IGNORE INTO alerts (id, severity, title, source, service, status, started_at, session_id)
     VALUES (@id, @severity, @title, @source, @service, @status, @started_at, @session_id)`
  ).run(row);
}

export function listAlerts(options?: { status?: string; severity?: string }): AlertRow[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (options?.status) {
    clauses.push("status = @status");
    params.status = options.status;
  }
  if (options?.severity) {
    clauses.push("severity = @severity");
    params.severity = options.severity;
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM alerts${where} ORDER BY started_at DESC`).all(params) as AlertRow[];
}

export function getAlert(id: string): AlertRow | undefined {
  return db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as AlertRow | undefined;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/db/alerts.test.ts`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/db/db.ts src/db/alerts.test.ts
git commit -m "feat(server): add alerts table and store"
```

---

### Task 2: 告警 demo seed（TDD）

**Files:**
- Create: `server/src/demo/seedAlerts.ts`
- Create: `server/src/demo/seedAlerts.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `server/src/demo/seedAlerts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db, listAlerts } from "../db/db.js";
import { seedAlerts } from "./seedAlerts.js";

describe("seedAlerts", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM alerts").run();
  });

  it("seeds demo alerts and is idempotent", () => {
    expect(seedAlerts()).toBe(3);
    expect(seedAlerts()).toBe(3);
    expect(listAlerts()).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/demo/seedAlerts.test.ts`

Expected: FAIL，错误为 `Cannot find module './seedAlerts.js'`。

- [ ] **Step 3: 实现 seedAlerts**

Create `server/src/demo/seedAlerts.ts`:

```ts
import { insertAlert, listAlerts } from "../db/db.js";

const demoAlerts = [
  {
    id: "alert-order-api-oom",
    severity: "p0",
    title: "order-api Pod CrashLoopBackOff",
    source: "order-service/order-api · Prometheus",
    service: "order-api",
    status: "firing",
    startedAt: "2026-08-25T10:24:00Z",
  },
  {
    id: "alert-payment-5xx",
    severity: "p1",
    title: "payment-service 5xx 上升",
    source: "pay/payment-service · Prometheus",
    service: "payment-service",
    status: "firing",
    startedAt: "2026-08-25T10:02:00Z",
  },
  {
    id: "alert-node08-disk",
    severity: "p2",
    title: "node-08 磁盘使用率 > 80%",
    source: "k8s-node · node_exporter",
    service: "node-08",
    status: "acknowledged",
    startedAt: "2026-08-25T09:41:00Z",
  },
] as const;

/** 幂等播种：表内已有数据时直接返回现有数量，避免重复插入 */
export function seedAlerts(): number {
  const existing = listAlerts();
  if (existing.length > 0) return existing.length;
  for (const alert of demoAlerts) {
    insertAlert({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      source: alert.source,
      service: alert.service,
      status: alert.status,
      started_at: alert.startedAt,
      session_id: null,
    });
  }
  return demoAlerts.length;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/demo/seedAlerts.test.ts`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 服务启动时播种**

`server/src/index.ts` 中 `await skillStore.init();` 之后追加：

```ts
    // 幂等播种 demo 告警（M5：真实 Alertmanager webhook 为二期）
    const { seedAlerts } = await import("./demo/seedAlerts.js");
    const seeded = seedAlerts();
    if (seeded > 0) console.log(`[Alert Seed] ${seeded} alerts ready`);
```

- [ ] **Step 6: Commit**

```bash
git add src/demo/seedAlerts.ts src/demo/seedAlerts.test.ts src/index.ts
git commit -m "feat(server): seed demo alerts on startup"
```

---

### Task 3: GET /api/alerts 路由（TDD）

**Files:**
- Modify: `server/src/routes/api.ts`
- Create: `server/src/routes/alerts.test.ts`

- [ ] **Step 1: 写失败测试**

Create `server/src/routes/alerts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { db } from "../db/db.js";
import { seedAlerts } from "../demo/seedAlerts.js";
import { apiRouter } from "./api.js";

/** 不监听端口，直接以函数方式调用 express app（沙箱禁止 listen） */
function callRoute(
  app: express.Express,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const [path, queryString] = url.split("?");
    const query = Object.fromEntries(new URLSearchParams(queryString ?? ""));
    const req = { method, url: path, body, headers: {}, params: {}, query } as any;
    let statusCode = 200;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: any) {
        resolve({ status: statusCode, body: data });
        return res;
      },
      send() {
        resolve({ status: statusCode, body: undefined });
        return res;
      },
      setHeader() {
        return res;
      },
    } as any;
    app(req, res, (err: unknown) => (err ? reject(err) : resolve({ status: statusCode, body: undefined })));
  });
}

describe("alerts API", () => {
  let app: express.Express;

  beforeEach(() => {
    db.prepare("DELETE FROM alerts").run();
    seedAlerts();
    app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
  });

  it("lists seeded alerts with camelCase fields", async () => {
    const res = await callRoute(app, "GET", "/api/alerts");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(3);
    expect(res.body.alerts[0].startedAt).toBeTruthy();
    expect(res.body.alerts[0].severity).toBe("p0");
  });

  it("filters by status", async () => {
    const res = await callRoute(app, "GET", "/api/alerts?status=firing");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(2);
    expect(res.body.alerts.every((a: { status: string }) => a.status === "firing")).toBe(true);
  });

  it("filters by severity", async () => {
    const res = await callRoute(app, "GET", "/api/alerts?severity=p2");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].id).toBe("alert-node08-disk");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/routes/alerts.test.ts`

Expected: FAIL（404 / 无 `/api/alerts` 路由）。

- [ ] **Step 3: 实现路由**

`server/src/routes/api.ts` 的 import 区（`import { listAuditBySession, ... } from "../db/db.js";`）增加 `listAlerts`：

```ts
import { listAuditBySession, decideApproval, getApproval, listTimelineEvents, listAlerts } from "../db/db.js";
```

在 `apiRouter.get("/sessions/:id/events", ...)` 之后新增：

```ts
apiRouter.get("/alerts", (req, res) => {
  try {
    const { status, severity } = req.query;
    const rows = listAlerts({
      status: status ? String(status) : undefined,
      severity: severity ? String(severity) : undefined,
    });
    res.json({
      alerts: rows.map((row) => ({
        id: row.id,
        severity: row.severity,
        title: row.title,
        source: row.source,
        service: row.service,
        status: row.status,
        startedAt: row.started_at,
        sessionId: row.session_id ?? undefined,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/routes/alerts.test.ts`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.ts src/routes/alerts.test.ts
git commit -m "feat(server): add GET /api/alerts with filters"
```

---

### Task 4: 前端 Alert 类型与 API 客户端

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: 添加前端 Alert 类型**

`web/src/lib/types.ts` 末尾新增：

```ts
export type AlertSeverity = 'p0' | 'p1' | 'p2';
export type AlertStatus = 'firing' | 'resolved' | 'acknowledged';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  source: string;
  service: string;
  status: AlertStatus;
  startedAt: string;
  sessionId?: string;
}
```

- [ ] **Step 2: 添加 fetchAlerts**

`web/src/lib/api.ts` 末尾新增：

```ts
export function fetchAlerts(onError?: OnError) {
  return request<{ alerts: Alert[] }>('/alerts', undefined, onError);
}
```

并在文件顶部类型 import 增加 `Alert`：

```ts
import type { AgentSession, TimelineEvent, Alert } from './types.js';
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(web): add alert types and fetchAlerts api client"
```

---

### Task 5: AlertCenter 接入真实数据（TDD 调整）

**Files:**
- Modify: `web/src/components/alerts/AlertCenter.tsx`
- Modify: `web/src/components/alerts/alert-center.css`
- Modify: `web/src/components/alerts/AlertCenter.test.tsx`
- Modify: `web/src/components/alerts/AlertCenter.stories.tsx`

- [ ] **Step 1: 更新失败测试**

`web/src/components/alerts/AlertCenter.test.tsx` 整文件替换为：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AlertCenter } from './AlertCenter.js'
import type { AlertItem } from './AlertList.js'

const alerts: AlertItem[] = [
  { id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', startedAt: '2026-08-25T10:24:00Z', status: 'firing' },
]

describe('AlertCenter', () => {
  it('renders health grid, alerts and quick entries', () => {
    render(<AlertCenter alerts={alerts} loading={false} onInvestigate={() => {}} />)
    expect(screen.getByText('告警中心')).toBeInTheDocument()
    expect(screen.getByText('服务健康')).toBeInTheDocument()
    expect(screen.getByText('order-api Pod CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.getByText('快捷入口')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    render(<AlertCenter alerts={[]} loading onInvestigate={() => {}} />)
    expect(screen.getByText(/加载中/)).toBeInTheDocument()
  })

  it('shows empty state', () => {
    render(<AlertCenter alerts={[]} loading={false} onInvestigate={() => {}} />)
    expect(screen.getByText('暂无告警')).toBeInTheDocument()
  })

  it('fires investigate from alert rows', async () => {
    const onInvestigate = vi.fn()
    const user = userEvent.setup()
    render(<AlertCenter alerts={alerts} loading={false} onInvestigate={onInvestigate} />)
    await user.click(screen.getByRole('button', { name: '一键开查' }))
    expect(onInvestigate).toHaveBeenCalledWith('a1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/alerts/AlertCenter.test.tsx`

Expected: FAIL（props 不匹配 / demo 数据断言失败）。

- [ ] **Step 3: 改造 AlertCenter 为受控组件**

`web/src/components/alerts/AlertCenter.tsx` 修改：
- 删除 `demoAlerts` 常量。
- Props 改为：

```tsx
interface AlertCenterProps {
  alerts: AlertItem[]
  loading: boolean
  error?: string | null
  onInvestigate: (id: string) => void
}

export function AlertCenter({ alerts, loading, error, onInvestigate }: AlertCenterProps) {
```

- 最近告警区块改为：

```tsx
      <section className="alert-center__section">
        <h2>最近告警</h2>
        {loading ? (
          <p className="alert-center__state">加载中…</p>
        ) : error ? (
          <p className="alert-center__state alert-center__state--error">{error}</p>
        ) : alerts.length === 0 ? (
          <p className="alert-center__state">暂无告警</p>
        ) : (
          <AlertList alerts={alerts} onInvestigate={onInvestigate} />
        )}
      </section>
```

- 其余（健康网格 demoServices、快捷入口）保持不变。

`web/src/components/alerts/alert-center.css` 追加：

```css
.alert-center__state {
  color: var(--text-3);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.alert-center__state--error {
  color: var(--danger);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/alerts/AlertCenter.test.tsx`

Expected: PASS，`Tests  4 passed`。

- [ ] **Step 5: 更新 Story**

`web/src/components/alerts/AlertCenter.stories.tsx` 的 args 改为：

```tsx
export const Default: Story = {
  args: {
    loading: false,
    alerts: [
      { id: 'a1', severity: 'p0', title: 'order-api Pod CrashLoopBackOff', source: 'order-service/order-api · Prometheus', startedAt: '2026-08-25T10:24:00Z', status: 'firing' },
      { id: 'a2', severity: 'p1', title: 'payment-service 5xx 上升', source: 'pay/payment-service · Prometheus', startedAt: '2026-08-25T10:02:00Z', status: 'firing' },
      { id: 'a3', severity: 'p2', title: 'node-08 磁盘使用率 > 80%', source: 'k8s-node · node_exporter', startedAt: '2026-08-25T09:41:00Z', status: 'acknowledged' },
    ],
    onInvestigate: (id: string) => console.log('investigate', id),
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/alerts/AlertCenter.tsx src/components/alerts/alert-center.css src/components/alerts/AlertCenter.test.tsx src/components/alerts/AlertCenter.stories.tsx
git commit -m "feat(web): drive alert center from real API data"
```

---

### Task 6: App 接线（拉取告警 + 活跃计数）

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 新增 import 与状态**

`web/src/App.tsx` 的 api import 增加 `fetchAlerts`：

```tsx
  fetchAlerts,
```

类型 import 增加 `Alert`：

```tsx
import type { AgentSession, TimelineEvent, Alert } from "./lib/types.js";
```

在 App 组件内（`currentSession` 定义之后）新增：

```tsx
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsError, setAlertsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAlerts((err) => {
      if (!cancelled) {
        setAlertsError(err.message);
        setAlertsLoading(false);
      }
    }).then((rows) => {
      if (cancelled || !rows) return;
      setAlerts(rows.alerts);
      setAlertsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 2: 活跃告警数改为实时计算**

删除：

```tsx
  // M2 静态占位；M5 接入 /api/alerts 后替换
  const activeAlerts = 3;
```

替换为：

```tsx
  const activeAlerts = alerts.filter((alert) => alert.status === "firing").length;
```

- [ ] **Step 3: AlertCenter 传入真实数据**

将：

```tsx
          {currentView === "alerts" && <AlertCenter onInvestigate={handleInvestigateAlert} />}
```

替换为：

```tsx
          {currentView === "alerts" && (
            <AlertCenter
              alerts={alerts.map((alert) => ({
                id: alert.id,
                severity: alert.severity,
                title: alert.title,
                source: alert.source,
                startedAt: alert.startedAt,
                status: alert.status,
              }))}
              loading={alertsLoading}
              error={alertsError}
              onInvestigate={handleInvestigateAlert}
            />
          )}
```

- [ ] **Step 4: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 5: 运行全部测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(web): load alerts from api and compute live count"
```

---

### Task 7: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: server 测试**

Run: `npm test`（server 目录）

Expected: 全部通过（含新增 alerts store / seed / route 测试）。

- [ ] **Step 2: server 构建**

Run: `npm run build`（server 目录）

Expected: PASS（tsc 无错误）。

- [ ] **Step 3: web 测试与构建**

Run: `npm test`（web 目录）与 `npm run build`（web 目录）

Expected: PASS。

- [ ] **Step 4: Storybook 构建**

Run: `npm run build-storybook`（web 目录）

Expected: PASS。

- [ ] **Step 5: 提交收尾**

如果上述有修复：

```bash
git add -A
git commit -m "fix: resolve M5 acceptance issues"
```

---

## M5 验收清单

- [ ] `alerts` 表创建成功，store 插入/查询/过滤通过测试
- [ ] `seedAlerts()` 幂等，服务启动时播种 3 条 demo 告警
- [ ] `GET /api/alerts` 返回 camelCase 字段，支持 `?status=` / `?severity=` 过滤
- [ ] 前端告警中心显示真实接口数据，含加载/错误/空态
- [ ] TopBar/SideNav 活跃告警数 = firing 告警数
- [ ] server 与 web 的 test/build/storybook 全部通过

## M5 完成后的下一步

M6（Evidence.chart + uPlot Sparkline + 对象上下文日志端点）、M7（推理树 Hypothesis 模型）、M8（暗色主题 + 打磨）。
