# InfraPilot 前端改版 M4（结论卡片 + 证据回链）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将根因结论从"时间线里的一条文本"升级为结构化结论卡片（根因/置信度/证据链/修复建议），并打通"结论证据角标 → 右栏证据链高亮"的双向引用。

**Architecture:** 新增 `components/conclusion/`（ConclusionCard + EvidenceCitation）与 `components/panels/EvidenceList`；`RightPanel` 增加受控模式（activeTab/onTabChange），App 持有右栏 Tab 状态与高亮 ID，点角标时切到证据链 Tab 并高亮对应证据卡。结论卡放在会话时间线底部、输入框上方（常驻）。修复建议直接渲染后端已有的 `remediation` 结构化数据；整单审批按钮因后端暂无"整单审批"接口，先提示走逐操作审批。

**Tech Stack:** React 19 + Vite 8 + TypeScript；M1 组件库（Badge/Button）；Vitest + Testing Library。

**前置依赖：** M1-M3 已完成。

**执行前注意：**
- 工作目录为 `web/`；代码编辑通过 apply_patch 写入 `.worktrees/frontend-redesign-m1/web/` 路径。
- 提交命令单独执行（不要与测试命令用 `&&` 串联）。
- 正文级 `[证据#N]` 文本解析（LLM 输出契约）属于后端里程碑，不在本计划范围；本计划的回链基于后端已有的 `rootCause.evidenceChain` 真实 ID。

---

### Task 1: Badge 增加 orange 色（TDD）

**Files:**
- Modify: `web/src/components/ui/Badge.test.tsx`
- Modify: `web/src/components/ui/Badge.tsx`
- Modify: `web/src/components/ui/badge.css`

- [ ] **Step 1: 写失败测试**

在 `web/src/components/ui/Badge.test.tsx` 追加：

```tsx
  it('renders orange tone', () => {
    render(<Badge label="high" tone="orange" />)
    expect(screen.getByText('high').className).toContain('ui-badge--orange')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ui/Badge.test.tsx`

Expected: FAIL（TS 类型错误：`orange` 不在 BadgeTone 中）。

- [ ] **Step 3: 扩展 BadgeTone 与样式**

`web/src/components/ui/Badge.tsx` 中类型改为：

```tsx
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'orange'
```

`web/src/components/ui/badge.css` 追加：

```css
.ui-badge--orange {
  background: #ffedd5;
  color: #ea580c;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/ui/Badge.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/Badge.tsx src/components/ui/badge.css src/components/ui/Badge.test.tsx
git commit -m "feat(web): add orange tone to Badge"
```

---

### Task 2: EvidenceCitation 组件（TDD）

**Files:**
- Test: `web/src/components/conclusion/EvidenceCitation.test.tsx`
- Create: `web/src/components/conclusion/EvidenceCitation.tsx`
- Create: `web/src/components/conclusion/evidence-citation.css`
- Create: `web/src/components/conclusion/EvidenceCitation.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conclusion/EvidenceCitation.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EvidenceCitation } from './EvidenceCitation.js'

describe('EvidenceCitation', () => {
  it('renders label and fires onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<EvidenceCitation label="证据#1 · 主要" onClick={onClick} />)
    const chip = screen.getByRole('button', { name: '证据#1 · 主要' })
    await user.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conclusion/EvidenceCitation.test.tsx`

Expected: FAIL，错误为 `Cannot find module './EvidenceCitation.js'`。

- [ ] **Step 3: 实现 EvidenceCitation**

Create `web/src/components/conclusion/EvidenceCitation.tsx`:

```tsx
import './evidence-citation.css'

export function EvidenceCitation({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="ui-evidence-citation" onClick={onClick}>
      {label}
    </button>
  )
}
```

Create `web/src/components/conclusion/evidence-citation.css`:

```css
.ui-evidence-citation {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease;
}
.ui-evidence-citation:hover {
  background: #d3ebe8;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conclusion/EvidenceCitation.test.tsx`

Expected: PASS，`Tests  1 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/conclusion/EvidenceCitation.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { EvidenceCitation } from './EvidenceCitation.js'

const meta: Meta<typeof EvidenceCitation> = {
  title: 'conclusion/EvidenceCitation',
  component: EvidenceCitation,
}
export default meta
type Story = StoryObj<typeof EvidenceCitation>

export const Default: Story = {
  args: { label: '证据#1 · 主要' },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/conclusion/EvidenceCitation.tsx src/components/conclusion/evidence-citation.css src/components/conclusion/EvidenceCitation.test.tsx src/components/conclusion/EvidenceCitation.stories.tsx
git commit -m "feat(web): add evidence citation chip"
```

---

### Task 3: EvidenceList 组件（TDD）

**Files:**
- Test: `web/src/components/panels/EvidenceList.test.tsx`
- Create: `web/src/components/panels/EvidenceList.tsx`
- Create: `web/src/components/panels/evidence-list.css`
- Create: `web/src/components/panels/EvidenceList.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/panels/EvidenceList.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EvidenceList } from './EvidenceList.js'
import type { Evidence } from '../../lib/types.js'

const evidence: Evidence[] = [
  { id: 'ev1', sourceSkill: 'k8s', type: 'k8s_event', content: { exitCode: 137 }, confidence: 0.92, collectedAt: '2026-08-25T10:38:00Z', summary: 'Pod 事件：OOMKilled' },
  { id: 'ev2', sourceSkill: 'elk', type: 'log_cluster', content: 'error log', confidence: 0.84, collectedAt: '2026-08-25T10:35:00Z', summary: '错误日志聚类' },
]

describe('EvidenceList', () => {
  it('renders evidence cards', () => {
    render(<EvidenceList evidence={evidence} />)
    expect(screen.getByText('Pod 事件：OOMKilled')).toBeInTheDocument()
    expect(screen.getByText('置信度 92%')).toBeInTheDocument()
  })

  it('highlights the target evidence id', () => {
    const { container } = render(<EvidenceList evidence={evidence} highlightId="ev2" />)
    const cards = container.querySelectorAll('.ev-card')
    expect(cards[0].className).not.toContain('ev-card--highlight')
    expect(cards[1].className).toContain('ev-card--highlight')
  })

  it('renders empty state', () => {
    render(<EvidenceList evidence={[]} />)
    expect(screen.getByText(/暂无证据/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/panels/EvidenceList.test.tsx`

Expected: FAIL，错误为 `Cannot find module './EvidenceList.js'`。

- [ ] **Step 3: 实现 EvidenceList**

Create `web/src/components/panels/EvidenceList.tsx`:

```tsx
import type { Evidence } from '../../lib/types.js'
import './evidence-list.css'

interface EvidenceListProps {
  evidence: Evidence[]
  highlightId?: string | null
}

export function EvidenceList({ evidence, highlightId }: EvidenceListProps) {
  if (evidence.length === 0) {
    return <p className="evidence-list__empty">暂无证据，等待 Agent 收集诊断证据</p>
  }
  return (
    <div className="evidence-list">
      {evidence.map((item) => (
        <div
          key={item.id}
          id={`evidence-${item.id}`}
          className={`ev-card${highlightId === item.id ? ' ev-card--highlight' : ''}`}
        >
          <div className="ev-card__head">
            <span className="ev-card__type">{item.sourceSkill ?? item.type}</span>
            <span className="ev-card__confidence">置信度 {Math.round(item.confidence * 100)}%</span>
          </div>
          <div className="ev-card__summary">{item.summary}</div>
          {item.content && (
            <pre className="ev-card__content">
              {typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2)}
            </pre>
          )}
          <div className="ev-card__time">{new Date(item.collectedAt).toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}
```

Create `web/src/components/panels/evidence-list.css`:

```css
.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.evidence-list__empty {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
.ev-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  background: var(--panel);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ev-card--highlight {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
}
.ev-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ev-card__type {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 7px;
  border-radius: 4px;
}
.ev-card__confidence {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
}
.ev-card__summary {
  font-size: 13px;
  margin-bottom: 8px;
}
.ev-card__content {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-2);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.ev-card__time {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 8px;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/panels/EvidenceList.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/panels/EvidenceList.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { EvidenceList } from './EvidenceList.js'

const meta: Meta<typeof EvidenceList> = {
  title: 'panels/EvidenceList',
  component: EvidenceList,
}
export default meta
type Story = StoryObj<typeof EvidenceList>

export const Default: Story = {
  args: {
    evidence: [
      { id: 'ev1', sourceSkill: 'k8s', type: 'k8s_event', content: { exitCode: 137 }, confidence: 0.92, collectedAt: '2026-08-25T10:38:00Z', summary: 'Pod 事件：OOMKilled，退出码 137' },
      { id: 'ev2', sourceSkill: 'elk', type: 'log_cluster', content: 'error log', confidence: 0.84, collectedAt: '2026-08-25T10:35:00Z', summary: '错误日志聚类：2 类与内存相关' },
    ],
    highlightId: 'ev1',
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/panels/EvidenceList.tsx src/components/panels/evidence-list.css src/components/panels/EvidenceList.test.tsx src/components/panels/EvidenceList.stories.tsx
git commit -m "feat(web): add evidence list panel with highlight"
```

---

### Task 4: ConclusionCard 组件（TDD）

**Files:**
- Test: `web/src/components/conclusion/ConclusionCard.test.tsx`
- Create: `web/src/components/conclusion/ConclusionCard.tsx`
- Create: `web/src/components/conclusion/conclusion-card.css`
- Create: `web/src/components/conclusion/ConclusionCard.stories.tsx`

- [ ] **Step 1: 写失败测试**

Create `web/src/components/conclusion/ConclusionCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConclusionCard } from './ConclusionCard.js'
import type { RootCause, Remediation } from '../../lib/types.js'

const rootCause: RootCause = {
  summary: 'order-api 内存 limit 256Mi 过低，触发 OOMKilled',
  confidence: 0.87,
  evidenceChain: [
    { evidenceId: 'ev1', role: 'primary' },
    { evidenceId: 'ev2', role: 'supporting' },
  ],
  alternativeHypotheses: ['节点资源不足（已排除）'],
}

const remediation: Remediation = {
  summary: '调整内存 limit',
  steps: [
    { description: '将内存 limit 从 256Mi 调整到 512Mi', skill: 'k8s', tool: 'patch_deployment', risk: 'medium', rollback: '改回 256Mi' },
  ],
}

describe('ConclusionCard', () => {
  it('renders summary, confidence and remediation', () => {
    render(<ConclusionCard rootCause={rootCause} remediation={remediation} onCitationClick={() => {}} />)
    expect(screen.getByText('根因分析结论')).toBeInTheDocument()
    expect(screen.getByText(/order-api 内存 limit 256Mi/)).toBeInTheDocument()
    expect(screen.getByText('置信度 87%')).toBeInTheDocument()
    expect(screen.getByText('将内存 limit 从 256Mi 调整到 512Mi')).toBeInTheDocument()
  })

  it('fires citation click with evidence id', async () => {
    const onCitationClick = vi.fn()
    const user = userEvent.setup()
    render(<ConclusionCard rootCause={rootCause} onCitationClick={onCitationClick} />)
    await user.click(screen.getByRole('button', { name: /证据#1/ }))
    expect(onCitationClick).toHaveBeenCalledWith('ev1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/conclusion/ConclusionCard.test.tsx`

Expected: FAIL，错误为 `Cannot find module './ConclusionCard.js'`。

- [ ] **Step 3: 实现 ConclusionCard**

Create `web/src/components/conclusion/ConclusionCard.tsx`:

```tsx
import { Badge } from '../ui/Badge.js'
import { Button } from '../ui/Button.js'
import { EvidenceCitation } from './EvidenceCitation.js'
import type { RootCause, Remediation, RiskLevel } from '../../lib/types.js'
import './conclusion-card.css'

const roleLabel: Record<string, string> = {
  primary: '主要',
  supporting: '支撑',
  ruled_out: '已排除',
}

const riskTone: Record<RiskLevel, 'info' | 'success' | 'warn' | 'orange' | 'danger'> = {
  readonly: 'info',
  low: 'success',
  medium: 'warn',
  high: 'orange',
  critical: 'danger',
}

interface ConclusionCardProps {
  rootCause: RootCause
  remediation?: Remediation
  onCitationClick: (evidenceId: string) => void
  onApproveRemediation?: () => void
}

export function ConclusionCard({
  rootCause,
  remediation,
  onCitationClick,
  onApproveRemediation,
}: ConclusionCardProps) {
  const confidence = Math.round((rootCause.confidence ?? 0) * 100)

  return (
    <section className="conclusion-card">
      <div className="conclusion-card__head">
        <h2 className="conclusion-card__title">根因分析结论</h2>
        <Badge label={`置信度 ${confidence}%`} tone="accent" />
      </div>
      <p className="conclusion-card__summary">{rootCause.summary}</p>
      {rootCause.evidenceChain.length > 0 && (
        <div className="conclusion-card__chain">
          {rootCause.evidenceChain.map((ref, index) => (
            <EvidenceCitation
              key={ref.evidenceId}
              label={`证据#${index + 1}${roleLabel[ref.role] ? ` · ${roleLabel[ref.role]}` : ''}`}
              onClick={() => onCitationClick(ref.evidenceId)}
            />
          ))}
        </div>
      )}
      {rootCause.alternativeHypotheses.length > 0 && (
        <div className="conclusion-card__alt">
          <span className="conclusion-card__alt-label">已排除假设</span>
          <ul>
            {rootCause.alternativeHypotheses.map((hypothesis) => (
              <li key={hypothesis}>{hypothesis}</li>
            ))}
          </ul>
        </div>
      )}
      {remediation && remediation.steps.length > 0 && (
        <div className="conclusion-card__remediation">
          <div className="conclusion-card__remediation-title">修复建议</div>
          {remediation.steps.map((step, index) => (
            <div key={index} className="remediation-row">
              <span className="remediation-row__idx">{index + 1}</span>
              <span className="remediation-row__desc">{step.description}</span>
              {step.skill && step.tool && <code className="remediation-row__cmd">{step.skill}.{step.tool}()</code>}
              {step.risk && <Badge label={step.risk} tone={riskTone[step.risk]} />}
            </div>
          ))}
        </div>
      )}
      {onApproveRemediation && (
        <div className="conclusion-card__actions">
          <Button variant="primary" onClick={onApproveRemediation}>
            批准执行修复
          </Button>
          <Button variant="secondary">拒绝</Button>
        </div>
      )}
    </section>
  )
}
```

Create `web/src/components/conclusion/conclusion-card.css`:

```css
.conclusion-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  padding: 18px 20px;
}
.conclusion-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.conclusion-card__title {
  font-size: 15px;
  font-weight: 600;
}
.conclusion-card__summary {
  font-size: 14.5px;
  line-height: 1.7;
}
.conclusion-card__chain {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0;
}
.conclusion-card__alt {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 12px;
}
.conclusion-card__alt-label {
  font-weight: 600;
  margin-right: 8px;
}
.conclusion-card__alt ul {
  padding-left: 18px;
  margin-top: 4px;
}
.conclusion-card__remediation-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.remediation-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
  font-size: 13px;
}
.remediation-row__idx {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 50%;
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.remediation-row__desc {
  flex: 1;
  min-width: 0;
}
.remediation-row__cmd {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg);
  border-radius: 4px;
  padding: 2px 6px;
}
.conclusion-card__actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/conclusion/ConclusionCard.test.tsx`

Expected: PASS，`Tests  2 passed`。

- [ ] **Step 5: 创建 Story**

Create `web/src/components/conclusion/ConclusionCard.stories.tsx`:

```tsx
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConclusionCard } from './ConclusionCard.js'

const meta: Meta<typeof ConclusionCard> = {
  title: 'conclusion/ConclusionCard',
  component: ConclusionCard,
}
export default meta
type Story = StoryObj<typeof ConclusionCard>

export const Default: Story = {
  args: {
    rootCause: {
      summary: 'order-api 容器内存 limit（256Mi）低于高峰流量需求，触发 OOMKilled 并持续重启',
      confidence: 0.87,
      evidenceChain: [
        { evidenceId: 'ev1', role: 'primary' },
        { evidenceId: 'ev2', role: 'supporting' },
        { evidenceId: 'ev3', role: 'supporting' },
      ],
      alternativeHypotheses: ['节点资源不足（已排除）'],
    },
    remediation: {
      summary: '调整内存 limit',
      steps: [
        { description: '将内存 limit 从 256Mi 调整到 512Mi', skill: 'k8s', tool: 'patch_deployment', risk: 'medium', rollback: '改回 256Mi' },
        { description: '观察 15 分钟确认重启归零', skill: 'k8s', tool: 'get_pods', risk: 'low' },
      ],
    },
  },
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/conclusion/ConclusionCard.tsx src/components/conclusion/conclusion-card.css src/components/conclusion/ConclusionCard.test.tsx src/components/conclusion/ConclusionCard.stories.tsx
git commit -m "feat(web): add structured conclusion card with evidence citations"
```

---

### Task 5: RightPanel 受控模式（TDD）

**Files:**
- Modify: `web/src/components/console/RightPanel.test.tsx`
- Modify: `web/src/components/console/RightPanel.tsx`

- [ ] **Step 1: 写失败测试**

在 `web/src/components/console/RightPanel.test.tsx` 追加：

```tsx
  it('supports controlled active tab', async () => {
    const onTabChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <RightPanel
        process={<p>过程内容</p>}
        evidence={<p>证据内容</p>}
        object={<p>对象内容</p>}
        activeTab="process"
        onTabChange={onTabChange}
      />,
    )
    await user.click(screen.getByRole('tab', { name: '证据链' }))
    expect(onTabChange).toHaveBeenCalledWith('evidence')
    rerender(
      <RightPanel
        process={<p>过程内容</p>}
        evidence={<p>证据内容</p>}
        object={<p>对象内容</p>}
        activeTab="evidence"
        onTabChange={onTabChange}
      />,
    )
    expect(screen.getByText('证据内容')).toBeInTheDocument()
  })
```

需要在该测试文件顶部补充 `import { vi } from 'vitest'`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/console/RightPanel.test.tsx`

Expected: FAIL（`activeTab`/`onTabChange` 不是 RightPanelProps 的属性）。

- [ ] **Step 3: 实现受控模式**

`web/src/components/console/RightPanel.tsx` 修改为：

```tsx
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Tabs } from '../ui/Tabs.js'
import './right-panel.css'

export type PanelTab = 'process' | 'evidence' | 'object'

const tabs: { key: PanelTab; label: string }[] = [
  { key: 'process', label: '调查过程' },
  { key: 'evidence', label: '证据链' },
  { key: 'object', label: '对象上下文' },
]

interface RightPanelProps {
  process: ReactNode
  evidence: ReactNode
  object: ReactNode
  activeTab?: PanelTab
  onTabChange?: (tab: PanelTab) => void
}

export function RightPanel({ process, evidence, object, activeTab: controlledTab, onTabChange }: RightPanelProps) {
  const [internalTab, setInternalTab] = useState<PanelTab>('process')
  const [collapsed, setCollapsed] = useState(false)
  const activeTab = controlledTab ?? internalTab
  const content: Record<PanelTab, ReactNode> = { process, evidence, object }

  const changeTab = (key: string) => {
    const tab = key as PanelTab
    if (onTabChange) {
      onTabChange(tab)
    } else {
      setInternalTab(tab)
    }
  }

  return (
    <aside className={`ui-right-panel${collapsed ? ' ui-right-panel--collapsed' : ''}`}>
      <div className="ui-right-panel__head">
        <Tabs items={tabs} activeKey={activeTab} onChange={changeTab} />
        <button
          type="button"
          className="ui-right-panel__collapse"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? '展开右栏' : '折叠右栏'}
        >
          {collapsed ? '«' : '»'}
        </button>
      </div>
      <div className="ui-right-panel__body">{content[activeTab]}</div>
    </aside>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/console/RightPanel.test.tsx`

Expected: PASS，`Tests  3 passed`。

- [ ] **Step 5: Commit**

```bash
git add src/components/console/RightPanel.tsx src/components/console/RightPanel.test.tsx
git commit -m "feat(web): add controlled mode to RightPanel"
```

---

### Task 6: App.tsx 接线（结论卡 + 证据回链）

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: 新增 import 与状态**

在 `web/src/App.tsx` 的 import 区新增：

```tsx
import { ConclusionCard } from "./components/conclusion/ConclusionCard.js";
import { EvidenceList } from "./components/panels/EvidenceList.js";
import { RightPanel, type PanelTab } from "./components/console/RightPanel.js";
```

（现有 `RightPanel` import 改为上面这行。）

在 App 组件内、`handleInvestigateAlert` 之后新增：

```tsx
  const [rightTab, setRightTab] = useState<PanelTab>("process");
  const [highlightEvidenceId, setHighlightEvidenceId] = useState<string | null>(null);

  const handleCitationClick = (evidenceId: string) => {
    setHighlightEvidenceId(evidenceId);
    setRightTab("evidence");
  };
```

- [ ] **Step 2: 会话视图加入结论卡片**

在会话 fragment 中，`</div>`（`main__content` 结束）与 composer 之间插入（仅当时间线 Tab 且有根因结论时）：

```tsx
                {mainTab === "timeline" && currentSession.rootCause && (
                  <ConclusionCard
                    rootCause={currentSession.rootCause}
                    remediation={currentSession.remediation}
                    onCitationClick={handleCitationClick}
                    onApproveRemediation={() =>
                      notify("整单修复审批将在后续版本接入，当前请使用时间线中的逐操作审批")
                    }
                  />
                )}
```

- [ ] **Step 3: 右栏接入证据链与受控模式**

将现有 RightPanel 调用替换为：

```tsx
        {currentView === "sessions" && currentSession && (
          <RightPanel
            activeTab={rightTab}
            onTabChange={setRightTab}
            process={<p className="ui-rp-placeholder">调查过程：M7 接入推理树</p>}
            evidence={<EvidenceList evidence={currentSession.evidence} highlightId={highlightEvidenceId} />}
            object={<ContextPanel />}
          />
        )}
```

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
git commit -m "feat(web): wire conclusion card and evidence highlight"
```

---

### Task 7: 全量验收

**Files:** 无新增；如发现问题则修复对应文件。

- [ ] **Step 1: 运行全部测试**

Run: `npm test`

Expected: PASS。

- [ ] **Step 2: 运行生产构建**

Run: `npm run build`

Expected: PASS。

- [ ] **Step 3: 运行 Storybook 构建**

Run: `npm run build-storybook`

Expected: PASS。

- [ ] **Step 4: 提交收尾**

如果 Step 1-3 有修复：

```bash
git add -A
git commit -m "fix(web): resolve M4 acceptance issues"
```

---

## M4 验收清单

- [ ] 结论卡片展示根因、置信度、证据角标链、已排除假设、修复建议（含风险等级）
- [ ] 点击证据角标 → 右栏切到"证据链"Tab 并高亮对应证据卡
- [ ] 右栏证据链展示真实 `session.evidence` 数据
- [ ] 无根因结论时不显示结论卡；无证据时显示空态
- [ ] Badge 支持 orange（high 风险）
- [ ] `npm test`、`npm run build`、`npm run build-storybook` 全部通过

## M4 完成后的下一步

M5（告警后端数据：Alert 模型 + seed + `/api/alerts`）、M6（图表与对象数据）、M7（推理树）、M8（暗色主题 + 打磨）。
