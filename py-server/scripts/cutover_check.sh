#!/usr/bin/env bash
# Phase 6 端口切换验证：py-server 直接监听前端约定的 8787，并经由 Vite dev 代理验证 /api + /ws。
# 覆盖前端已对接的 Python 新增接口（usage / topology / auth / skill factory / alerts PATCH）。
# 用法: py-server/scripts/cutover_check.sh [backend-port] [web-port]
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8787}"
WEB_PORT="${2:-5173}"
export PORT
export INFRAPILOT_DATA_DIR="${INFRAPILOT_DATA_DIR:-/tmp/infrapilot-cutover}"
rm -rf "$INFRAPILOT_DATA_DIR"

python3 -m infrapilot > /tmp/cutover-py.log 2>&1 &
PY_PID=$!
( cd ../web && npm run dev -- --port "$WEB_PORT" --strictPort > /tmp/cutover-web.log 2>&1 ) &
WEB_PID=$!
trap 'kill "$PY_PID" "$WEB_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

BASE="http://127.0.0.1:${WEB_PORT}"
fail=0
check() { # check <name> <expected-substring> <actual>
  if printf '%s' "$3" | grep -Fq -- "$2"; then echo "PASS  $1"; else echo "FAIL  $1 -> $3"; fail=1; fi
}

check "backend-on-8787" '"ok":true' "$(curl -fsS "http://127.0.0.1:${PORT}/health")"
check "vite-serves-frontend" 'id="root"' "$(curl -fsS "$BASE/")"

SID=$(curl -fsS -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' -d '{"title":"cutover"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
check "proxy-api-create-session" "$SID" "$(curl -fsS "http://127.0.0.1:${PORT}/api/sessions/${SID}")"
check "proxy-api-list-sessions" "$SID" "$(curl -fsS "$BASE/api/sessions")"
check "proxy-api-error-envelope" '"error"' "$(curl -sS "$BASE/api/sessions/__missing__")"
check "proxy-api-config" '"systems"' "$(curl -fsS "$BASE/api/config/log-systems")"
check "proxy-api-usage" '"totals"' "$(curl -fsS "$BASE/api/usage/summary?days=1")"
check "proxy-api-mcp" '"protocolVersion"' "$(curl -fsS "$BASE/api/mcp")"

# 前端页面已对接的 Python 新增接口
AUTH_JSON=$(curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}')
check "proxy-api-auth-login" '"role":"admin"' "$AUTH_JSON"
TOKEN=$(printf '%s' "$AUTH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || echo "")
check "proxy-api-auth-users" '"users"' "$(curl -fsS "$BASE/api/auth/users" -H "Authorization: Bearer $TOKEN")"
check "proxy-api-topology" '"nodes"' "$(curl -fsS "$BASE/api/topology")"
check "proxy-api-factory-sessions" '"sessions"' "$(curl -fsS "$BASE/api/skills/factory/sessions")"

# 告警 PATCH 返回 camelCase（对齐前端 Alert 类型）
ALERT_ID=$(curl -fsS -X POST "$BASE/api/webhooks/alertmanager" -H 'Content-Type: application/json' \
  -d '{"alerts":[{"status":"firing","labels":{"alertname":"CutoverCheck","severity":"warning","service":"cutover"},"annotations":{"summary":"cutover 告警"},"fingerprint":"cutover-fp"}]}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("created") or [{}])[0].get("id",""))' 2>/dev/null || echo "")
check "proxy-api-alert-patch" '"resolvedAt"' "$(curl -fsS -X PATCH "$BASE/api/alerts/$ALERT_ID" -H 'Content-Type: application/json' -d '{"status":"resolved"}')"

# P2/P3 新增能力（前端设置页/会话详情已对接）
check "proxy-api-trace-systems" '"systems"' "$(curl -fsS "$BASE/api/config/trace-systems")"
check "proxy-api-schedules-list" '"schedules"' "$(curl -fsS "$BASE/api/schedules")"
check "proxy-api-schedules-status" '"running"' "$(curl -fsS "$BASE/api/schedules/status")"
check "proxy-api-eval-cases" '"cases"' "$(curl -fsS "$BASE/api/eval/cases")"
check "proxy-api-eval-runs" '"runs"' "$(curl -fsS "$BASE/api/eval/runs?limit=5")"
check "proxy-api-session-artifacts" '"artifacts"' "$(curl -fsS "$BASE/api/sessions/${SID}/artifacts")"
check "proxy-api-session-usage" '"totalTokens"' "$(curl -fsS "$BASE/api/usage/sessions/${SID}")"
check "proxy-api-usage-calls" '"calls"' "$(curl -fsS "$BASE/api/usage/calls?limit=5")"
check "proxy-api-session-allowlist" '"allowlist"' "$(curl -fsS "$BASE/api/sessions/${SID}/allowlist")"
check "proxy-api-allowlist-add" '"run_python"' "$(curl -fsS -X POST "$BASE/api/sessions/${SID}/allowlist" -H 'Content-Type: application/json' -d '{"skill":"interpreter","tool":"run_python"}')"

KCASE_ID=$(curl -fsS -X POST "$BASE/api/knowledge/cases" -H 'Content-Type: application/json' \
  -d '{"title":"CutoverCase","summary":"cutover 知识库详情","problemType":"general","rootCauses":["cutover-root"]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("case",{}).get("id",""))' 2>/dev/null || echo "")
check "proxy-api-knowledge-case-detail" 'CutoverCase' "$(curl -fsS "$BASE/api/knowledge/cases/${KCASE_ID}")"

# WebSocket：经前端代理订阅会话时间线
python3 - "$WEB_PORT" "$SID" <<'PY' || fail=1
import asyncio, json, sys, urllib.request
import websockets

web_port, sid = sys.argv[1], sys.argv[2]

async def main():
    def post(path, payload):
        req = urllib.request.Request(
            f"http://127.0.0.1:{web_port}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        return json.loads(urllib.request.urlopen(req).read())

    async with websockets.connect(f"ws://127.0.0.1:{web_port}/ws?sessionId={sid}") as ws:
        await asyncio.to_thread(post, f"/api/sessions/{sid}/messages", {"message": "hello-cutover"})
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        assert msg["type"] == "user_message", msg
        assert msg["sessionId"] == sid, msg
        print("PASS  proxy-ws-delivery")

asyncio.run(main())
PY

curl -fsS -X DELETE "$BASE/api/sessions/${SID}" >/dev/null 2>&1 || true
if [ "$fail" -ne 0 ]; then
  echo "--- py log ---"; tail -20 /tmp/cutover-py.log
  echo "--- vite log ---"; tail -20 /tmp/cutover-web.log
  exit 1
fi
echo "ALL PASS"
