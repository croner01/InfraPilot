# Repository Guidelines

InfraPilot is an AI SRE agent for Kubernetes / Linux / ELK-log analytics: it diagnoses incidents autonomously and executes approved remediation only through a policy-gated command gateway.

## Single backend: py-server (Python/FastAPI)

- `py-server/` — the **only** backend (port 8787). The original Node implementation (`server/`) has been removed; its unique capabilities were ported:
  - `infrapilot/log_shipper.py` — real Pod CRI log ingestion pipeline → OpenSearch/ES8 (replaces Node `logShipper.ts`), exposed via `/api/config/log-systems/:id/ship-status`.
  - `infrapilot/mcp_client.py` — MCP client channel (JSON-RPC over HTTP), replaces the Node gRPC `linux-mcp-server` path. Remote hosts with `auth.type=="mcp"` in the Host Registry (or `MCP_ENDPOINTS` env) route `linux__*` tools to a per-node agent (`MCP_SERVER_MODE=http python3 -m infrapilot.mcp_server`); SSH hosts still use `infrapilot/remote.py`.
- Skill *packages* (SKILL.md knowledge packs) live in `py-server/skills/` (moved from the old `server/skills/`); default dir resolves via `INFRAPILOT_SKILLS_DIR`, override allowed.
- Docker build context is now **`py-server/` itself**: `docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest py-server`.
- Historical note: many modules carry docstrings "对应 `server/src/...`" — these are origin references to the removed Node code, kept for traceability. Do not treat them as live instructions.

## Commands

```bash
# Backend (from py-server/)
pip3 install -r requirements.txt
python3 -m infrapilot              # port 8787
python3 -m pytest tests -q        # offline tests
./scripts/smoke_api.sh 8791       # HTTP/WS contract smoke; needs real sockets (no sandbox)
python3 -m infrapilot.eval_run http://localhost:8787   # real-LLM eval (costs tokens)
bash scripts/cutover_check.sh 8787 5173    # server on 8787 + Vite proxy end-to-end

# Backend as a remote MCP agent (per node) or stdio MCP server
MCP_SERVER_MODE=http MCP_SERVER_PORT=8443 python3 -m infrapilot.mcp_server
MCP_SERVER_MODE=stdio python3 -m infrapilot.mcp_server

# Frontend (from web/)
npm run dev           # port 5173
npm run build         # tsc -b && vite build
npm test              # vitest, jsdom
npm run e2e           # Playwright; expects a running backend with seeded demo alerts; UI copy is Chinese
```

Root has no `package.json` (only an empty lockfile) — run npm commands inside `web/`.

## Skill/tool registration and the gateway

- All tool execution goes through the Command Gateway. Agent code must never call skill execute functions directly; `medium`+ risk tools require recorded approval (argsHash anti-tamper + full audit log), readonly/low auto-execute.
- Adding a tool: `TOOLS: list[ToolDef]` + `async def execute(tool, args)` in `py-server/infrapilot/skills/<name>.py`, registered in `infrapilot/skills/__init__.py` `_MODULES` (key = skill name). Policy engine/gateway pick up risk automatically. Naming: `{skill}__{tool}`.
- New tool outputs must follow `docs/tool-output-guidelines.md` hard rules: summary counters first, truncate large lists with `truncated:true`, never merge distinct failure states (Evicted/OOMKilled/… ) into one status, never return an empty success for "nothing found" — emit `note`/`error`.

## Environment gotchas

- LLM: `GSK_API_KEY` or `OPENAI_API_KEY`; models via `REASONING_MODEL`/`FAST_MODEL`, but beware `py-server/infrapilot/config_store.py` runtime-config overriding those env vars at startup.
- Log shipper reads targets from runtime-config logSystems (synced to `LOG_SHIP_TARGETS`/`OPENSEARCH_NODE` by `config_store.sync_elk_env`) and CRI logs from `PODS_LOG_ROOT` (default `/var/log/pods`); `INFRAPILOT_LOG_SHIPPER=0` disables it (per-node MCP agents run with it off).
- Real infra needed for full runs: k3s kubeconfig, OpenSearch on `127.0.0.1:9200`. K8s manifests (single-backend, Python image) live in `py-server/k8s-manifests/` — server deployment mounts host `/var/log/pods` read-only for the shipper; `mcp-agent/` replaces the old gRPC manifests.
- `web/` proxies `/api` and `/ws` to 8787 with no config changes.

## Conventions

- Python backend: keep FastAPI route error bodies as `{"error": ...}` (legacy contract with the web client); match surrounding style; run `pytest`/`compileall`.
- Text (docs, UI copy, most comments) is largely Chinese; commits use Conventional Commits with scopes seen in history (`agent`, `k8s-skill`, `web`, `docs(infra)`).
- Incremental implementation plans live in `docs/superpowers/plans/` (not `.trae/documents/`); full design docs in `docs/`.
