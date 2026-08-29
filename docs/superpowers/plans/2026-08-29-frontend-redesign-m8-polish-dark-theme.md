# InfraPilot 前端改版 M8（暗色主题 + 打磨收尾）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成方案 C 收尾：暗色主题切换（token 机制已建，补持久化与设置入口）、深色下硬编码颜色 token 化、页面入场动效、补全组件 Story、全量回归与冒烟验证。

**Architecture:** 新增 `web/src/lib/theme.ts`（读取/应用/持久化 `data-theme`，localStorage key `infrapilot-theme`），`main.tsx` 启动时按持久化值初始化；新增无依赖的 `components/settings/AppearanceSection.tsx` 嵌入设置页；`tokens.css` 补充语义 token（hover/scrollbar/orange/alert 边框等）并在深色主题下覆盖，替换各组件 CSS 中的硬编码颜色；`workspace.css` 增加视图入场淡入。

**Tech Stack:** React 19 + Vite 8 + TypeScript；Vitest；Storybook。

**前置依赖：** M1-M7 已完成（token、组件库、布局、对话、结论卡、告警、图表、推理树）。

**执行前注意：**
- 工作目录为 `.worktrees/frontend-redesign-m1/web`。
- 代码编辑通过 apply_patch 写入 `.worktrees/frontend-redesign-m1/` 路径。
- 提交命令单独执行（不要与测试命令用 `&&` 串联）。
- **E2E 说明**：设计文档中 Playwright 为"可选"；当前环境无法下载浏览器二进制，故 M8 以组件测试补全 + dev 冒烟 + 全量回归代替，Playwright 留待网络环境允许时补充。
- 旧 `app.css`（约 3900 行）仍承载 main__tabs/composer/session-header/approval-card 等样式，本计划不迁移（超范围），只做主题 token 化走查；已知项记录在验收清单。

---

### Task 1: 主题工具（TDD）

**Files:**
- Test: `web/src/lib/theme.test.ts`
- Create: `web/src/lib/theme.ts`
- Modify: `web/src/main.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/lib/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getInitialTheme, applyTheme } from './theme.js'

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to light theme', () => {
    expect(getInitialTheme()).toBe('light')
  })

  it('applies and persists the selected theme', () => {
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('infrapilot-theme')).toBe('dark')
    expect(getInitialTheme()).toBe('dark')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/theme.test.ts`

Expected: FAIL，错误为 `Cannot find module './theme.js'`。

- [ ] **Step 3: 实现主题工具**

Create `web/src/lib/theme.ts`:

```ts
export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'infrapilot-theme'

export function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // localStorage 不可用时回退浅色
  }
  return 'light'
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 忽略存储失败
  }
}
```

- [ ] **Step 4: main.tsx 启动时按持久化值初始化**

`web/src/main.tsx` 修改为：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { getInitialTheme, applyTheme } from './lib/theme.js'
import './index.css'

applyTheme(getInitialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/lib/theme.test.ts`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 6: Commit**

```bash
git add src/lib/theme.ts src/lib/theme.test.ts src/main.tsx
git commit -m "feat(web): add theme utility with persistence"
```

---

### Task 2: 设置页外观区块（TDD）

**Files:**
- Test: `web/src/components/settings/AppearanceSection.test.tsx`
- Create: `web/src/components/settings/AppearanceSection.tsx`
- Create: `web/src/components/settings/appearance-section.css`
- Modify: `web/src/components/SettingsPage.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/settings/AppearanceSection.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppearanceSection } from './AppearanceSection.js'

describe('AppearanceSection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders light and dark options', () => {
    render(<AppearanceSection />)
    expect(screen.getByRole('button', { name: '浅色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '深色' })).toBeInTheDocument()
  })

  it('switches to dark theme on click', async () => {
    const user = userEvent.setup()
    render(<AppearanceSection />)
    await user.click(screen.getByRole('button', { name: '深色' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: '深色' }).className).toContain('appearance-section__option--active')
    expect(localStorage.getItem('infrapilot-theme')).toBe('dark')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/settings/AppearanceSection.test.tsx`

Expected: FAIL，错误为 `Cannot find module './AppearanceSection.js'`。

- [ ] **Step 3: 实现 AppearanceSection**

Create `web/src/components/settings/AppearanceSection.tsx`:

```tsx
import { useState } from 'react'
import { applyTheme, getInitialTheme } from '../../lib/theme.js'
import type { ThemeMode } from '../../lib/theme.js'
import './appearance-section.css'

export function AppearanceSection() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme)

  const choose = (mode: ThemeMode) => {
    applyTheme(mode)
    setTheme(mode)
  }

  return (
    <div className="appearance-section">
      <h3 className="appearance-section__title">外观</h3>
      <p className="appearance-section__desc">切换界面主题，选择后立即生效并记住偏好。</p>
      <div className="appearance-section__options">
        <button
          type="button"
          className={`appearance-section__option${theme === 'light' ? ' appearance-section__option--active' : ''}`}
          onClick={() => choose('light')}
        >
          <span className="appearance-section__swatch appearance-section__swatch--light" />
          浅色
        </button>
        <button
          type="button"
          className={`appearance-section__option${theme === 'dark' ? ' appearance-section__option--active' : ''}`}
          onClick={() => choose('dark')}
        >
          <span className="appearance-section__swatch appearance-section__swatch--dark" />
          深色
        </button>
      </div>
    </div>
  )
}
```

Create `web/src/components/settings/appearance-section.css`:

```css
.appearance-section__title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.appearance-section__desc {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 16px;
}
.appearance-section__options {
  display: flex;
  gap: 12px;
}
.appearance-section__option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text-2);
  font-size: 13px;
  font-family: var(--font-sans);
  cursor: pointer;
}
.appearance-section__option:hover {
  border-color: var(--border-strong);
}
.appearance-section__option--active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.appearance-section__swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
}
.appearance-section__swatch--light {
  background: #ffffff;
}
.appearance-section__swatch--dark {
  background: #0f1115;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/settings/AppearanceSection.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: SettingsPage 接入**

`web/src/components/SettingsPage.tsx` 修改：
- 顶部 import 新增：

```tsx
import { AppearanceSection } from "./settings/AppearanceSection.js";
```

- `SECTIONS` 数组末尾追加：

```tsx
  { id: "appearance", label: "外观" },
```

- 在设置内容区 `memory-management` section 结束后、`settings-footer` 之前追加：

```tsx
              <section id="appearance" className="settings-section card">
                <AppearanceSection />
              </section>
```

- [ ] **Step 6: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/AppearanceSection.tsx src/components/settings/appearance-section.css src/components/settings/AppearanceSection.test.tsx src/components/SettingsPage.tsx
git commit -m "feat(web): add appearance section with theme switch"
```

---

### Task 3: 深色 token 补全与硬编码替换

**Files:**
- Modify: `web/src/styles/tokens.css`
- Modify: `web/src/styles/base.css`
- Modify: `web/src/components/ui/badge.css`
- Modify: `web/src/components/conclusion/evidence-citation.css`
- Modify: `web/src/components/alerts/alert-list.css`
- Modify: `web/src/components/conversation/process-section.css`
- Modify: `web/src/components/alerts/health-grid.css`
- Modify: `web/src/components/console/topbar.css`

- [ ] **Step 1: 补充语义 token**

`web/src/styles/tokens.css` 的 `:root` 末尾追加：

```css
  --hover-bg: #fafbfc;
  --scrollbar-thumb: #d8dde3;
  --orange-bg: #ffedd5;
  --orange-text: #ea580c;
  --accent-soft-strong: #d3ebe8;
  --alert-border: #f3cdcd;
  --pill-border-warn: #f3dfc1;
  --pill-border-danger: #f3cdcd;
```

`[data-theme="dark"]` 块内追加：

```css
  --hover-bg: #1f242e;
  --scrollbar-thumb: #3a4150;
  --orange-bg: #3a2c12;
  --orange-text: #fbbf24;
  --accent-soft-strong: #14504a;
  --alert-border: #5a2426;
  --pill-border-warn: #5a4a24;
  --pill-border-danger: #5a2426;
```

- [ ] **Step 2: 替换硬编码颜色**

逐文件替换：

`web/src/styles/base.css`：

```css
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
```

`web/src/components/ui/badge.css`：

```css
.ui-badge--orange {
  background: var(--orange-bg);
  color: var(--orange-text);
}
```

`web/src/components/conclusion/evidence-citation.css`：

```css
.ui-evidence-citation:hover {
  background: var(--accent-soft-strong);
}
```

`web/src/components/alerts/alert-list.css`：

```css
.alert-row:hover {
  background: var(--hover-bg);
}
```

`web/src/components/conversation/process-section.css`：

```css
.ui-process-group__head:hover {
  background: var(--hover-bg);
}
```

`web/src/components/alerts/health-grid.css`：

```css
.health-card--alert {
  border-color: var(--alert-border);
}
```

`web/src/components/console/topbar.css`：

```css
.ui-pill--warn {
  border-color: var(--pill-border-warn);
}
.ui-pill--danger {
  border-color: var(--pill-border-danger);
}
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/styles/tokens.css src/styles/base.css src/components/ui/badge.css src/components/conclusion/evidence-citation.css src/components/alerts/alert-list.css src/components/conversation/process-section.css src/components/alerts/health-grid.css src/components/console/topbar.css
git commit -m "feat(web): tokenize hardcoded colors for dark theme"
```

---

### Task 4: 视图入场动效

**Files:**
- Modify: `web/src/components/console/workspace.css`

- [ ] **Step 1: 添加淡入动效**

`web/src/components/console/workspace.css` 追加：

```css
.ui-workspace > * {
  animation: ui-fade-in-up 0.18s ease both;
}
@keyframes ui-fade-in-up {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/components/console/workspace.css
git commit -m "feat(web): add workspace view entrance animation"
```

---

### Task 5: 补全组件 Story

**Files:**
- Create: `web/src/components/console/SessionList.stories.tsx`
- Create: `web/src/components/console/Workspace.stories.tsx`
- Create: `web/src/components/conversation/StreamStatusLine.stories.tsx`

- [ ] **Step 1: SessionList Story**

Create `web/src/components/console/SessionList.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { SessionList } from './SessionList.js'

const meta: Meta<typeof SessionList> = {
  title: 'console/SessionList',
  component: SessionList,
}
export default meta
type Story = StoryObj<typeof SessionList>

const makeSession = (id: string, title: string, status: string) => ({
  id,
  title,
  status,
  createdAt: '2026-08-25T10:00:00Z',
  updatedAt: '2026-08-25T10:30:00Z',
  incidentSummary: '',
  plan: [],
  evidence: [],
  pendingToolCalls: [],
  executedToolCalls: [],
  iteration: 3,
  maxIterations: 20,
})

export const Default: Story = {
  args: {
    activeSessions: [makeSession('s1', 'order-api 内存异常排查', 'concluded')],
    closedSessions: [makeSession('s2', 'node-08 磁盘排查', 'closed')],
    currentId: 's1',
    search: '',
  },
}
```

- [ ] **Step 2: Workspace Story**

Create `web/src/components/console/Workspace.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Workspace } from './Workspace.js'

const meta: Meta<typeof Workspace> = {
  title: 'console/Workspace',
  component: Workspace,
}
export default meta
type Story = StoryObj<typeof Workspace>

export const Default: Story = {
  render: () => (
    <Workspace>
      <div style={{ padding: 24 }}>工作台内容区</div>
    </Workspace>
  ),
}
```

- [ ] **Step 3: StreamStatusLine Story**

Create `web/src/components/conversation/StreamStatusLine.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { StreamStatusLine } from './StreamStatusLine.js'

const meta: Meta<typeof StreamStatusLine> = {
  title: 'conversation/StreamStatusLine',
  component: StreamStatusLine,
}
export default meta
type Story = StoryObj<typeof StreamStatusLine>

export const Default: Story = {
  args: { text: '正在执行 k8s.describe_pod()…' },
}
```

- [ ] **Step 4: 构建 Storybook 验证**

Run: `npm run build-storybook`

Expected: PASS，新增 story 可访问。

- [ ] **Step 5: Commit**

```bash
git add src/components/console/SessionList.stories.tsx src/components/console/Workspace.stories.tsx src/components/conversation/StreamStatusLine.stories.tsx
git commit -m "docs(web): add missing component stories"
```

---

### Task 6: 全量回归与冒烟

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: web 测试与构建**

Run: `npm test` 与 `npm run build`（web 目录）

Expected: PASS。

- [ ] **Step 2: Storybook 构建**

Run: `npm run build-storybook`（web 目录）

Expected: PASS。

- [ ] **Step 3: server 测试与构建**

Run: `npm test` 与 `npm run build`（server 目录）

Expected: PASS（除既有沙箱 listen 失败外）。

- [ ] **Step 4: dev 冒烟**

启动 `npm run dev`，从沙箱外依次验证：

```bash
curl -ksS -m 8 -o /dev/null -w "http:%{http_code}\n" http://localhost:5173/
curl -ksS -m 8 -o /dev/null -w "theme:%{http_code}\n" http://localhost:5173/src/lib/theme.ts
```

Expected: 均返回 200；随后 Ctrl-C 停止。

- [ ] **Step 5: 提交收尾**

如果上述有修复：

```bash
git add -A
git commit -m "fix: resolve M8 acceptance issues"
```

---

## M8 验收清单

- [ ] 设置页"外观"区块可切换浅色/深色，立即生效并持久化（localStorage）
- [ ] 启动时按持久化主题初始化
- [ ] 深色主题下 hover/滚动条/告警边框/橙色 badge/引用角标不再出现浅色硬编码（token 化）
- [ ] 工作台视图切换有 120ms 淡入动效
- [ ] SessionList / Workspace / StreamStatusLine 补齐 Story
- [ ] web 测试/build/storybook、server 测试/build 全部通过
- [ ] dev 冒烟 200

## 已知项（不在本计划范围）

- 旧 `app.css` 中仍在使用的主区样式（main__tabs/composer/session-header/approval-card）未迁移到新 token；深色下这些区块走现有浅色变量，属已知瑕疵，后续可随 app.css 迁移一并处理。
- Playwright E2E 因环境无法下载浏览器二进制暂缓，已用组件测试 + 冒烟替代。
- 推理树依赖模型稳定输出 `【假设列表】`，需真实对话调优验证。

## M8 完成后的下一步

方案 C 全部里程碑完成后，使用 superpowers:finishing-a-development-branch 收尾：验证全量测试、向用户呈现分支合并/PR/清理选项并执行。
