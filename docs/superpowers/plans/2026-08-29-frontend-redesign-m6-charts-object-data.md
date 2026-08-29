# InfraPilot 前端改版 M6（图表与对象数据）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地指标图表能力（uPlot Sparkline）与对象上下文数据：ELK 日志查询支持 `since` 时间窗，新增 `GET /api/objects/:namespace/:name/logs` 只读端点，前端新增 Sparkline 组件与自包含的 ObjectContext 面板（Pod 详情 + 资源曲线 + 最近日志 + 关联告警 + 发起诊断），替换右栏旧 Pod 面板。

**Architecture:** 后端在 `elk/tools.ts` 的 `search_logs` 增加可选 `since` 参数，并在 `routes/api.ts` 新增对象日志端点（复用 `executeElkTool`）；前端新增 `lib/charts.ts`（uPlot 封装）+ `ui/Sparkline.tsx`（React 组件），新增 `panels/ObjectContext.tsx`（自包含：拉取 Pod 列表/详情、日志、按 service 过滤告警），App 右栏对象 Tab 从 `ContextPanel` 切换到 `ObjectContext`。资源曲线先用 demo 序列占位，真实指标随 Prometheus Skill（后续里程碑）。

**Tech Stack:** 后端 Express + Vitest（`vi.mock` 隔离外部依赖）；前端 React 19 + uPlot + Vitest。

**前置依赖：** M1-M5 已完成。

**执行前注意：**
- 工作目录分别为 `.worktrees/frontend-redesign-m1/server` 与 `.worktrees/frontend-redesign-m1/web`。
- 代码编辑通过 apply_patch 写入 `.worktrees/frontend-redesign-m1/` 路径。
- 提交命令单独执行（不要与测试命令用 `&&` 串联）。
- 沙箱无法连接真实 OpenSearch/K8s，所有相关测试用 `vi.mock` 隔离。

---

### Task 1: elk search_logs 支持 since 时间窗（TDD）

**Files:**
- Modify: `server/src/skills/elk/tools.ts`
- Modify: `server/src/skills/elk/tools.test.ts`

- [ ] **Step 1: 写失败测试**

在 `server/src/skills/elk/tools.test.ts` 的 `describe("executeElkTool")` 中、`search_logs uses explicit index_prefix over namespace` 测试之后追加：

```ts
  it("search_logs applies since time window filter", async () => {
    SHIP_TARGETS.push(
      { namespace: "order-service", podNamePrefix: "order-api", indexPrefix: "order-api-logs" }
    );
    mockSearchResult();

    const res = await executeElkTool("search_logs", { namespace: "order-service", since: "30m" });
    expect(res.success).toBe(true);
    expect(osClient.search).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          query: {
            bool: {
              must: [
                { term: { namespace: "order-service" } },
                { range: { "@timestamp": { gte: "now-30m" } } },
              ],
            },
          },
        }),
      })
    );
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/skills/elk/tools.test.ts`

Expected: FAIL（查询中没有 range 过滤）。

- [ ] **Step 3: 实现 since 参数**

`server/src/skills/elk/tools.ts` 中 `search_logs` 的 `parameters.properties` 末尾追加：

```ts
        since: { type: "string", description: "可选,时间窗口,如 30m / 1h,留空表示不过滤" },
```

`search_logs` case 的解析与过滤逻辑改为：

```ts
        const { namespace, index_prefix, service, level, keyword, limit = 20, since } = args as {
          namespace?: string; index_prefix?: string; service?: string; level?: string; keyword?: string; limit?: number; since?: string;
        };
        const searchOpts: SearchOptions = { namespace, index_prefix };
        const must: unknown[] = [];
        addNamespaceFilter(must, namespace);
        if (service) must.push({ term: { service } });
        if (level) must.push({ term: { level } });
        if (keyword) must.push({ match: { message: String(keyword) } });
        if (since) must.push({ range: { "@timestamp": { gte: `now-${String(since)}` } } });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/skills/elk/tools.test.ts`

Expected: PASS（含新增 since 测试）。

- [ ] **Step 5: Commit**

```bash
git add src/skills/elk/tools.ts src/skills/elk/tools.test.ts
git commit -m "feat(server): support since time window in elk search_logs"
```

---

### Task 2: GET /api/objects/:namespace/:name/logs 端点（TDD）

**Files:**
- Modify: `server/src/routes/api.ts`
- Create: `server/src/routes/objects.test.ts`

- [ ] **Step 1: 写失败测试**

Create `server/src/routes/objects.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";

vi.mock("../skills/elk/tools.js", () => ({
  executeElkTool: vi.fn(),
}));

import { executeElkTool } from "../skills/elk/tools.js";
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

describe("objects API", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
  });

  it("returns mapped logs for a pod", async () => {
    vi.mocked(executeElkTool).mockResolvedValue({
      success: true,
      data: { logs: [{ "@timestamp": "2026-08-25T10:24:31Z", level: "ERROR", message: "Memory limit exceeded" }] },
      durationMs: 12,
    } as any);

    const res = await callRoute(app, "GET", "/api/objects/order-service/order-api/logs?since=30m&limit=20");
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([
      { timestamp: "2026-08-25T10:24:31Z", level: "ERROR", message: "Memory limit exceeded" },
    ]);
    expect(executeElkTool).toHaveBeenCalledWith(
      "search_logs",
      expect.objectContaining({ namespace: "order-service", service: "order-api", since: "30m", limit: 20 })
    );
  });

  it("returns 500 when elk tool fails", async () => {
    vi.mocked(executeElkTool).mockResolvedValue({ success: false, error: "elk down", durationMs: 3 } as any);
    const res = await callRoute(app, "GET", "/api/objects/order-service/order-api/logs");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("elk down");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/routes/objects.test.ts`

Expected: FAIL（404 / 无路由）。

- [ ] **Step 3: 实现路由**

`server/src/routes/api.ts` 的 import 区增加：

```ts
import { executeElkTool } from "../skills/elk/tools.js";
```

在 `apiRouter.get("/alerts", ...)` 之后新增：

```ts
apiRouter.get("/objects/:namespace/:name/logs", async (req, res) => {
  try {
    const { namespace, name } = req.params;
    const { since, level, limit } = req.query;
    const result = await executeElkTool("search_logs", {
      namespace,
      service: name,
      level: level ? String(level) : undefined,
      limit: limit ? Number(limit) : 50,
      since: since ? String(since) : undefined,
    });
    if (!result.success) {
      return res.status(500).json({ error: result.error ?? "日志查询失败" });
    }
    const raw = ((result.data as { logs?: Array<Record<string, unknown>> })?.logs ?? []) as Array<Record<string, unknown>>;
    res.json({
      logs: raw.map((log) => ({
        timestamp: String(log["@timestamp"] ?? ""),
        level: String(log.level ?? "INFO"),
        message: String(log.message ?? ""),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/routes/objects.test.ts`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/routes/api.ts src/routes/objects.test.ts
git commit -m "feat(server): add object logs read-only endpoint"
```

---

### Task 3: Sparkline 组件（uPlot 封装，TDD）

**Files:**
- Test: `web/src/components/ui/Sparkline.test.tsx`
- Create: `web/src/lib/charts.ts`
- Create: `web/src/components/ui/Sparkline.tsx`
- Create: `web/src/components/ui/sparkline.css`
- Create: `web/src/components/ui/Sparkline.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/ui/Sparkline.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from './Sparkline.js'

const { FakeUPlot, destroy } = vi.hoisted(() => {
  const destroy = vi.fn()
  const FakeUPlot = vi.fn(function (this: { destroy: () => void }) {
    this.destroy = destroy
  })
  return { FakeUPlot, destroy }
})

vi.mock('uplot', () => ({ default: FakeUPlot }))

describe('Sparkline', () => {
  beforeEach(() => {
    FakeUPlot.mockClear()
    destroy.mockClear()
  })

  it('creates uPlot with transformed data', () => {
    render(
      <Sparkline
        series={[{ name: 'memory', points: [[1000, 1], [2000, 2]] }]}
        color="#dc2626"
        height={40}
      />,
    )
    expect(FakeUPlot).toHaveBeenCalledTimes(1)
    const [, data] = FakeUPlot.mock.calls[0]
    expect(data[0]).toEqual([1000, 2000])
    expect(data[1]).toEqual([1, 2])
  })

  it('destroys the plot on unmount', () => {
    const { unmount } = render(<Sparkline series={[]} />)
    unmount()
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/Sparkline.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Sparkline.js'`。

- [ ] **Step 3: 实现 charts 封装**

Create `web/src/lib/charts.ts`:

```ts
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface SparkSeries {
  name: string
  points: [number, number][]
}

export function createSparkline(
  target: HTMLElement,
  series: SparkSeries[],
  color: string,
  width: number,
  height: number,
): uPlot {
  const xs: number[] = []
  const ys: number[][] = series.map(() => [])
  series.forEach((item, index) => {
    for (const [t, v] of item.points) {
      xs.push(t)
      ys[index].push(v)
    }
  })

  return new uPlot(
    {
      width,
      height,
      legend: { show: false },
      axes: [{ show: false }, { show: false }],
      series: [{}, ...series.map((item) => ({ label: item.name, stroke: color, width: 1.5 }))],
    },
    [xs, ...ys],
    target,
  )
}
```

- [ ] **Step 4: 实现 Sparkline 组件**

Create `web/src/components/ui/Sparkline.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { createSparkline } from '../../lib/charts.js'
import type { SparkSeries } from '../../lib/charts.js'
import './sparkline.css'

interface SparklineProps {
  series: SparkSeries[]
  color?: string
  height?: number
}

export function Sparkline({ series, color = '#0f766e', height = 40 }: SparklineProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const width = ref.current.clientWidth || 300
    const plot = createSparkline(ref.current, series, color, width, height)
    return () => {
      plot.destroy()
    }
  }, [series, color, height])

  return <div ref={ref} className="ui-sparkline" style={{ height }} />
}
```

Create `web/src/components/ui/sparkline.css`:

```css
.ui-sparkline {
  width: 100%;
  min-height: 32px;
}
.ui-sparkline canvas {
  display: block;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/components/ui/Sparkline.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 6: 创建 Story**

Create `web/src/components/ui/Sparkline.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Sparkline } from './Sparkline.js'

const meta: Meta<typeof Sparkline> = {
  title: 'ui/Sparkline',
  component: Sparkline,
}
export default meta
type Story = StoryObj<typeof Sparkline>

const now = Date.now()

export const Default: Story = {
  args: {
    color: '#dc2626',
    height: 48,
    series: [
      {
        name: 'memory',
        points: Array.from({ length: 12 }, (_, i) => [now - (11 - i) * 60_000, 30 + i * 3 + (i % 3) * 2] as [number, number]),
      },
    ],
  },
}
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/charts.ts src/components/ui/Sparkline.tsx src/components/ui/sparkline.css src/components/ui/Sparkline.test.tsx src/components/ui/Sparkline.stories.tsx
git commit -m "feat(web): add uPlot sparkline component"
```

---

### Task 4: LogEntry 类型与 fetchObjectLogs

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: 添加 LogEntry 类型**

`web/src/lib/types.ts` 末尾新增：

```ts
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}
```

- [ ] **Step 2: 添加 fetchObjectLogs**

`web/src/lib/api.ts` 顶部类型 import 增加 `LogEntry`：

```ts
import type { AgentSession, TimelineEvent, Alert, LogEntry } from './types.js';
```

文件末尾新增：

```ts
export function fetchObjectLogs(
  namespace: string,
  name: string,
  options?: { since?: string; limit?: number },
  onError?: OnError,
) {
  const qs = new URLSearchParams();
  if (options?.since) qs.set('since', options.since);
  if (options?.limit) qs.set('limit', String(options.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<{ logs: LogEntry[] }>(`/objects/${namespace}/${name}/logs${suffix}`, undefined, onError);
}
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(web): add log entry types and object logs api client"
```

---

### Task 5: ObjectContext 面板（TDD）

**Files:**
- Test: `web/src/components/panels/ObjectContext.test.tsx`
- Create: `web/src/components/panels/ObjectContext.tsx`
- Create: `web/src/components/panels/object-context.css`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/panels/ObjectContext.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Alert } from '../../lib/types.js'

const { FakeUPlot } = vi.hoisted(() => ({
  FakeUPlot: vi.fn(function (this: { destroy: () => void }) {
    this.destroy = vi.fn()
  }),
}))

vi.mock('uplot', () => ({ default: FakeUPlot }))
vi.mock('../../lib/api.js', () => ({
  listPods: vi.fn(),
  getPodDetail: vi.fn(),
  fetchObjectLogs: vi.fn(),
}))

import { listPods, getPodDetail, fetchObjectLogs } from '../../lib/api.js'
import { ObjectContext } from './ObjectContext.js'

const pod = {
  name: 'order-api-7f9c6d4b8c-x2j8l',
  namespace: 'order-service',
  status: 'CrashLoopBackOff',
  restartCount: 14,
  ready: false,
  podIp: '10.42.1.77',
  nodeName: 'node-08',
  startedAt: '2026-08-25T10:24:00Z',
  resources: { limits: { memory: '256Mi' } },
}

const alerts: Alert[] = [
  { id: 'a1', severity: 'p0', title: 'order-api CrashLoopBackOff', source: 'Prometheus', service: 'order-api', status: 'firing', startedAt: '2026-08-25T10:24:00Z' },
  { id: 'a2', severity: 'p1', title: 'payment 5xx', source: 'Prometheus', service: 'payment-service', status: 'firing', startedAt: '2026-08-25T10:02:00Z' },
]

describe('ObjectContext', () => {
  beforeEach(() => {
    vi.mocked(listPods).mockResolvedValue({ pods: [pod] } as never)
    vi.mocked(getPodDetail).mockResolvedValue({
      pod,
      events: [{ time: '10:24', type: 'Warning', reason: 'OOMKilled', message: 'Pod was OOMKilled' }],
    } as never)
    vi.mocked(fetchObjectLogs).mockResolvedValue({
      logs: [
        { timestamp: '2026-08-25T10:24:31Z', level: 'ERROR', message: 'Memory limit exceeded' },
        { timestamp: '2026-08-25T10:24:12Z', level: 'WARN', message: 'Heap usage 92%' },
      ],
    } as never)
  })

  it('renders pod fields, logs and related alerts', async () => {
    render(<ObjectContext alerts={alerts} onDiagnose={() => {}} />)
    expect(await screen.findByText('order-api-7f9c6d4b8c-x2j8l')).toBeInTheDocument()
    expect(screen.getByText('256Mi')).toBeInTheDocument()
    expect(await screen.findByText('Memory limit exceeded')).toBeInTheDocument()
    expect(screen.getByText('order-api CrashLoopBackOff')).toBeInTheDocument()
    expect(screen.queryByText('payment 5xx')).not.toBeInTheDocument()
  })

  it('fires onDiagnose', async () => {
    const onDiagnose = vi.fn()
    const user = userEvent.setup()
    render(<ObjectContext alerts={alerts} onDiagnose={onDiagnose} />)
    await user.click(await screen.findByRole('button', { name: /就此对象发起诊断/ }))
    expect(onDiagnose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/panels/ObjectContext.test.tsx`

Expected: FAIL，错误为 `Cannot find module './ObjectContext.js'`。

- [ ] **Step 3: 实现 ObjectContext**

Create `web/src/components/panels/ObjectContext.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { listPods, getPodDetail, fetchObjectLogs } from '../../lib/api.js'
import type { PodInfo, PodEvent } from '../../lib/api.js'
import type { Alert, LogEntry } from '../../lib/types.js'
import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { Sparkline } from '../ui/Sparkline.js'
import './object-context.css'

interface ObjectContextProps {
  alerts: Alert[]
  onDiagnose: () => void
}

const severityTone: Record<string, 'danger' | 'warn' | 'info'> = {
  p0: 'danger',
  p1: 'warn',
  p2: 'info',
}

export function ObjectContext({ alerts, onDiagnose }: ObjectContextProps) {
  const [pods, setPods] = useState<PodInfo[]>([])
  const [selected, setSelected] = useState<PodInfo | null>(null)
  const [events, setEvents] = useState<PodEvent[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const selectPod = async (pod: PodInfo) => {
    setSelected(pod)
    setLogsLoading(true)
    const detail = await getPodDetail(pod.namespace, pod.name)
    if (detail) {
      setSelected(detail.pod)
      setEvents(detail.events)
    }
    const logsRes = await fetchObjectLogs(pod.namespace, pod.name, { since: '30m', limit: 20 })
    setLogs(logsRes?.logs ?? [])
    setLogsLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const abnormal = await listPods(undefined, true, (err) => {
        if (!cancelled) setError(err.message)
      })
      const target = abnormal?.pods?.length ? abnormal.pods : (await listPods())?.pods ?? []
      if (cancelled) return
      setPods(target)
      if (target.length > 0) void selectPod(target[0])
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <p className="object-context__state">加载中…</p>
  if (error) return <p className="object-context__state object-context__state--error">{error}</p>
  if (!selected) return <p className="object-context__state">集群中暂无 Pod</p>

  const memoryLimit = selected.resources?.limits?.memory ?? '-'
  const relatedAlerts = alerts.filter((alert) => alert.service === selected.name)
  const now = Date.now()
  const memoryPoints: [number, number][] = Array.from({ length: 12 }, (_, i) => [now - (11 - i) * 60_000, 30 + i * 3 + (i % 3) * 2])
  const cpuPoints: [number, number][] = Array.from({ length: 12 }, (_, i) => [now - (11 - i) * 60_000, 20 + (i % 4) * 4])

  return (
    <div className="object-context">
      <div className="object-context__selector">
        <label className="object-context__selector-label">当前 Pod</label>
        <select
          className="object-context__selector-input"
          value={`${selected.namespace}/${selected.name}`}
          onChange={(e) => {
            const [ns, name] = e.target.value.split('/')
            const pod = pods.find((p) => p.namespace === ns && p.name === name)
            if (pod) void selectPod(pod)
          }}
        >
          {pods.map((p) => (
            <option key={`${p.namespace}/${p.name}`} value={`${p.namespace}/${p.name}`}>
              {p.namespace}/{p.name} ({p.status})
            </option>
          ))}
        </select>
      </div>

      <div className="object-context__head">
        <h3>{selected.name}</h3>
        <span className={`status-dot status-dot--${selected.status === 'Running' && selected.ready ? 'ok' : 'err'}`} />
        <Badge label={selected.status} tone={selected.status === 'Running' && selected.ready ? 'success' : 'danger'} />
      </div>

      <div className="object-context__grid">
        <div className="object-context__field"><span className="k">命名空间</span><span className="v">{selected.namespace}</span></div>
        <div className="object-context__field"><span className="k">节点</span><span className="v">{selected.nodeName ?? '-'}</span></div>
        <div className="object-context__field"><span className="k">内存 limit</span><span className="v mono">{memoryLimit}</span></div>
        <div className="object-context__field"><span className="k">重启次数</span><span className="v">{selected.restartCount}</span></div>
        <div className="object-context__field"><span className="k">Pod IP</span><span className="v mono">{selected.podIp ?? '-'}</span></div>
        <div className="object-context__field"><span className="k">启动时间</span><span className="v">{selected.startedAt ? new Date(selected.startedAt).toLocaleString() : '-'}</span></div>
      </div>

      <div className="object-context__section">
        <div className="object-context__section-title">资源使用 · 近 30 分钟</div>
        <Sparkline series={[{ name: 'memory', points: memoryPoints }]} color="#dc2626" height={48} />
        <Sparkline series={[{ name: 'cpu', points: cpuPoints }]} color="#2563eb" height={48} />
      </div>

      <div className="object-context__section">
        <div className="object-context__section-title">最近日志</div>
        {logsLoading ? (
          <p className="object-context__state">加载中…</p>
        ) : logs.length === 0 ? (
          <p className="object-context__state">暂无日志</p>
        ) : (
          <div className="object-context__logs">
            {logs.map((log, index) => (
              <div key={index} className="object-log">
                <span className={`object-log__level object-log__level--${log.level.toLowerCase()}`}>{log.level}</span>
                <span className="object-log__message">{log.message}</span>
                <span className="object-log__time">{new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="object-context__section">
        <div className="object-context__section-title">关联告警</div>
        {relatedAlerts.length === 0 ? (
          <p className="object-context__state">暂无关联告警</p>
        ) : (
          <div className="object-context__alerts">
            {relatedAlerts.map((alert) => (
              <div key={alert.id} className="object-alert">
                <Badge label={alert.severity.toUpperCase()} tone={severityTone[alert.severity] ?? 'info'} />
                <span className="object-alert__title">{alert.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {events.length > 0 && (
        <div className="object-context__section">
          <div className="object-context__section-title">最近事件</div>
          {events.map((event, index) => (
            <div key={index} className="object-log">
              <span className={`object-log__level object-log__level--${event.type === 'Warning' ? 'warn' : 'info'}`}>{event.reason}</span>
              <span className="object-log__message">{event.message}</span>
              <span className="object-log__time">{event.time}</span>
            </div>
          ))}
        </div>
      )}

      <Button variant="primary" onClick={onDiagnose}>
        就此对象发起诊断
      </Button>
    </div>
  )
}
```

Create `web/src/components/panels/object-context.css`:

```css
.object-context {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.object-context__state {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
.object-context__state--error {
  color: var(--danger);
}
.object-context__selector {
  display: flex;
  align-items: center;
  gap: 8px;
}
.object-context__selector-label {
  font-size: 12px;
  color: var(--text-3);
  flex: 0 0 auto;
}
.object-context__selector-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font-size: 12.5px;
  font-family: var(--font-sans);
}
.object-context__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.object-context__head h3 {
  font-size: 14px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.object-context__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.object-context__field {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.object-context__field .k {
  display: block;
  font-size: 11px;
  color: var(--text-3);
}
.object-context__field .v {
  display: block;
  font-size: 12.5px;
  font-weight: 500;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.object-context__field .v.mono {
  font-family: var(--font-mono);
}
.object-context__section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 6px;
}
.object-context__logs,
.object-context__alerts {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.object-log {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}
.object-log:last-child {
  border-bottom: none;
}
.object-log__level {
  width: 46px;
  flex: 0 0 46px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
}
.object-log__level--error {
  color: var(--danger);
}
.object-log__level--warn {
  color: var(--warn);
}
.object-log__level--info {
  color: var(--info);
}
.object-log__message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.object-log__time {
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.object-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}
.object-alert:last-child {
  border-bottom: none;
}
.object-alert__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/panels/ObjectContext.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/panels/ObjectContext.tsx src/components/panels/object-context.css src/components/panels/ObjectContext.test.tsx
git commit -m "feat(web): add self-contained object context panel"
```

---

### Task 6: App 接线（右栏对象上下文替换 ContextPanel）

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 调整 import**

`web/src/App.tsx` 的 api import 删除 `getPodDetail`、`listPods`、`resetDemoScenario` 与 `type PodInfo`、`type PodEvent`；新增：

```tsx
import { ObjectContext } from "./components/panels/ObjectContext.js";
```

- [ ] **Step 2: 替换右栏对象 Tab**

将：

```tsx
            object={<ContextPanel />}
```

替换为：

```tsx
            object={
              <ObjectContext
                alerts={alerts}
                onDiagnose={() => {
                  setCurrentView("sessions");
                  if (!currentId) handleCreate();
                }}
              />
            }
```

- [ ] **Step 3: 删除旧 ContextPanel / PodContext 及不再使用的辅助函数**

删除 `web/src/App.tsx` 中的 `function ContextPanel()`、`function PodContext()`、`function EmptyState()` 与 `function Skeleton()`（后两者仅被 PodContext 使用）。删除后运行：

```bash
rg -n "ContextPanel|PodContext|EmptyState|Skeleton|getPodDetail|listPods|resetDemoScenario|PodInfo|PodEvent" src/App.tsx
```

Expected: 无输出。

- [ ] **Step 4: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 5: 运行全部测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 6: 冒烟验证**

启动 `npm run dev`，从沙箱外 `curl -ksS http://localhost:5173/` 应返回 200 HTML；随后 Ctrl-C 停止。

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat(web): switch object tab to enriched ObjectContext"
```

---

### Task 7: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: server 测试**

Run: `npm test`（server 目录）

Expected: 全部通过（除既有沙箱 listen 失败外）。

- [ ] **Step 2: server 构建**

Run: `npm run build`（server 目录）

Expected: PASS。

- [ ] **Step 3: web 测试与构建**

Run: `npm test` 与 `npm run build`（web 目录）

Expected: PASS。

- [ ] **Step 4: Storybook 构建**

Run: `npm run build-storybook`（web 目录）

Expected: PASS。

- [ ] **Step 5: 提交收尾**

如果上述有修复：

```bash
git add -A
git commit -m "fix: resolve M6 acceptance issues"
```

---

## M6 验收清单

- [ ] `search_logs` 支持 `since` 时间窗（含测试）
- [ ] `GET /api/objects/:namespace/:name/logs` 返回映射后的 `{ logs: [{ timestamp, level, message }] }`（含测试）
- [ ] Sparkline 组件通过 uPlot 渲染时序数据，卸载时销毁（含测试与 Story）
- [ ] ObjectContext 展示 Pod 字段、资源曲线（demo 序列）、最近日志（真实端点）、关联告警、发起诊断（含测试）
- [ ] App 右栏对象 Tab 使用 ObjectContext，旧 ContextPanel/PodContext 移除
- [ ] server 与 web 的 test/build/storybook 全部通过

## M6 完成后的下一步

M7（推理树 Hypothesis 模型 + 假设树视图）、M8（暗色主题 + 打磨收尾）。
