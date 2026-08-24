# Web 技能管理页（二期） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有“技能中心”页面增加技能包管理：已安装技能列表（启停/卸载）+ 精选技能安装表单，对接已完成的 `/api/skills` 后端接口。

**Architecture:** 前端只消费后端已就绪的 REST API（`/skills`、`/skills/curated`、`/skills/install`、`PATCH/DELETE /skills/:name`）。在 `lib/api.ts` 增加类型与请求封装，在 `SkillsPage.tsx` 增加两个区块（已安装管理 + 安装表单），样式复用现有 app.css 的 `skill-card`/`toggle`/`btn` 体系并补充少量新类。

**Tech Stack:** React 19 + Vite、TypeScript（`tsc -b`）、现有 `request<T>` 封装。本仓库 web 无测试框架（package.json 无 test script），验证 = `npm run build`（tsc -b && vite build）+ dev server 冒烟；不为此引入测试框架（YAGNI）。

---

## 文件结构

**修改**
- `web/src/lib/api.ts` — 新增 `SkillPackageInfo` / `CuratedSkill` 类型与 5 个请求函数
- `web/src/components/SkillsPage.tsx` — 保留 Draw.io 卡片，新增技能包管理区（列表/启停/卸载）+ 安装区（精选/手动表单）
- `web/src/styles/app.css` — 新增技能包卡片、状态 chip、安装表单样式

---

### Task 1: API 客户端（类型 + 请求函数）

**Files:**
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: 在 api.ts 末尾追加类型与函数**

```ts
export interface SkillPackageInfo {
  name: string;
  description: string;
  enabled: boolean;
  references: string[];
  scripts: string[];
  assets: string[];
  source?: string;
  version?: string;
}

export interface CuratedSkill {
  name: string;
  repo: string;
  path: string;
  description: string;
}

export function listSkills(onError?: OnError) {
  return request<{ skills: SkillPackageInfo[] }>("/skills", undefined, onError);
}

export function listCuratedSkills(onError?: OnError) {
  return request<{ skills: CuratedSkill[] }>("/skills/curated", undefined, onError);
}

export function installSkill(
  body: { repo: string; path: string; ref?: string; token?: string },
  onError?: OnError
) {
  return request<{ ok: boolean; name: string }>("/skills/install", {
    method: "POST",
    body: JSON.stringify(body),
  }, onError);
}

export function setSkillEnabled(name: string, enabled: boolean, onError?: OnError) {
  return request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }, onError);
}

export function uninstallSkill(name: string, onError?: OnError) {
  return request<{ ok: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }, onError);
}
```

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: `tsc -b` 与 vite build 均通过

- [ ] **Step 3: Commit**

```bash
cd web && git add src/lib/api.ts
git commit -m "feat(ui): add skill package api client"
```

---

### Task 2: 已安装技能包管理区

**Files:**
- Modify: `web/src/components/SkillsPage.tsx`
- Modify: `web/src/styles/app.css`

- [ ] **Step 1: 修改 SkillsPage.tsx 的 import 与顶部逻辑**

文件顶部 import 改为：

```ts
import { useEffect, useState } from "react";
import {
  exportDrawioDiagram,
  generateDrawioFlowchart,
  listSkills,
  setSkillEnabled,
  uninstallSkill,
  type LogRelation,
  type SkillPackageInfo,
  downloadDrawioUrl,
} from "../lib/api.js";
import { DrawioImageViewer } from "./DrawioImageViewer.js";
```

说明：Task 2 只导入当前用到的 `listSkills/setSkillEnabled/uninstallSkill/SkillPackageInfo`；`installSkill/listCuratedSkills/CuratedSkill` 在 Task 3 一并补入，避免 tsc 未使用告警。

`SkillsPage` 组件的 return 改为：

```tsx
export function SkillsPage({ notify }: SkillsPageProps) {
  return (
    <div className="skills-page">
      <div className="page-header">
        <h1 className="page-header__title">技能中心</h1>
        <p className="page-header__subtitle">技能包管理：安装开源 SKILL.md、启停诊断方法论，扩展 AI Agent 能力</p>
      </div>
      <div className="main__content">
        <SkillPackagesSection notify={notify} />
        <DrawioFlowchartSkill notify={notify} />
      </div>
    </div>
  );
}
```

在 `SkillsPage` 与 `DrawioFlowchartSkill` 之间插入 `SkillPackagesSection` 组件（`InstallSkillSection` 在 Task 3 加入，避免 Task 2 编译失败）：

```tsx
function SkillPackagesSection({ notify }: { notify: NotifyFn }) {
  const [skills, setSkills] = useState<SkillPackageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const res = await listSkills((err) => notify(err.message));
    if (res) setSkills(res.skills);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleToggle = async (s: SkillPackageInfo) => {
    setBusy(s.name);
    const res = await setSkillEnabled(s.name, !s.enabled, (err) => notify(err.message));
    if (res) {
      notify(`${s.name} 已${s.enabled ? "禁用" : "启用"}`, "success");
      await load();
    }
    setBusy(null);
  };

  const handleUninstall = async (s: SkillPackageInfo) => {
    if (!window.confirm(`确认卸载技能 ${s.name}？`)) return;
    setBusy(s.name);
    const res = await uninstallSkill(s.name, (err) => notify(err.message));
    if (res) {
      notify(`${s.name} 已卸载`, "success");
      await load();
    }
    setBusy(null);
  };

  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <section className="skill-card skill-packages">
      <div className="skill-card__header">
        <div className="skill-card__icon">🧩</div>
        <div>
          <h2 className="skill-card__title">已安装技能包</h2>
          <p className="skill-card__desc">
            共 {skills.length} 个，启用 {enabledCount} 个。诊断时按相关性自动召回并注入指令。
          </p>
        </div>
      </div>
      <div className="skill-card__body">
        {loading ? (
          <div className="empty-hint">加载中...</div>
        ) : skills.length === 0 ? (
          <div className="empty-hint">暂无已安装技能包，可在下方安装。</div>
        ) : (
          <div className="skill-package-grid">
            {skills.map((s) => {
              const builtin = s.name.startsWith("sre-");
              return (
                <div key={s.name} className={`skill-package-card${s.enabled ? "" : " skill-package-card--disabled"}`}>
                  <div className="skill-package-card__header">
                    <span className="chip">{s.enabled ? "启用" : "禁用"}</span>
                    {builtin && <span className="chip chip--builtin">内置</span>}
                  </div>
                  <h3 className="skill-package-card__title">{s.name}</h3>
                  <p className="skill-package-card__desc">{s.description}</p>
                  <div className="skill-package-card__meta">
                    <span>references {s.references.length}</span>
                    <span>scripts {s.scripts.length}</span>
                    {s.version && <span>{s.version}</span>}
                  </div>
                  <div className="skill-package-card__actions">
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={s.enabled}
                        disabled={busy === s.name}
                        onChange={() => handleToggle(s)}
                      />
                      <span className="toggle__track" />
                      <span className="toggle__label">{s.enabled ? "启用" : "禁用"}</span>
                    </label>
                    {!builtin && (
                      <button
                        className="btn btn--sm btn--danger-ghost"
                        disabled={busy === s.name}
                        onClick={() => handleUninstall(s)}
                      >
                        卸载
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 追加样式到 app.css**

`web/src/styles/app.css` 末尾追加：

```css
/* Skill packages */
.skill-package-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.skill-package-card {
  border: 1px solid var(--border-color, rgba(120, 130, 160, 0.25));
  border-radius: 12px;
  padding: 16px;
  background: var(--surface-2, rgba(255, 255, 255, 0.03));
  transition: opacity 0.2s ease, border-color 0.2s ease;
}

.skill-package-card--disabled {
  opacity: 0.55;
}

.skill-package-card__header {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.skill-package-card__title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.skill-package-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary, rgba(220, 225, 235, 0.72));
}

.skill-package-card__meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-tertiary, rgba(220, 225, 235, 0.5));
  margin-bottom: 12px;
}

.skill-package-card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(52, 199, 123, 0.16);
  color: #34c77b;
}

.chip--builtin {
  background: rgba(120, 130, 255, 0.16);
  color: #7882ff;
}

.empty-hint {
  padding: 18px 0;
  text-align: center;
  color: var(--text-tertiary, rgba(220, 225, 235, 0.5));
  font-size: 13px;
}

/* Install form */
.install-form {
  display: grid;
  gap: 12px;
}

.install-form__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.curated-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.curated-chip {
  border: 1px solid var(--border-color, rgba(120, 130, 160, 0.25));
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  background: transparent;
  color: inherit;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.curated-chip:hover {
  border-color: #7882ff;
  background: rgba(120, 130, 255, 0.1);
}
```

说明：若 app.css 已有 `--border-color`/`--surface-2` 等变量则直接复用；没有则使用 `rgba` 兜底值，保持与现有深色主题一致。

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: `tsc -b` 与 vite build 均通过

- [ ] **Step 4: Commit**

```bash
cd web && git add src/components/SkillsPage.tsx src/styles/app.css
git commit -m "feat(ui): show installed skill packages with enable/uninstall controls"
```

---

### Task 3: 精选技能安装区

**Files:**
- Modify: `web/src/components/SkillsPage.tsx`

- [ ] **Step 1: 在 SkillPackagesSection 之后插入 InstallSkillSection**

并把 `SkillsPage` 的 return 中 `<DrawioFlowchartSkill notify={notify} />` 之前插入一行：

```tsx
        <InstallSkillSection notify={notify} />
```

同时在顶部 import 中补充：

```ts
  installSkill,
  listCuratedSkills,
  type CuratedSkill,
```

```tsx
function InstallSkillSection({ notify }: { notify: NotifyFn }) {
  const [curated, setCurated] = useState<CuratedSkill[]>([]);
  const [repo, setRepo] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    listCuratedSkills((err) => notify(err.message)).then((res) => {
      if (res) setCurated(res.skills);
    });
  }, []);

  const fill = (c: CuratedSkill) => {
    setRepo(c.repo);
    setSkillPath(c.path);
  };

  const handleInstall = async () => {
    if (!repo.trim() || !skillPath.trim()) {
      notify("请填写 repo 与 path");
      return;
    }
    setInstalling(true);
    const res = await installSkill(
      {
        repo: repo.trim(),
        path: skillPath.trim(),
        ref: ref.trim() || undefined,
        token: token.trim() || undefined,
      },
      (err) => notify(err.message)
    );
    if (res) {
      notify(`${res.name} 安装成功，下一轮诊断自动生效`, "success");
      setRepo("");
      setSkillPath("");
      setRef("");
      setToken("");
    }
    setInstalling(false);
  };

  return (
    <section className="skill-card">
      <div className="skill-card__header">
        <div className="skill-card__icon">⬇️</div>
        <div>
          <h2 className="skill-card__title">安装技能包</h2>
          <p className="skill-card__desc">从 GitHub 仓库安装开源 SKILL.md 技能（git sparse-checkout），安装后默认启用。</p>
        </div>
      </div>
      <div className="skill-card__body">
        {curated.length > 0 && (
          <div className="curated-list">
            {curated.map((c) => (
              <button key={`${c.repo}/${c.path}`} className="curated-chip" onClick={() => fill(c)} title={c.description}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="install-form">
          <div className="install-form__row">
            <input
              className="input"
              placeholder="repo，如 openai/skills"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
            <input
              className="input"
              placeholder="path，如 skills/.experimental/ceph-rbd-108"
              value={skillPath}
              onChange={(e) => setSkillPath(e.target.value)}
            />
          </div>
          <div className="install-form__row">
            <input className="input" placeholder="ref（可选，默认 main）" value={ref} onChange={(e) => setRef(e.target.value)} />
            <input className="input" placeholder="token（可选，私有仓库）" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div>
            <button className="btn btn--primary" onClick={handleInstall} disabled={installing}>
              {installing ? "安装中..." : "安装"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: 构建验证**

Run: `cd web && npm run build`
Expected: `tsc -b` 与 vite build 均通过

- [ ] **Step 3: Commit**

```bash
cd web && git add src/components/SkillsPage.tsx
git commit -m "feat(ui): add curated and manual skill install form"
```

---

### Task 4: 全量验证与冒烟

**Files:** 无代码改动

- [ ] **Step 1: 全量构建**

Run: `cd web && npm run build`
Expected: 通过

- [ ] **Step 2: 后端 + 前端冒烟（需无沙箱监听权限）**

后端（独立 data 目录，避免污染开发库）：
```bash
cd /root/InfraPilot/server && INFRAPILOT_DATA_DIR=/tmp/web-smoke-data node dist/index.js
```
Expected: `[InfraPilot Server] listening on :8787`（若 8787 被占用，改用 `PORT=8899`）

前端：
```bash
cd /root/InfraPilot/web && VITE_API_HOST=http://127.0.0.1:8899 npm run dev
```
Expected: vite 启动于 5173，页面可打开“技能中心”，能看到：
- 已安装技能包卡片（sre-systematic-debugging / ceph-rbd-108），启用开关可切换
- 精选技能 chip 与安装表单可填写提交
- 内置技能无“卸载”按钮

冒烟后清理：`rm -rf /tmp/web-smoke-data`

- [ ] **Step 3: 最终提交**

```bash
cd web && git status --short
git add -A
git commit -m "chore(ui): finalize skill center page"
```

---

## Self-Review

- **Spec coverage:** 已安装列表/启停/卸载（Task 2）、精选+手动安装（Task 3）、API 封装（Task 1）、样式（Task 2 内）、验证与冒烟（Task 4）全覆盖。
- **Placeholder scan:** 无 TBD/TODO；所有代码块完整。
- **Type consistency:** `SkillPackageInfo` / `CuratedSkill` / `installSkill(body)` 与后端 `routes/skills.ts` 返回结构一一对应（`{ skills: [...] }`、`{ ok, name }`、`{ ok }`）；组件名 `SkillPackagesSection` / `InstallSkillSection` 与 `SkillsPage` 内引用一致。
- **约定一致性:** 沿用 `notify` 回调、`request<T>`、`skill-card`/`toggle`/`btn` 现有样式体系；web 无测试框架，验证以 build + 冒烟为准并显式说明。

---

## 执行交接

计划已保存。执行时可选择：
1. **Subagent-Driven（推荐）** — 每个任务派发独立 subagent，任务间评审
2. **Inline Execution** — 本会话内按 checkpoint 分批执行
