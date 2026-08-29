# InfraPilot 前端改版 M3（对话区 Kimi 式重构）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将会话工作台的对话区从"事件日志流"重构为 Kimi 式对话：用户消息右对齐、AI 正文用 Markdown 纯排版、工具/状态/证据聚合为可折叠的"诊断过程"小节，并替换空态与流式提示。

**Architecture:** 新增 `components/conversation/` 组件集（MessageUser / MessageAssistant / ProcessSection / StreamStatusLine / Conversation / EmptyWorkspace）。`Conversation` 按时间顺序消费 `TimelineEvent`：过程类事件（tool_call_start / tool_call_result / evidence_added / plan_update / status）缓冲成 ProcessSection 分组，对话类事件（user_message / assistant_message）和特殊事件（审批/结论/修复/错误等）保持原位渲染；App.tsx 只替换 ChatArea 调用并裁剪不再使用的 EventCard 分支。

**Tech Stack:** React 19 + Vite 8 + TypeScript；M1 的 `Markdown` 组件与 token；Vitest + Testing Library。

**前置依赖：** M1（组件库/测试基建）与 M2（新布局壳）已完成。

**执行前注意：**
- 工作目录为 `web/`；代码编辑通过 apply_patch 写入 `.worktrees/frontend-redesign-m1/web/` 路径。
- 提交命令单独执行（不要与测试命令用 `&&` 串联，沙箱会把 git 段降权）。
- 本计划完成后 `App.tsx` 不再包含 `ChatArea`、`DrawioResultCard`、`formatMarkdown` 与旧 `EmptyWorkspace`。

---

### Task 1: MessageUser 组件（TDD）

**Files:**
- Test: `web/src/components/conversation/MessageUser.test.tsx`
- Create: `web/src/components/conversation/MessageUser.tsx`
- Create: `web/src/components/conversation/message-user.css`
- Create: `web/src/components/conversation/MessageUser.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conversation/MessageUser.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageUser } from './MessageUser.js'

describe('MessageUser', () => {
  it('renders user message content', () => {
    render(<MessageUser content="order-api Pod 一直在重启" />)
    const body = screen.getByText('order-api Pod 一直在重启')
    expect(body.className).toContain('msg-user__body')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conversation/MessageUser.test.tsx`

Expected: FAIL，错误为 `Cannot find module './MessageUser.js'`。

- [ ] **Step 3: 实现 MessageUser**

Create `web/src/components/conversation/MessageUser.tsx`:

```tsx
import './message-user.css'

export function MessageUser({ content }: { content: string }) {
  return (
    <div className="msg-user">
      <div className="msg-user__body">{content}</div>
    </div>
  )
}
```

Create `web/src/components/conversation/message-user.css`:

```css
.msg-user {
  display: flex;
  justify-content: flex-end;
}
.msg-user__body {
  max-width: 80%;
  background: var(--accent-soft);
  border-radius: 12px 12px 4px 12px;
  padding: 11px 15px;
  font-size: 14.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conversation/MessageUser.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/conversation/MessageUser.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageUser } from './MessageUser.js'

const meta: Meta<typeof MessageUser> = {
  title: 'conversation/MessageUser',
  component: MessageUser,
}
export default meta
type Story = StoryObj<typeof MessageUser>

export const Default: Story = {
  args: { content: 'order-api Pod 一直在重启，帮我查下原因' },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/conversation/MessageUser.tsx src/components/conversation/message-user.css src/components/conversation/MessageUser.test.tsx src/components/conversation/MessageUser.stories.tsx
git commit -m "feat(web): add Kimi-style user message"
```

---

### Task 2: MessageAssistant 组件（TDD）

**Files:**
- Test: `web/src/components/conversation/MessageAssistant.test.tsx`
- Create: `web/src/components/conversation/MessageAssistant.tsx`
- Create: `web/src/components/conversation/message-assistant.css`
- Create: `web/src/components/conversation/MessageAssistant.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conversation/MessageAssistant.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageAssistant } from './MessageAssistant.js'

describe('MessageAssistant', () => {
  it('renders avatar and markdown content', () => {
    render(<MessageAssistant content={'### 初步判断\n\n- Pod 状态 **CrashLoopBackOff**'} />)
    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conversation/MessageAssistant.test.tsx`

Expected: FAIL，错误为 `Cannot find module './MessageAssistant.js'`。

- [ ] **Step 3: 实现 MessageAssistant**

Create `web/src/components/conversation/MessageAssistant.tsx`:

```tsx
import { Markdown } from '../ui/Markdown.js'
import './message-assistant.css'

export function MessageAssistant({ content }: { content: string }) {
  return (
    <div className="msg-assistant">
      <div className="msg-assistant__avatar">AI</div>
      <div className="msg-assistant__body">
        <Markdown>{content}</Markdown>
      </div>
    </div>
  )
}
```

Create `web/src/components/conversation/message-assistant.css`:

```css
.msg-assistant {
  display: flex;
  gap: 12px;
}
.msg-assistant__avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex: 0 0 30px;
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
}
.msg-assistant__body {
  flex: 1;
  min-width: 0;
  padding-top: 3px;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conversation/MessageAssistant.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/conversation/MessageAssistant.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageAssistant } from './MessageAssistant.js'

const meta: Meta<typeof MessageAssistant> = {
  title: 'conversation/MessageAssistant',
  component: MessageAssistant,
}
export default meta
type Story = StoryObj<typeof MessageAssistant>

export const Default: Story = {
  args: {
    content: '已定位到 `order-service/order-api` 的重启根因。\n\n### 初步判断\n\n- Pod 状态 **CrashLoopBackOff**，重启 14 次\n- 退出码 `137 (OOMKilled)`\n\n| 服务 | 状态 |\n| --- | --- |\n| order-api | 异常 |',
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/conversation/MessageAssistant.tsx src/components/conversation/message-assistant.css src/components/conversation/MessageAssistant.test.tsx src/components/conversation/MessageAssistant.stories.tsx
git commit -m "feat(web): add markdown assistant message"
```

---

### Task 3: ProcessSection 组件（TDD）

**Files:**
- Test: `web/src/components/conversation/ProcessSection.test.tsx`
- Create: `web/src/components/conversation/ProcessSection.tsx`
- Create: `web/src/components/conversation/process-section.css`
- Create: `web/src/components/conversation/ProcessSection.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conversation/ProcessSection.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProcessSection } from './ProcessSection.js'

const items = [
  { key: 't1', icon: 'tool' as const, status: 'running' as const, title: 'k8s.describe_pod()' },
  { key: 't2', icon: 'result' as const, status: 'ok' as const, title: 'k8s.describe_pod()' },
  { key: 'e1', icon: 'evidence' as const, title: '新增证据', detail: 'Pod 事件：OOMKilled' },
]

describe('ProcessSection', () => {
  it('shows counts and stays collapsed by default', () => {
    render(<ProcessSection items={items} />)
    expect(screen.getByText(/已执行 1 个工具/)).toBeInTheDocument()
    expect(screen.getByText(/收集 1 条证据/)).toBeInTheDocument()
    expect(screen.queryByText('k8s.describe_pod()')).not.toBeInTheDocument()
  })

  it('expands on click and renders rows', async () => {
    const user = userEvent.setup()
    render(<ProcessSection items={items} />)
    await user.click(screen.getByRole('button', { name: /诊断过程/ }))
    expect(screen.getAllByText('k8s.describe_pod()')).toHaveLength(2)
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conversation/ProcessSection.test.tsx`

Expected: FAIL，错误为 `Cannot find module './ProcessSection.js'`。

- [ ] **Step 3: 实现 ProcessSection**

Create `web/src/components/conversation/ProcessSection.tsx`:

```tsx
import { useState } from 'react'
import './process-section.css'

export type ProcessItem = {
  key: string
  icon: 'tool' | 'result' | 'evidence' | 'plan' | 'status'
  status?: 'ok' | 'fail' | 'running'
  title: string
  detail?: string
  time?: string
}

export function ProcessSection({ items }: { items: ProcessItem[] }) {
  const [open, setOpen] = useState(false)
  const toolCount = items.filter((item) => item.icon === 'result').length
  const evidenceCount = items.filter((item) => item.icon === 'evidence').length

  return (
    <div className={`ui-process-group${open ? ' ui-process-group--open' : ''}`}>
      <button
        type="button"
        className="ui-process-group__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ui-process-group__title">诊断过程</span>
        <span className="ui-process-group__meta">
          已执行 {toolCount} 个工具 · 收集 {evidenceCount} 条证据
        </span>
        <span className="ui-process-group__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ui-process-group__body">
          {items.map((item) => (
            <div key={item.key} className="ui-process-row">
              <ProcessIcon item={item} />
              <span className="ui-process-row__title">{item.title}</span>
              {item.detail && <span className="ui-process-row__detail">{item.detail}</span>}
              {item.time && <span className="ui-process-row__time">{item.time}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProcessIcon({ item }: { item: ProcessItem }) {
  if (item.icon === 'result') {
    return <span className={`ui-process-row__icon ui-process-row__icon--${item.status}`}>{item.status === 'ok' ? '✓' : '✗'}</span>
  }
  if (item.icon === 'tool') {
    return <span className="ui-process-row__icon ui-process-row__icon--running">●</span>
  }
  if (item.icon === 'evidence') {
    return (
      <span className="ui-process-row__icon">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      </span>
    )
  }
  if (item.icon === 'plan') {
    return (
      <span className="ui-process-row__icon">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      </span>
    )
  }
  return (
    <span className="ui-process-row__icon">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    </span>
  )
}
```

Create `web/src/components/conversation/process-section.css`:

```css
.ui-process-group {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--panel);
  overflow: hidden;
}
.ui-process-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text-2);
  text-align: left;
}
.ui-process-group__head:hover {
  background: #fafbfc;
}
.ui-process-group__title {
  font-weight: 600;
  color: var(--text);
}
.ui-process-group__meta {
  color: var(--text-3);
}
.ui-process-group__chev {
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
}
.ui-process-group__body {
  border-top: 1px solid var(--border);
}
.ui-process-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono);
}
.ui-process-row:last-child {
  border-bottom: none;
}
.ui-process-row__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.ui-process-row__icon--ok {
  color: var(--success);
}
.ui-process-row__icon--fail {
  color: var(--danger);
}
.ui-process-row__icon--running {
  color: var(--warn);
  font-size: 8px;
}
.ui-process-row__title {
  color: var(--text);
  flex: 0 0 auto;
}
.ui-process-row__detail {
  color: var(--text-2);
  font-family: var(--font-sans);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-process-row__time {
  margin-left: auto;
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conversation/ProcessSection.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/conversation/ProcessSection.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProcessSection } from './ProcessSection.js'

const meta: Meta<typeof ProcessSection> = {
  title: 'conversation/ProcessSection',
  component: ProcessSection,
}
export default meta
type Story = StoryObj<typeof ProcessSection>

export const Default: Story = {
  args: {
    items: [
      { key: 't1', icon: 'tool', status: 'running', title: 'k8s.describe_pod()' },
      { key: 't2', icon: 'result', status: 'ok', title: 'elk.search_logs(service=order-api)' },
      { key: 'e1', icon: 'evidence', title: '新增证据', detail: 'Pod 事件：OOMKilled，退出码 137' },
    ],
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/conversation/ProcessSection.tsx src/components/conversation/process-section.css src/components/conversation/ProcessSection.test.tsx src/components/conversation/ProcessSection.stories.tsx
git commit -m "feat(web): add collapsible process section"
```

---

### Task 4: StreamStatusLine 组件（TDD）

**Files:**
- Test: `web/src/components/conversation/StreamStatusLine.test.tsx`
- Create: `web/src/components/conversation/StreamStatusLine.tsx`
- Create: `web/src/components/conversation/stream-status-line.css`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conversation/StreamStatusLine.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StreamStatusLine } from './StreamStatusLine.js'

describe('StreamStatusLine', () => {
  it('renders status text', () => {
    render(<StreamStatusLine text="正在执行 k8s.describe_pod()…" />)
    expect(screen.getByText('正在执行 k8s.describe_pod()…')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conversation/StreamStatusLine.test.tsx`

Expected: FAIL，错误为 `Cannot find module './StreamStatusLine.js'`。

- [ ] **Step 3: 实现 StreamStatusLine**

Create `web/src/components/conversation/StreamStatusLine.tsx`:

```tsx
import './stream-status-line.css'

export function StreamStatusLine({ text }: { text: string }) {
  return (
    <div className="stream-status-line">
      <span className="stream-status-line__dot" />
      <span>{text}</span>
    </div>
  )
}
```

Create `web/src/components/conversation/stream-status-line.css`:

```css
.stream-status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-3);
  padding: 6px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.stream-status-line__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: stream-pulse 1.2s infinite;
}
@keyframes stream-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conversation/StreamStatusLine.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/conversation/StreamStatusLine.tsx src/components/conversation/stream-status-line.css src/components/conversation/StreamStatusLine.test.tsx
git commit -m "feat(web): add stream status line"
```

---

### Task 5: Conversation 组件（TDD）

**Files:**
- Test: `web/src/components/conversation/Conversation.test.tsx`
- Create: `web/src/components/conversation/Conversation.tsx`
- Create: `web/src/components/conversation/conversation.css`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conversation/Conversation.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { Conversation } from './Conversation.js'
import type { TimelineEvent } from '../../lib/types.js'

const ev = (id: string, type: string, payload: Record<string, unknown>): TimelineEvent => ({
  id,
  sessionId: 's1',
  type,
  timestamp: '2026-08-25T10:30:00Z',
  payload,
})

const events: TimelineEvent[] = [
  ev('e1', 'user_message', { message: '查一下 order-api' }),
  ev('e2', 'plan_update', { plan: ['查 Pod 状态', '查日志'] }),
  ev('e3', 'tool_call_start', { skill: 'k8s', tool: 'describe_pod' }),
  ev('e4', 'tool_call_result', { skill: 'k8s', tool: 'describe_pod', result: { success: true } }),
  ev('e5', 'evidence_added', { summary: 'Pod 事件：OOMKilled' }),
  ev('e6', 'assistant_message', { content: '### 初步判断\n\n内存 limit 过低' }),
  ev('e7', 'approval_request', { approvalId: 'a1' }),
]

describe('Conversation', () => {
  it('renders messages, grouped process and special events in order', async () => {
    const ref = createRef<HTMLDivElement | null>()
    render(
      <Conversation
        events={events}
        loading={false}
        renderSpecial={(event) => <div data-testid={`special-${event.type}`}>{event.type}</div>}
        chatEndRef={ref}
      />,
    )
    expect(screen.getByText('查一下 order-api')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
    expect(screen.getByText(/已执行 1 个工具/)).toBeInTheDocument()
    expect(screen.getByTestId('special-approval_request')).toBeInTheDocument()

    // 过程小节默认折叠，展开后能看到工具名与证据摘要
    await userEvent.setup().click(screen.getByRole('button', { name: /诊断过程/ }))
    expect(screen.getByText('k8s.describe_pod()')).toBeInTheDocument()
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
  })

  it('shows stream status when loading', () => {
    render(
      <Conversation
        events={[ev('e1', 'tool_call_start', { skill: 'k8s', tool: 'describe_pod' })]}
        loading
        renderSpecial={() => null}
        chatEndRef={createRef<HTMLDivElement | null>()}
      />,
    )
    expect(screen.getByText(/正在执行 k8s\.describe_pod\(\)/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conversation/Conversation.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Conversation.js'`。

- [ ] **Step 3: 实现 Conversation**

Create `web/src/components/conversation/Conversation.tsx`:

```tsx
import { Fragment } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { TimelineEvent } from '../../lib/types.js'
import { MessageUser } from './MessageUser.js'
import { MessageAssistant } from './MessageAssistant.js'
import { ProcessSection, type ProcessItem } from './ProcessSection.js'
import { StreamStatusLine } from './StreamStatusLine.js'
import './conversation.css'

const PROCESS_TYPES = new Set(['tool_call_start', 'tool_call_result', 'evidence_added', 'plan_update', 'status'])
const SKIP_TYPES = new Set(['checkpoint_saved', 'runner_resumed'])

interface ConversationProps {
  events: TimelineEvent[]
  loading: boolean
  renderSpecial: (event: TimelineEvent) => ReactNode
  chatEndRef: RefObject<HTMLDivElement | null>
}

export function Conversation({ events, loading, renderSpecial, chatEndRef }: ConversationProps) {
  const { items, runningTool } = buildItems(events, renderSpecial)
  return (
    <div className="ui-conversation">
      <div className="ui-conversation__inner">
        {loading && <StreamStatusLine text={runningTool ? `正在执行 ${runningTool}…` : 'Agent 正在思考…'} />}
        {items.map((item) =>
          item.kind === 'process' ? (
            <ProcessSection key={item.key} items={item.items} />
          ) : (
            item.node
          ),
        )}
        <div ref={chatEndRef} />
      </div>
    </div>
  )
}

type RenderItem =
  | { kind: 'process'; key: string; items: ProcessItem[] }
  | { kind: 'node'; node: ReactNode }

function buildItems(
  events: TimelineEvent[],
  renderSpecial: (event: TimelineEvent) => ReactNode,
): { items: RenderItem[]; runningTool: string | null } {
  const items: RenderItem[] = []
  let buffer: ProcessItem[] = []
  let runningTool: string | null = null
  let groupIndex = 0

  const flush = () => {
    if (buffer.length > 0) {
      items.push({ kind: 'process', key: `process-${groupIndex++}`, items: buffer })
      buffer = []
    }
  }

  for (const event of events) {
    if (SKIP_TYPES.has(event.type)) continue
    if (PROCESS_TYPES.has(event.type)) {
      const item = toProcessItem(event)
      buffer.push(item)
      if (item.icon === 'tool' && item.status === 'running') {
        runningTool = item.title
      }
      continue
    }
    flush()
    if (event.type === 'user_message') {
      items.push({
        kind: 'node',
        node: <MessageUser key={event.id} content={String(event.payload?.message ?? event.payload?.content ?? '')} />,
      })
    } else if (event.type === 'assistant_message') {
      items.push({
        kind: 'node',
        node: <MessageAssistant key={event.id} content={String(event.payload?.content ?? '')} />,
      })
    } else {
      items.push({ kind: 'node', node: <Fragment key={event.id}>{renderSpecial(event)}</Fragment> })
    }
  }
  flush()
  return { items, runningTool }
}

function toProcessItem(event: TimelineEvent): ProcessItem {
  const p = event.payload || {}
  switch (event.type) {
    case 'tool_call_start':
      return {
        key: event.id,
        icon: 'tool',
        status: 'running',
        title: `${p.skill}.${p.tool}()`,
        detail: p.risk?.level ? `风险等级: ${p.risk.level}` : undefined,
        time: formatClock(event.timestamp),
      }
    case 'tool_call_result':
      return {
        key: event.id,
        icon: 'result',
        status: p.result?.success ? 'ok' : 'fail',
        title: `${p.skill}.${p.tool}()`,
        detail: p.result?.success ? '执行成功' : '执行失败',
        time: formatClock(event.timestamp),
      }
    case 'evidence_added':
      return {
        key: event.id,
        icon: 'evidence',
        title: '新增证据',
        detail: String(p.summary ?? ''),
        time: formatClock(event.timestamp),
      }
    case 'plan_update':
      return {
        key: event.id,
        icon: 'plan',
        title: '诊断计划更新',
        detail: Array.isArray(p.plan) ? p.plan.join(' → ') : undefined,
        time: formatClock(event.timestamp),
      }
    default:
      return {
        key: event.id,
        icon: 'status',
        title: '状态更新',
        detail: String(p.message ?? p.status ?? ''),
        time: formatClock(event.timestamp),
      }
  }
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
}
```

Create `web/src/components/conversation/conversation.css`:

```css
.ui-conversation {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px 16px;
}
.ui-conversation__inner {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
```

注意：`onApprove` 属性在本任务中通过 `renderSpecial` 闭包使用（App 接线时传入 `(event) => <EventCard event={event} onApprove={onApprove} />`），Conversation 自身不直接渲染审批卡。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conversation/Conversation.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/conversation/Conversation.tsx src/components/conversation/conversation.css src/components/conversation/Conversation.test.tsx
git commit -m "feat(web): add conversation composer with process aggregation"
```

---

### Task 6: EmptyWorkspace 组件（TDD）

**Files:**
- Test: `web/src/components/conversation/EmptyWorkspace.test.tsx`
- Create: `web/src/components/conversation/EmptyWorkspace.tsx`
- Create: `web/src/components/conversation/empty-workspace.css`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conversation/EmptyWorkspace.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmptyWorkspace } from './EmptyWorkspace.js'

describe('EmptyWorkspace', () => {
  it('renders guidance and quick entry cards', () => {
    render(<EmptyWorkspace onNewSession={() => {}} />)
    expect(screen.getByText('开始一次诊断')).toBeInTheDocument()
    expect(screen.getByText('排查 Pod 异常')).toBeInTheDocument()
    expect(screen.getByText('查询日志')).toBeInTheDocument()
  })

  it('fires onNewSession when a card is clicked', async () => {
    const onNewSession = vi.fn()
    const user = userEvent.setup()
    render(<EmptyWorkspace onNewSession={onNewSession} />)
    await user.click(screen.getByText('排查 Pod 异常'))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conversation/EmptyWorkspace.test.tsx`

Expected: FAIL，错误为 `Cannot find module './EmptyWorkspace.js'`。

- [ ] **Step 3: 实现 EmptyWorkspace**

Create `web/src/components/conversation/EmptyWorkspace.tsx`:

```tsx
import './empty-workspace.css'

const quickCards = [
  { title: '排查 Pod 异常', desc: '输入故障现象，Agent 自动诊断' },
  { title: '查询日志', desc: '按服务/关键字检索 ELK 日志' },
  { title: '查看告警', desc: '进入告警中心处理待办' },
]

export function EmptyWorkspace({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="ui-empty-workspace">
      <h2 className="ui-empty-workspace__title">开始一次诊断</h2>
      <p className="ui-empty-workspace__message">描述故障现象，AI Agent 将自动收集证据并分析根因</p>
      <div className="ui-empty-workspace__cards">
        {quickCards.map((card) => (
          <button key={card.title} type="button" className="ui-empty-workspace__card" onClick={onNewSession}>
            <b>{card.title}</b>
            <span>{card.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
```

Create `web/src/components/conversation/empty-workspace.css`:

```css
.ui-empty-workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px;
}
.ui-empty-workspace__title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}
.ui-empty-workspace__message {
  font-size: 13.5px;
  color: var(--text-3);
  margin-bottom: 24px;
}
.ui-empty-workspace__cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 640px;
}
.ui-empty-workspace__card {
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--panel);
  border: 1px solid var(--border);
  cursor: pointer;
  text-align: left;
  font-family: var(--font-sans);
  transition: border-color 0.12s ease;
}
.ui-empty-workspace__card:hover {
  border-color: var(--accent);
}
.ui-empty-workspace__card b {
  display: block;
  font-size: 13.5px;
  margin-bottom: 3px;
  color: var(--text);
}
.ui-empty-workspace__card span {
  font-size: 12px;
  color: var(--text-3);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conversation/EmptyWorkspace.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/conversation/EmptyWorkspace.tsx src/components/conversation/empty-workspace.css src/components/conversation/EmptyWorkspace.test.tsx
git commit -m "feat(web): redesign empty workspace guidance"
```

---

### Task 7: App.tsx 接线（ChatArea → Conversation）

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 调整 import**

在 `web/src/App.tsx` 的 api import 中删除 `downloadDrawioUrl,` 与 `exportDrawioDiagram,`（第 4-5 行），删除第 25 行 `import { DrawioImageViewer } ...`，并新增：

```tsx
import { Conversation } from "./components/conversation/Conversation.js";
import { EmptyWorkspace } from "./components/conversation/EmptyWorkspace.js";
```

- [ ] **Step 2: 替换 ChatArea 调用**

在 App return JSX 中找到：

```tsx
                    <ChatArea
                      events={events}
                      loading={loading && events.length === 0}
                      onApprove={handleApprove}
                      chatEndRef={chatEndRef}
                    />
```

替换为：

```tsx
                    <Conversation
                      events={events}
                      loading={loading && events.length === 0}
                      onApprove={handleApprove}
                      renderSpecial={(event) => <EventCard event={event} onApprove={handleApprove} />}
                      chatEndRef={chatEndRef}
                    />
```

- [ ] **Step 3: 删除旧函数**

删除以下函数定义（当前行号）：
- `function ChatArea(...)`（381-418 行）
- `function DrawioResultCard(...)`（419-482 行）
- `function EmptyWorkspace(...)`（919-936 行）
- `function formatMarkdown(...)`（956 行至文件结尾前的函数结束）

删除后运行：

```bash
rg -n "ChatArea|DrawioResultCard|formatMarkdown|DrawioImageViewer|downloadDrawioUrl|exportDrawioDiagram" src/App.tsx
```

Expected: 无输出。

- [ ] **Step 4: 裁剪 EventCard 分支**

在 `EventCard` 的 switch 中删除以下 case 块（这些事件现在由 Conversation 处理）：
- `case "user_message":`
- `case "assistant_message":`
- `case "status":`
- `case "tool_call_start":`
- `case "tool_call_result":`
- `case "evidence_added":`
- `case "plan_update":`

保留：`approval_request`、`approval_decision`、`remediation_plan`、`rca_conclusion`、`knowledge_case_added`、`error`、`done`、`checkpoint_saved`/`runner_resumed`、`default`。

- [ ] **Step 5: 构建验证**

Run: `npm run build`

Expected: PASS（无未使用变量/导入错误）。

- [ ] **Step 6: 运行全部测试**

Run: `npm test`

Expected: PASS（新增 conversation 组件测试全部通过）。

- [ ] **Step 7: 冒烟验证**

启动 `npm run dev`，从沙箱外 `curl -ksS http://localhost:5173/` 应返回 200 HTML；随后 Ctrl-C 停止。

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx
git commit -m "feat(web): switch conversation to Kimi-style rendering"
```

---

### Task 8: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: 运行全部测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 2: 运行生产构建**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 3: 运行 Storybook 构建**

Run: `npm run build-storybook`

Expected: PASS，conversation 组件 story 可访问。

- [ ] **Step 4: 提交收尾**

如果 Step 1-3 有修复：

```bash
git add -A
git commit -m "fix(web): resolve M3 acceptance issues"
```

---

## M3 验收清单

- [ ] 用户消息右对齐浅色底、AI 正文 Markdown 纯排版
- [ ] 工具/状态/证据聚合为可折叠"诊断过程"，默认折叠且统计计数正确
- [ ] 审批卡、根因结论、修复方案、错误等特殊事件仍在原位渲染
- [ ] 流式状态行替代"正在思考"打字动画
- [ ] 空态改为引导 + 三张快捷入口卡
- [ ] `App.tsx` 不再包含 ChatArea / DrawioResultCard / formatMarkdown / 旧 EmptyWorkspace
- [ ] `npm test`、`npm run build`、`npm run build-storybook` 全部通过

## M3 完成后的下一步

M4（结论卡片 + 证据角标回链），随后 M5（告警后端数据）、M6（图表与对象数据）、M7（推理树）、M8（暗色主题 + 打磨）。
