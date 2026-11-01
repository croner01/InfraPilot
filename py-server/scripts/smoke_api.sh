#!/usr/bin/env bash
# Phase 1 契约冒烟：启动 py-server 并验证 HTTP 端点响应形状。
# 用法: py-server/scripts/smoke_api.sh [port]
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${1:-8790}"
export INFRAPILOT_DATA_DIR="${INFRAPILOT_DATA_DIR:-/tmp/infrapilot-py-smoke}"
export PORT
# MCP 端点鉴权默认放开；清掉可能从外部继承的 secret，保证冒烟可确定性通过
unset MCP_JWT_SECRET
rm -rf "$INFRAPILOT_DATA_DIR"

python3 -m infrapilot > /tmp/infrapilot-py-smoke.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

BASE="http://127.0.0.1:${PORT}"
fail=0
check() { # check <name> <expected-substring> <actual>
  if printf '%s' "$3" | grep -Fq -- "$2"; then
    echo "PASS  $1"
  else
    echo "FAIL  $1 -> $3"
    fail=1
  fi
}

check "health" '"ok":true' "$(curl -fsS "$BASE/health")"

SID=$(curl -fsS -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' -d '{"title":"smoke"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "session=$SID"

check "session-get" "\"id\":\"$SID\"" "$(curl -fsS "$BASE/api/sessions/$SID")"
check "session-get-status" '"status":"intake"' "$(curl -fsS "$BASE/api/sessions/$SID")"
check "sessions-list" "\"id\":\"$SID\"" "$(curl -fsS "$BASE/api/sessions")"
check "session-events" '"type":"session_created"' "$(curl -fsS "$BASE/api/sessions/$SID/events")"
check "session-audit-empty" '[]' "$(curl -fsS "$BASE/api/sessions/$SID/audit")"
check "alerts" '"alerts"' "$(curl -fsS "$BASE/api/alerts")"
check "title-patch" '"title":"renamed"' "$(curl -fsS -X PATCH "$BASE/api/sessions/$SID" -H 'Content-Type: application/json' -d '{"title":"renamed"}')"
check "session-delete" '"ok":true' "$(curl -fsS -X DELETE "$BASE/api/sessions/$SID")"


# ---- Phase 3/4/5：Skill/配置/数据源/技能包 契约 ----
check "config-log-systems" '"systems"' "$(curl -fsS "$BASE/api/config/log-systems")"
check "config-metric-empty" '"systems":[]' "$(curl -fsS "$BASE/api/config/metric-systems")"
check "config-metric-create" '"type":"prometheus"' "$(curl -fsS -X POST "$BASE/api/config/metric-systems" -H 'Content-Type: application/json' -d '{"id":"smoke-prom","name":"Smoke","url":"http://127.0.0.1:9090"}')"
check "config-metric-delete" '[]' "$(curl -fsS -X DELETE "$BASE/api/config/metric-systems/smoke-prom" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["systems"]))')"
check "config-memory-get" '"recallTopK":3' "$(curl -fsS "$BASE/api/config/memory")"
check "config-mcp-get" '"serverPort":8443' "$(curl -fsS "$BASE/api/config/mcp")"
check "config-mcp-secret" '"secret"' "$(curl -fsS -X POST "$BASE/api/config/mcp/generate-secret")"
check "config-llm-providers" '"deepseek"' "$(curl -fsS "$BASE/api/config/llm-providers")"
check "config-hosts-empty" '"hosts":[]' "$(curl -fsS "$BASE/api/config/hosts")"
check "config-error-envelope" '"error":"host not found"' "$(curl -sS -X DELETE "$BASE/api/config/hosts/missing")"

# sqlite 只读查询
SQLITE_FILE="$INFRAPILOT_DATA_DIR/smoke.sqlite"
python3 - "$SQLITE_FILE" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
conn.execute("INSERT INTO t (id, v) VALUES (1, 'a')")
conn.commit(); conn.close()
PY
check "config-db-create" '"type":"database"' "$(curl -fsS -X POST "$BASE/api/config/database-systems" -H 'Content-Type: application/json' -d "{\"id\":\"smoke-sqlite\",\"name\":\"Smoke\",\"dialect\":\"sqlite\",\"host\":\"$SQLITE_FILE\"}")"
check "datasource-db-query" '"columns":["id","v"]' "$(curl -fsS -X POST "$BASE/api/data-sources/db/smoke-sqlite/query" -H 'Content-Type: application/json' -d '{"sql":"SELECT * FROM t"}')"
check "datasource-db-readonly" '只读' "$(curl -sS -X POST "$BASE/api/data-sources/db/smoke-sqlite/query" -H 'Content-Type: application/json' -d '{"sql":"DROP TABLE t"}')"
check "datasource-db-test" '"reachable":true' "$(curl -fsS -X POST "$BASE/api/data-sources/db/smoke-sqlite/test")"

# 技能包 & drawio
check "skills-list" '"skills"' "$(curl -fsS "$BASE/api/skills")"
check "skills-curated" 'ceph-rbd-108' "$(curl -fsS "$BASE/api/skills/curated")"
DRAWIO=$(curl -fsS -X POST "$BASE/api/skills/drawio/generate" -H 'Content-Type: application/json' -d '{"log_relations":[{"source":"order-api","target":"redis","relation":"call"}],"title":"smoke"}')
check "drawio-generate" '"node_count":2' "$DRAWIO"
DRAWIO_PATH=$(printf '%s' "$DRAWIO" | python3 -c 'import sys,json;print(json.load(sys.stdin)["output_path"])')
DRAWIO_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$DRAWIO_PATH")
check "drawio-download" 'mxfile' "$(curl -fsS "$BASE/api/skills/drawio/download?path=$DRAWIO_ENC")"


# ---- P0/P1：用量统计 / 认证 / 告警接入 / Skill Factory / 拓扑 ----
check "config-model-prices" 'deepseek-v4-flash' "$(curl -fsS "$BASE/api/config/model-prices")"
check "usage-summary" '"totals"' "$(curl -fsS "$BASE/api/usage/summary?days=7")"

TOKEN=$(curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
check "auth-login-token" 'ok' "$([ -n "$TOKEN" ] && echo ok)"
check "auth-me" '"username":"admin"' "$(curl -fsS "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN")"
check "auth-users-admin" '"oncall-zhang"' "$(curl -fsS "$BASE/api/auth/users" -H "Authorization: Bearer $TOKEN")"
check "auth-bad-password" '401' "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"nope"}')"

WEBHOOK=$(curl -fsS -X POST "$BASE/api/webhooks/alertmanager" -H 'Content-Type: application/json' -d '{"alerts":[{"status":"firing","labels":{"alertname":"SmokeOOM","severity":"critical","service":"order-api"},"annotations":{"summary":"smoke 告警"},"startsAt":"2026-09-29T10:00:00Z","fingerprint":"smoke-fp-1"}]}')
check "webhook-alertmanager" '"severity":"p0"' "$WEBHOOK"
ALERT_ID=$(printf '%s' "$WEBHOOK" | python3 -c 'import sys,json;print(json.load(sys.stdin)["created"][0]["id"])')
check "alerts-patch" '"status":"acknowledged"' "$(curl -fsS -X PATCH "$BASE/api/alerts/$ALERT_ID" -H 'Content-Type: application/json' -d '{"status":"acknowledged"}')"

check "skills-factory-sessions" '"sessions"' "$(curl -fsS "$BASE/api/skills/factory/sessions")"
check "skills-factory-pending" '"drafts"' "$(curl -fsS "$BASE/api/skills/factory/pending")"
check "topology-responds" 'nodes' "$(curl -fsS "$BASE/api/topology?limit=5" || echo '{"nodes":[]}')"

# ---- P2：ES8 兼容 / Trace 数据源 / 定时任务 / MCP Server ----
check "config-trace-systems" '"systems"' "$(curl -fsS "$BASE/api/config/trace-systems")"
check "config-log-es8-create" '"type":"es8"' "$(curl -fsS -X POST "$BASE/api/config/log-systems" -H 'Content-Type: application/json' -d '{"id":"smoke-es8","name":"Smoke ES8","type":"es8","enabled":true,"node":"https://es8.local:9200","skipTlsVerify":true,"targets":[]}')"
check "config-log-es8-delete" '"ok":true' "$(curl -fsS -X DELETE "$BASE/api/config/log-systems/smoke-es8")"

check "schedules-validate" '"nextRun"' "$(curl -fsS -X POST "$BASE/api/schedules/validate" -H 'Content-Type: application/json' -d '{"cron":"@every 10m"}')"
SCHED_ID=$(curl -fsS -X POST "$BASE/api/schedules" -H 'Content-Type: application/json' -d '{"name":"smoke-cron","cron":"@every 10m","prompt":"巡检节点"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["schedule"]["id"])')
check "schedules-list" "$SCHED_ID" "$(curl -fsS "$BASE/api/schedules")"
check "schedules-status" '"running":true' "$(curl -fsS "$BASE/api/schedules/status")"
check "schedules-run" '"sessionId"' "$(curl -fsS -X POST "$BASE/api/schedules/$SCHED_ID/run")"
check "schedules-delete" '"ok":true' "$(curl -fsS -X DELETE "$BASE/api/schedules/$SCHED_ID")"

check "mcp-info" '"protocolVersion"' "$(curl -fsS "$BASE/api/mcp")"
check "mcp-initialize" '"name":"infrapilot"' "$(curl -fsS -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}')"
check "mcp-tools-list" 'k8s__describe_pod' "$(curl -fsS -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
check "mcp-call-readonly" '"isError":false' "$(curl -fsS -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"drawio__generate_flowchart","arguments":{"log_relations":[{"source":"a","target":"b","relation":"call"}],"output_path":"smoke-mcp.drawio"}}}')"
check "mcp-call-write-blocked" '"isError":true' "$(curl -fsS -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"k8s__patch_resource_limits","arguments":{}}}')"

# 结构化输出 / 上下文压缩 / LLM-as-judge（§3 #12/#13/#14）
check "eval-cases-seeded" 'kafka-evicted-oom' "$(curl -fsS "$BASE/api/eval/cases")"
EVAL_SID=$(curl -fsS -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' -d '{"title":"eval-smoke"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
check "eval-judge-offline" '"mode":"heuristic"' "$(curl -fsS -X POST "$BASE/api/eval/judge" -H 'Content-Type: application/json' -d "{\"sessionId\":\"$EVAL_SID\",\"allowLlm\":false}")"
check "eval-judge-error-envelope" '"error"' "$(curl -sS -X POST "$BASE/api/eval/judge" -H 'Content-Type: application/json' -d '{}')"
check "eval-runs" '"runs"' "$(curl -fsS "$BASE/api/eval/runs")"

# P3：会话产物（Artifact）
ART_DIR="$INFRAPILOT_DATA_DIR/artifacts"
mkdir -p "$ART_DIR"
printf 'artifact-smoke-body' > "$ART_DIR/smoke-artifact.txt"
ARTIFACT=$(curl -fsS -X POST "$BASE/api/artifacts" -H 'Content-Type: application/json' -d "{\"sessionId\":\"$EVAL_SID\",\"path\":\"$ART_DIR/smoke-artifact.txt\",\"kind\":\"smoke\"}")
check "artifacts-register" '"kind":"smoke"' "$ARTIFACT"
ART_ID=$(printf '%s' "$ARTIFACT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["artifact"]["id"])' 2>/dev/null || echo "")
check "artifacts-session-list" "$ART_ID" "$(curl -fsS "$BASE/api/sessions/$EVAL_SID/artifacts")"
check "artifacts-download" 'artifact-smoke-body' "$(curl -fsS "$BASE/api/artifacts/$ART_ID/download")"
check "artifacts-bad-path" '"error"' "$(curl -sS -X POST "$BASE/api/artifacts" -H 'Content-Type: application/json' -d '{"path":"/etc/passwd"}')"
check "artifacts-delete" '"ok":true' "$(curl -fsS -X DELETE "$BASE/api/artifacts/$ART_ID")"

# P3：A2A 协议 + CLI
check "a2a-agent-card" '"name":"InfraPilot"' "$(curl -fsS "$BASE/.well-known/agent.json")"
check "a2a-agent-card-streaming" '"streaming":true' "$(curl -fsS "$BASE/.well-known/agent.json")"
check "a2a-info" '"protocolVersion"' "$(curl -fsS "$BASE/api/a2a")"
check "a2a-ping" '"result":{}' "$(curl -fsS -X POST "$BASE/api/a2a" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')"
A2A_TASK=$(curl -fsS -X POST "$BASE/api/a2a" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"message/send","params":{"message":{"role":"user","messageId":"smoke","parts":[{"kind":"text","text":"磁盘告警排查"}]}}}')
check "a2a-message-send" '"kind":"task"' "$A2A_TASK"
A2A_ID=$(printf '%s' "$A2A_TASK" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["id"])' 2>/dev/null || echo "")
check "a2a-task-get" "$A2A_ID" "$(curl -fsS -X POST "$BASE/api/a2a" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tasks/get\",\"params\":{\"id\":\"$A2A_ID\"}}")"
check "a2a-task-cancel" '"state":"canceled"' "$(curl -fsS -X POST "$BASE/api/a2a" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tasks/cancel\",\"params\":{\"id\":\"$A2A_ID\"}}")"
# message/stream：SSE 首帧为完整 Task 快照；读到首帧即断开，避免等待真实轮次
A2A_STREAM=$(curl -fs -N --max-time 10 -X POST "$BASE/api/a2a" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":5,"method":"message/stream","params":{"message":{"role":"user","messageId":"smoke-stream","parts":[{"kind":"text","text":"磁盘告警流式排查"}]}}}' | head -c 900)
check "a2a-message-stream" '"kind": "task"' "$A2A_STREAM"
# tasks/resubscribe：对无活跃轮次的会话回放后立即收尾（确定性，无真实轮次等待）
A2A_RSID=$(curl -fsS -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' -d '{"title":"a2a-resub"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
A2A_SUB=$(curl -fsS -N --max-time 10 -X POST "$BASE/api/a2a" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tasks/resubscribe\",\"params\":{\"id\":\"$A2A_RSID\"}}")
check "a2a-tasks-resubscribe" '"final": true' "$A2A_SUB"

check "cli-sessions" '"id"' "$(python3 -m infrapilot.cli --base "$BASE" --json sessions)"
check "cli-show" "$EVAL_SID" "$(python3 -m infrapilot.cli --base "$BASE" --json show "$EVAL_SID")"
check "cli-judge-offline" '"mode": "heuristic"' "$(python3 -m infrapilot.cli --base "$BASE" --json judge "$EVAL_SID" --offline)"
check "eval-session-delete" '"ok":true' "$(curl -fsS -X DELETE "$BASE/api/sessions/$EVAL_SID")"

# K8s / ELK：真实数据源，无集群/无 OpenSearch 时容忍失败但不崩溃
check "k8s-pods-responds" '"pods"' "$(curl -fsS "$BASE/api/k8s/pods?abnormalOnly=true" || echo '{"pods":[] }')"
check "elk-search-responds" 'ok' "$(curl -fsS -X POST "$BASE/api/elk/search" -H 'Content-Type: application/json' -d '{"limit":1}' || echo '{"ok":false}')"

# WebSocket 契约：连接后能收到该会话的实时时间线事件
python3 - "$PORT" <<'PY' || fail=1
import asyncio, json, sys, urllib.request
import websockets

port = sys.argv[1]

async def main():
    def post(path, payload):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        return json.loads(urllib.request.urlopen(req).read())

    sid = post("/api/sessions", {"title": "ws-smoke"})["id"]
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws?sessionId={sid}") as ws:
        await asyncio.to_thread(post, f"/api/sessions/{sid}/messages", {"message": "hello"})
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert msg["sessionId"] == sid, msg
        assert msg["type"] == "user_message", msg
        print("PASS  websocket-event-delivery")

asyncio.run(main())
PY

if [ "$fail" -ne 0 ]; then
  echo "--- server log ---"; cat /tmp/infrapilot-py-smoke.log
  exit 1
fi
echo "ALL PASS"
