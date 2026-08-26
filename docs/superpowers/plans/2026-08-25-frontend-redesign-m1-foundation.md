# InfraPilot 前端改版 M1（工程地基 + 首批组件库）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 InfraPilot 前端改版（方案 C）建立工程地基：设计 token 与主题机制、Vitest + Storybook 测试基建，以及首批基础组件（Button / Badge / Tabs / CodeBlock / Markdown），全部通过 build 与测试。

**Architecture:** 新增独立的 token 样式层（`web/src/styles/tokens.css` + `base.css`）和基础组件库（`web/src/components/ui/`，每个组件自带 CSS、测试与 Story），不触碰现有 `App.tsx` 业务逻辑；现有 `app.css` 与 `App.tsx` 保持原样，后续里程碑再逐步迁移。浅色为主题默认，`[data-theme="dark"]` 预留深色 token 覆盖。

**Tech Stack:** React 19 + Vite 8 + TypeScript（`verbatimModuleSyntax`、`noUnusedLocals`）；react-markdown + rehype-raw + rehype-sanitize；Vitest + Testing Library + jsdom；Storybook（react-vite）；设计 token 用 CSS 变量。

**执行前注意：**
- 本计划的 npm 安装需要网络访问；若沙箱拦截，请求审批后执行。
- 建议在独立分支 `feature/frontend-redesign`（或独立 worktree）上实施本计划。
- 工作目录为 `web/`，所有命令在 `web/` 下执行（除非特别注明）。
- uPlot 在 Task 1 安装，但代码到 M6 才使用，本计划不写 uPlot 代码。

---

### Task 1: 安装依赖

**Files:**
- Modify: `web/package.json`（npm 自动更新）
- Modify: `web/package-lock.json`（npm 自动更新）

- [ ] **Step 1: 安装运行时依赖**

```bash
npm install react-markdown remark-gfm rehype-raw rehype-sanitize hast-util-sanitize @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono uplot
```

Expected: `package.json` 的 `dependencies` 增加 9 项：react-markdown、remark-gfm、rehype-raw、rehype-sanitize、hast-util-sanitize、@fontsource/ibm-plex-sans、@fontsource/ibm-plex-mono、uplot。

- [ ] **Step 2: 安装开发依赖**

```bash
npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event storybook @storybook/react-vite @storybook/addon-essentials
```

Expected: `devDependencies` 增加 9 项。

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(web): add frontend redesign foundation dependencies"
```

---

### Task 2: Vitest 测试基建

**Files:**
- Modify: `web/vite.config.ts`（整文件替换）
- Create: `web/src/test/setup.ts`
- Create: `web/src/test/smoke.test.ts`
- Modify: `web/package.json`（scripts 增加 test）

- [ ] **Step 1: 创建 smoke test**

Create `web/src/test/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('test runner works', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 2: 创建测试 setup 文件**

Create `web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 3: 替换 vite.config.ts 增加 test 配置**

Replace `web/vite.config.ts` with:

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
})
```

- [ ] **Step 4: package.json 增加 test 脚本**

Modify `web/package.json` scripts to:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

- [ ] **Step 5: 运行测试**

Run: `npm test`

Expected: PASS，输出 `Test Files  1 passed`、`Tests  1 passed`。

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts src/test/setup.ts src/test/smoke.test.ts package.json
git commit -m "test(web): add vitest infra with smoke test"
```

---

### Task 3: 设计 token 与主题机制

**Files:**
- Create: `web/src/styles/tokens.css`
- Create: `web/src/styles/base.css`
- Modify: `web/src/index.css`（整文件替换）
- Modify: `web/index.html`（lang、title）
- Modify: `web/src/main.tsx`（引入 index.css、设置 data-theme）

- [ ] **Step 1: 创建 tokens.css**

Create `web/src/styles/tokens.css`:

```css
/* ============================================================
   InfraPilot 设计 Token —— 浅色默认，深色预留
   ============================================================ */
@import '@fontsource/ibm-plex-sans/400.css';
@import '@fontsource/ibm-plex-sans/500.css';
@import '@fontsource/ibm-plex-sans/600.css';
@import '@fontsource/ibm-plex-mono/400.css';

:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --border: #e3e6ea;
  --border-strong: #d3d9df;
  --text: #1a1d21;
  --text-2: #5a6472;
  --text-3: #8a94a3;
  --accent: #0f766e;
  --accent-hover: #115e59;
  --accent-soft: #e6f4f2;
  --danger: #dc2626;
  --danger-soft: #fee2e2;
  --warn: #d97706;
  --warn-soft: #fef3c7;
  --success: #059669;
  --success-soft: #d1fae5;
  --info: #2563eb;
  --info-soft: #dbeafe;
  --code-bg: #0f172a;
  --code-text: #dbe4ef;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --font-sans: 'IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Consolas, Menlo, monospace;
}

/* 深色主题：M8 精调色值，此处先建立结构 */
[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #171a21;
  --border: #2a2f3a;
  --border-strong: #3a4150;
  --text: #e8ebf0;
  --text-2: #a6aebb;
  --text-3: #6b7482;
  --accent: #2dd4bf;
  --accent-hover: #5eead4;
  --accent-soft: #12312e;
  --danger: #f87171;
  --danger-soft: #3b1a1d;
  --warn: #fbbf24;
  --warn-soft: #3a2c12;
  --success: #34d399;
  --success-soft: #123129;
  --info: #60a5fa;
  --info-soft: #17263d;
  --code-bg: #0b0e13;
  --code-text: #dbe4ef;
}
```

- [ ] **Step 2: 创建 base.css**

Create `web/src/styles/base.css`:

```css
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#root {
  height: 100%;
}

body {
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

::-webkit-scrollbar {
  width: 9px;
  height: 9px;
}
::-webkit-scrollbar-thumb {
  background: #d8dde3;
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-track {
  background: transparent;
}
```

- [ ] **Step 3: 替换 index.css 为 token + base 入口**

Replace `web/src/index.css` with:

```css
@import './styles/tokens.css';
@import './styles/base.css';
```

- [ ] **Step 4: 更新 index.html**

Modify `web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>InfraPilot · AI SRE 智能运维</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: main.tsx 引入全局样式并设置主题**

Replace `web/src/main.tsx` with:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

document.documentElement.dataset.theme = 'light'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 6: 验证构建**

Run: `npm run build`

Expected: PASS（`tsc -b && vite build` 无报错）。

- [ ] **Step 7: Commit**

```bash
git add src/styles/tokens.css src/styles/base.css src/index.css index.html src/main.tsx
git commit -m "feat(web): add design tokens and theme mechanism"
```

---

### Task 4: Markdown 组件（TDD）

**Files:**
- Test: `web/src/components/ui/Markdown.test.tsx`
- Create: `web/src/lib/markdown.ts`
- Create: `web/src/components/ui/Markdown.tsx`
- Create: `web/src/components/ui/markdown.css`
- Create: `web/src/components/ui/Markdown.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/ui/Markdown.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from './Markdown.js'

describe('Markdown', () => {
  it('renders headings, lists and inline code', () => {
    render(<Markdown>{'### 初步判断\n\n- 项目 A\n- 项目 B\n\n使用 `kubectl` 查看'}</Markdown>)
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('初步判断')
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('kubectl', { selector: 'code' })).toBeInTheDocument()
  })

  it('renders markdown tables', () => {
    render(<Markdown>{'| 服务 | 状态 |\n| --- | --- |\n| order-api | 异常 |'}</Markdown>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('order-api')).toBeInTheDocument()
  })

  it('strips raw script tags via sanitize', () => {
    render(<Markdown>{'hello <script>window.x=1</script> world'}</Markdown>)
    expect(screen.queryByText(/window\.x=1/)).not.toBeInTheDocument()
    expect(screen.getByText(/hello/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/Markdown.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Markdown.js'`。

- [ ] **Step 3: 实现 markdown schema**

Create `web/src/lib/markdown.ts`:

```ts
import { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'

/** react-markdown 消毒 schema：在默认基础上放行表格标签 */
export const markdownSchema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  attributes: {
    ...defaultSchema.attributes,
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
  },
}
```

- [ ] **Step 4: 实现 Markdown 组件**

Create `web/src/components/ui/Markdown.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { markdownSchema } from '../../lib/markdown.js'
import './markdown.css'

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSchema]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
```

Create `web/src/components/ui/markdown.css`:

```css
.markdown-body {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text);
}
.markdown-body h1,
.markdown-body h2,
.markdown-body h3 {
  font-weight: 600;
  margin: 16px 0 8px;
}
.markdown-body h1 {
  font-size: 18px;
}
.markdown-body h2 {
  font-size: 16px;
}
.markdown-body h3 {
  font-size: 15px;
}
.markdown-body p {
  margin: 0 0 9px;
}
.markdown-body ul,
.markdown-body ol {
  margin: 8px 0;
  padding-left: 20px;
}
.markdown-body li {
  margin-bottom: 5px;
}
.markdown-body code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}
.markdown-body pre {
  background: var(--code-bg);
  color: var(--code-text);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.65;
  margin: 10px 0;
}
.markdown-body pre code {
  background: transparent;
  border: none;
  padding: 0;
  color: inherit;
}
.markdown-body table {
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 13.5px;
}
.markdown-body th,
.markdown-body td {
  border: 1px solid var(--border);
  padding: 7px 10px;
  text-align: left;
}
.markdown-body th {
  background: var(--bg);
  font-weight: 600;
}
.markdown-body blockquote {
  border-left: 3px solid var(--border-strong);
  padding-left: 12px;
  color: var(--text-2);
  margin: 10px 0;
}
.markdown-body a {
  color: var(--accent);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/components/ui/Markdown.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 6: 创建 Story**

Create `web/src/components/ui/Markdown.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Markdown } from './Markdown.js'

const meta: Meta<typeof Markdown> = {
  title: 'ui/Markdown',
  component: Markdown,
}
export default meta
type Story = StoryObj<typeof Markdown>

export const Default: Story = {
  args: {
    children: '### 初步判断\n\n- Pod 状态 **CrashLoopBackOff**\n- 退出码 `137 (OOMKilled)`\n\n| 服务 | 状态 |\n| --- | --- |\n| order-api | 异常 |\n\n```\nkubectl get pods\n```',
  },
}
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/markdown.ts src/components/ui/Markdown.tsx src/components/ui/markdown.css src/components/ui/Markdown.test.tsx src/components/ui/Markdown.stories.tsx
git commit -m "feat(web): add sanitized Markdown component"
```

---

### Task 5: Button 组件（TDD）

**Files:**
- Test: `web/src/components/ui/Button.test.tsx`
- Create: `web/src/components/ui/Button.tsx`
- Create: `web/src/components/ui/button.css`
- Create: `web/src/components/ui/Button.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/ui/Button.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button.js'

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <Button variant="primary" onClick={onClick}>
        新建会话
      </Button>,
    )
    const btn = screen.getByRole('button', { name: '新建会话' })
    expect(btn.className).toContain('ui-btn--primary')
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/Button.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Button.js'`。

- [ ] **Step 3: 实现 Button**

Create `web/src/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './button.css'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  children: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', className = '', children, ...rest }: ButtonProps) {
  return (
    <button className={`ui-btn ui-btn--${variant} ui-btn--${size} ${className}`.trim()} {...rest}>
      {children}
    </button>
  )
}
```

Create `web/src/components/ui/button.css`:

```css
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.ui-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.ui-btn--md {
  height: 32px;
  padding: 0 14px;
}
.ui-btn--sm {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.ui-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.ui-btn--primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.ui-btn--secondary {
  background: var(--panel);
  border-color: var(--border);
  color: var(--text);
}
.ui-btn--secondary:hover {
  border-color: var(--border-strong);
}
.ui-btn--danger {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.ui-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-2);
}
.ui-btn--ghost:hover {
  background: var(--bg);
  color: var(--text);
}
.ui-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/ui/Button.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/ui/Button.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button.js'

const meta: Meta<typeof Button> = {
  title: 'ui/Button',
  component: Button,
}
export default meta
type Story = StoryObj<typeof Button>

export const Primary: Story = {
  args: { variant: 'primary', children: '新建会话' },
}

export const Secondary: Story = {
  args: { variant: 'secondary', children: '拒绝' },
}

export const Danger: Story = {
  args: { variant: 'danger', children: '批准执行修复' },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Button.tsx src/components/ui/button.css src/components/ui/Button.test.tsx src/components/ui/Button.stories.tsx
git commit -m "feat(web): add Button component"
```

---

### Task 6: Badge 组件（TDD）

**Files:**
- Test: `web/src/components/ui/Badge.test.tsx`
- Create: `web/src/components/ui/Badge.tsx`
- Create: `web/src/components/ui/badge.css`
- Create: `web/src/components/ui/Badge.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/ui/Badge.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from './Badge.js'

describe('Badge', () => {
  it('renders label with tone class', () => {
    render(<Badge label="P0 严重" tone="danger" />)
    const badge = screen.getByText('P0 严重')
    expect(badge.className).toContain('ui-badge--danger')
  })

  it('defaults to neutral tone', () => {
    render(<Badge label="未处理" />)
    expect(screen.getByText('未处理').className).toContain('ui-badge--neutral')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/Badge.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Badge.js'`。

- [ ] **Step 3: 实现 Badge**

Create `web/src/components/ui/Badge.tsx`:

```tsx
import './badge.css'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'

interface BadgeProps {
  label: string
  tone?: BadgeTone
}

export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  return <span className={`ui-badge ui-badge--${tone}`}>{label}</span>
}
```

Create `web/src/components/ui/badge.css`:

```css
.ui-badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
}
.ui-badge--neutral {
  background: var(--bg);
  color: var(--text-2);
}
.ui-badge--accent {
  background: var(--accent-soft);
  color: var(--accent);
}
.ui-badge--success {
  background: var(--success-soft);
  color: var(--success);
}
.ui-badge--warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.ui-badge--danger {
  background: var(--danger-soft);
  color: var(--danger);
}
.ui-badge--info {
  background: var(--info-soft);
  color: var(--info);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/ui/Badge.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/ui/Badge.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Badge } from './Badge.js'

const meta: Meta<typeof Badge> = {
  title: 'ui/Badge',
  component: Badge,
}
export default meta
type Story = StoryObj<typeof Badge>

export const Danger: Story = {
  args: { label: 'P0 严重', tone: 'danger' },
}

export const Accent: Story = {
  args: { label: '置信度 87%', tone: 'accent' },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Badge.tsx src/components/ui/badge.css src/components/ui/Badge.test.tsx src/components/ui/Badge.stories.tsx
git commit -m "feat(web): add Badge component"
```

---

### Task 7: Tabs 组件（TDD）

**Files:**
- Test: `web/src/components/ui/Tabs.test.tsx`
- Create: `web/src/components/ui/Tabs.tsx`
- Create: `web/src/components/ui/tabs.css`
- Create: `web/src/components/ui/Tabs.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/ui/Tabs.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tabs } from './Tabs.js'

const items = [
  { key: 'process', label: '调查过程' },
  { key: 'evidence', label: '证据链', count: 4 },
]

describe('Tabs', () => {
  it('marks active tab and fires onChange', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Tabs items={items} activeKey="process" onChange={onChange} />)
    const process = screen.getByRole('tab', { name: '调查过程' })
    expect(process.className).toContain('ui-tabs__tab--active')
    await user.click(screen.getByRole('tab', { name: /证据链/ }))
    expect(onChange).toHaveBeenCalledWith('evidence')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/Tabs.test.tsx`

Expected: FAIL，错误为 `Cannot find module './Tabs.js'`。

- [ ] **Step 3: 实现 Tabs**

Create `web/src/components/ui/Tabs.tsx`:

```tsx
import './tabs.css'

export interface TabItem {
  key: string
  label: string
  count?: number
}

interface TabsProps {
  items: TabItem[]
  activeKey: string
  onChange: (key: string) => void
}

export function Tabs({ items, activeKey, onChange }: TabsProps) {
  return (
    <div className="ui-tabs" role="tablist">
      {items.map((item) => {
        const active = item.key === activeKey
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ui-tabs__tab${active ? ' ui-tabs__tab--active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            {item.label}
            {item.count !== undefined && <span className="ui-tabs__count">{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
```

Create `web/src/components/ui/tabs.css`:

```css
.ui-tabs {
  display: flex;
  gap: 4px;
}
.ui-tabs__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
}
.ui-tabs__tab:hover {
  background: var(--bg);
  color: var(--text);
}
.ui-tabs__tab--active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.ui-tabs__count {
  font-size: 11.5px;
  opacity: 0.8;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/ui/Tabs.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/ui/Tabs.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tabs } from './Tabs.js'

const meta: Meta<typeof Tabs> = {
  title: 'ui/Tabs',
  component: Tabs,
}
export default meta
type Story = StoryObj<typeof Tabs>

export const Default: Story = {
  args: {
    items: [
      { key: 'process', label: '调查过程' },
      { key: 'evidence', label: '证据链', count: 4 },
      { key: 'object', label: '对象上下文' },
    ],
    activeKey: 'evidence',
  },
}
```

注意：Story 需要 `onChange` 交互，Storybook 会自动为 action 属性生成；此 Story 未传 `onChange` 仅作展示，点击行为在组件测试中覆盖。

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Tabs.tsx src/components/ui/tabs.css src/components/ui/Tabs.test.tsx src/components/ui/Tabs.stories.tsx
git commit -m "feat(web): add Tabs component"
```

---

### Task 8: CodeBlock 组件（TDD）

**Files:**
- Test: `web/src/components/ui/CodeBlock.test.tsx`
- Create: `web/src/components/ui/CodeBlock.tsx`
- Create: `web/src/components/ui/code-block.css`
- Create: `web/src/components/ui/CodeBlock.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/ui/CodeBlock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeBlock } from './CodeBlock.js'

describe('CodeBlock', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders code and copies to clipboard', async () => {
    const user = userEvent.setup()
    render(<CodeBlock code="kubectl get pods" language="bash" />)
    expect(screen.getByText('kubectl get pods')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '复制' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('kubectl get pods')
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/CodeBlock.test.tsx`

Expected: FAIL，错误为 `Cannot find module './CodeBlock.js'`。

- [ ] **Step 3: 实现 CodeBlock**

Create `web/src/components/ui/CodeBlock.tsx`:

```tsx
import { useState } from 'react'
import './code-block.css'

interface CodeBlockProps {
  code: string
  language?: string
  title?: string
}

export function CodeBlock({ code, language = 'text', title }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard 不可用时静默失败
    }
  }

  return (
    <div className="ui-code-block">
      <div className="ui-code-block__head">
        <span className="ui-code-block__lang">{title ?? language}</span>
        <button type="button" className="ui-code-block__copy" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="ui-code-block__pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}
```

Create `web/src/components/ui/code-block.css`:

```css
.ui-code-block {
  background: var(--code-bg);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.ui-code-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.ui-code-block__lang {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: #8fa3b8;
}
.ui-code-block__copy {
  border: none;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 11.5px;
  color: #8fa3b8;
  cursor: pointer;
}
.ui-code-block__copy:hover {
  color: #cbd8e5;
}
.ui-code-block__pre {
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--code-text);
  white-space: pre;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/ui/CodeBlock.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/ui/CodeBlock.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { CodeBlock } from './CodeBlock.js'

const meta: Meta<typeof CodeBlock> = {
  title: 'ui/CodeBlock',
  component: CodeBlock,
}
export default meta
type Story = StoryObj<typeof CodeBlock>

export const Default: Story = {
  args: {
    language: 'bash',
    code: 'kubectl describe pod order-api-7f9c6d4b8c-x2j8l\n# 输出已截断\nLast State: OOMKilled (exit code 137)',
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/CodeBlock.tsx src/components/ui/code-block.css src/components/ui/CodeBlock.test.tsx src/components/ui/CodeBlock.stories.tsx
git commit -m "feat(web): add CodeBlock component"
```

---

### Task 9: Storybook 配置

**Files:**
- Create: `web/.storybook/main.ts`
- Create: `web/.storybook/preview.ts`
- Modify: `web/package.json`（scripts 增加 storybook / build-storybook）

- [ ] **Step 1: 创建 Storybook 主配置**

Create `web/.storybook/main.ts`:

```ts
import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
}

export default config
```

- [ ] **Step 2: 创建 Storybook preview（加载 token 与 base 样式）**

Create `web/.storybook/preview.ts`:

```ts
import '../src/styles/tokens.css'
import '../src/styles/base.css'
```

- [ ] **Step 3: package.json 增加 Storybook 脚本**

Modify `web/package.json` scripts to:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build"
  },
```

- [ ] **Step 4: 验证 Storybook 构建**

Run: `npm run build-storybook`

Expected: 构建成功，输出包含 `built storybook`（或 `Storybook ... built`）字样，且能找到 5 个 story（Markdown / Button / Badge / Tabs / CodeBlock）。

- [ ] **Step 5: Commit**

```bash
git add .storybook/main.ts .storybook/preview.ts package.json
git commit -m "chore(web): add storybook configuration"
```

---

### Task 10: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: 运行全部测试**

Run: `npm test`

Expected: PASS，测试文件 6 个（smoke / Markdown / Button / Badge / Tabs / CodeBlock），全部通过。

- [ ] **Step 2: 运行生产构建**

Run: `npm run build`

Expected: PASS（`tsc -b && vite build` 无报错）。

- [ ] **Step 3: 运行 Storybook 构建**

Run: `npm run build-storybook`

Expected: PASS。

- [ ] **Step 4: 提交收尾**

如果 Step 1-3 有任何修复，执行：

```bash
git add -A
git commit -m "fix(web): resolve M1 acceptance issues"
```

如果没有修复，跳过本步。

---

## M1 验收清单

- [ ] `npm test` 全部通过
- [ ] `npm run build` 通过
- [ ] `npm run build-storybook` 通过，5 个组件 story 可访问
- [ ] 页面默认浅色（`data-theme="light"`），`[data-theme="dark"]` token 覆盖存在
- [ ] 现有会话/审批功能未被改动（App.tsx 业务逻辑零变更）
- [ ] 提交历史为 Task 1-10 的独立 conventional commits

## M1 完成后的下一步

M1 完成后，编写并执行 M2 计划（布局骨架：TopBar / SideNav / Workspace / RightPanel + 告警中心静态页 + 导航切换 + 右栏折叠），再依次 M3（对话区重构）→ M4（结论卡片）→ M5（告警数据）→ M6（图表）→ M7（推理树）→ M8（打磨收尾）。
