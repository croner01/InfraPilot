# Repository Guidelines

InfraPilot is an AI SRE agent for Kubernetes / Linux / OpenStack / log analytics. It autonomously diagnoses incidents, proposes root-cause conclusions, and executes approved remediation through a policy-gated command gateway.

## Project Structure & Module Organization

- `server/src/` — Node.js/TypeScript backend.
  - `agent/` — orchestration loop, sessions, checkpoints, memory.
  - `skills/` — one directory per skill (`linux`, `k8s`, `elk`, `clickhouse`, `openstack`, `knowledge`, `drawio`; `trace`/`topology` are placeholders).
  - `gateway/` — policy engine, command gateway (the only tool execution entry point), redaction.
  - `mcp/` — gRPC MCP client and standalone linux-mcp-server.
  - `routes/`, `db/`, `demo/`, `k8s-manifests/` — HTTP API, SQLite, demo workload, K8s manifests.
- `web/src/` — React 19 + Vite frontend (`components/`, `lib/`).
- `docs/` — design documents; `.trae/documents/` — incremental implementation plans.
- Tests are colocated as `*.test.ts` (e2e: `*.e2e.test.ts`).

## Build, Test, and Development Commands

```bash
# backend (port 8787)
cd server && npm install && npm run dev
npm run build      # tsc -> dist/
npm test           # vitest run
npm run seed       # seed knowledge cases

# frontend (port 5173, proxies /api and /ws)
cd web && npm install && npm run dev
npm run build      # tsc -b && vite build
```

Local dev needs a k3s kubeconfig, OpenSearch on `127.0.0.1:9200`, and `GSK_API_KEY` or `OPENAI_API_KEY`.

## Coding Style & Naming Conventions

- TypeScript with `strict: true`; 2-space indentation, single quotes, semicolons, trailing commas.
- Skill tools are named `{skill}__{tool}` (e.g., `k8s__describe_pod`); every `ToolDef` declares a `risk` level.
- Source files use `camelCase.ts`; React components use `PascalCase.tsx`.
- No lint/format config is committed; match surrounding code and pass `tsc`.

## Testing Guidelines

- Vitest with globals enabled; tests are colocated (`*.test.ts`) and run via `cd server && npm test`.
- `*.e2e.test.ts` files are excluded by default and skipped.
- Add unit tests for new tools, policy rules, and gateway logic; verify before committing.

## Commit & Pull Request Guidelines

- Use Conventional Commits: `feat(scope): summary`, `docs(infra): ...`, `fix: ...` (Chinese or English summaries).
- PRs: describe the change, reference the relevant plan in `.trae/documents/` or `docs/`, report test results, and include screenshots for UI changes.

## Architecture Overview

A single orchestrator runs an OpenAI function-calling loop with persisted checkpoints. Read-only tools auto-execute; `medium`+ risk tools require approval and run only through the Command Gateway, which validates approval hashes and writes audit logs. Data sources are real: k3s, OpenSearch/ClickHouse, and host commands.
