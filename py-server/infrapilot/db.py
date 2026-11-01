"""SQLite 持久层 — 与 `server/src/db/db.ts` 表结构与语义一一对应。

Node 版使用 better-sqlite3（同步 API），这里用标准库 sqlite3 复刻同样的调用风格。
FastAPI 的同步路由在线程池中执行，因此连接使用 check_same_thread=False 并以
可重入锁保护写操作。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Iterable, Optional

from .settings import DB_PATH

_lock = threading.RLock()

conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA journal_mode = WAL")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  caller_agent TEXT NOT NULL,
  skill TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_id TEXT,
  approved_by TEXT,
  success INTEGER NOT NULL,
  result_summary TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  diff_preview TEXT,
  decision TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS incident_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  root_cause_summary TEXT NOT NULL,
  root_cause_category TEXT,
  resolution_steps TEXT,
  created_at TEXT NOT NULL,
  problem_type TEXT,
  severity TEXT,
  solutions TEXT,
  tags TEXT,
  source_session_id TEXT,
  embedding TEXT
);

CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  dir TEXT NOT NULL,
  source TEXT,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT NOT NULL,
  checksum TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  service TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  session_id TEXT,
  source_type TEXT,
  fingerprint TEXT,
  labels TEXT,
  annotations TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  ack_at TEXT,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  provider_id TEXT,
  model TEXT NOT NULL,
  call_type TEXT NOT NULL DEFAULT 'agent',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  skills TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_session_id TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  case_json TEXT NOT NULL,
  source_session_id TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  session_id TEXT,
  passed INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_allowlist (
  session_id TEXT NOT NULL,
  skill TEXT NOT NULL,
  tool TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (session_id, skill, tool)
);
"""


def _columns(table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_column_if_missing(table: str, column: str, definition: str) -> None:
    if column not in _columns(table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    with _lock:
        conn.executescript(SCHEMA)
        # 与 Node 版保持相同的向后兼容迁移
        for col, ddl in [
            ("problem_type", "TEXT"),
            ("severity", "TEXT"),
            ("solutions", "TEXT"),
            ("tags", "TEXT"),
            ("source_session_id", "TEXT"),
            ("embedding", "TEXT"),
        ]:
            _add_column_if_missing("incident_cases", col, ddl)
        if "args_hash" not in _columns("approvals"):
            conn.execute("ALTER TABLE approvals ADD COLUMN args_hash TEXT NOT NULL DEFAULT ''")
        for col, ddl in [("tags", "TEXT"), ("embedding", "TEXT")]:
            _add_column_if_missing("session_memories", col, ddl)
        # P0 认证与多租户：user_id 贯穿三张核心表（Node 版尚未落地，Python 版先行）
        _add_column_if_missing("sessions", "user_id", "TEXT")
        _add_column_if_missing("audit_log", "user_id", "TEXT")
        _add_column_if_missing("approvals", "user_id", "TEXT")
        for col, ddl in [
            ("source_type", "TEXT"),
            ("fingerprint", "TEXT"),
            ("labels", "TEXT"),
            ("annotations", "TEXT"),
            ("count", "INTEGER NOT NULL DEFAULT 1"),
            ("ack_at", "TEXT"),
            ("resolved_at", "TEXT"),
        ]:
            _add_column_if_missing("alerts", col, ddl)
        conn.commit()


def execute(sql: str, params: Iterable[Any] = ()) -> None:
    with _lock:
        conn.execute(sql, tuple(params))
        conn.commit()


def query_all(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    with _lock:
        return list(conn.execute(sql, tuple(params)).fetchall())


def query_one(sql: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Row]:
    with _lock:
        return conn.execute(sql, tuple(params)).fetchone()


# -------------------- sessions --------------------


def upsert_session(
    session_id: str, title: str, status: str, state_json: str, user_id: Optional[str] = None
) -> None:
    from .util import now_iso

    now = now_iso()
    with _lock:
        existing = query_one("SELECT id FROM sessions WHERE id = ?", (session_id,))
        if existing:
            execute(
                "UPDATE sessions SET title=?, status=?, state_json=?, updated_at=?, user_id=COALESCE(?, user_id) WHERE id=?",
                (title, status, state_json, now, user_id, session_id),
            )
        else:
            execute(
                "INSERT INTO sessions (id, title, status, state_json, created_at, updated_at, user_id)"
                " VALUES (?,?,?,?,?,?,?)",
                (session_id, title, status, state_json, now, now, user_id),
            )


def get_session_row(session_id: str) -> Optional[sqlite3.Row]:
    return query_one("SELECT state_json FROM sessions WHERE id = ?", (session_id,))


def list_sessions() -> list[dict[str, Any]]:
    rows = query_all(
        "SELECT id, title, status, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50"
    )
    return [dict(r) for r in rows]


def list_awaiting_approval_sessions() -> list[dict[str, Any]]:
    rows = query_all(
        "SELECT id, title, status, created_at, updated_at FROM sessions "
        "WHERE status = 'awaiting_approval' ORDER BY updated_at DESC"
    )
    return [dict(r) for r in rows]


def delete_session(session_id: str) -> bool:
    with _lock:
        if not query_one("SELECT id FROM sessions WHERE id = ?", (session_id,)):
            return False
        for table in (
            "sessions",
            "timeline_events",
            "session_checkpoints",
            "approvals",
            "audit_log",
            "session_memories",
        ):
            execute(f"DELETE FROM {table} WHERE {'id' if table == 'sessions' else 'session_id'} = ?", (session_id,))
    return True


# -------------------- timeline_events --------------------


def insert_timeline_event(row: dict[str, Any]) -> None:
    execute(
        "INSERT INTO timeline_events (id, session_id, type, payload, timestamp) VALUES (?,?,?,?,?)",
        (row["id"], row["session_id"], row["type"], row["payload"], row["timestamp"]),
    )


def list_timeline_events(session_id: str) -> list[dict[str, Any]]:
    rows = query_all(
        "SELECT * FROM timeline_events WHERE session_id = ? ORDER BY timestamp ASC", (session_id,)
    )
    return [dict(r) for r in rows]


# -------------------- audit_log --------------------


def insert_audit(row: dict[str, Any]) -> None:
    execute(
        """INSERT INTO audit_log
           (id, session_id, caller_agent, skill, tool, args, risk_level, approval_id, approved_by,
            success, result_summary, started_at, finished_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            row["id"],
            row["sessionId"],
            row["callerAgent"],
            row["skill"],
            row["tool"],
            row["args"],
            row["riskLevel"],
            row.get("approvalId"),
            row.get("approvedBy"),
            1 if row["success"] else 0,
            row.get("resultSummary"),
            row["startedAt"],
            row["finishedAt"],
        ),
    )


def list_audit_by_session(session_id: str) -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM audit_log WHERE session_id = ? ORDER BY started_at ASC", (session_id,))
    return [dict(r) for r in rows]


# -------------------- approvals --------------------


def insert_approval(row: dict[str, Any]) -> None:
    from .util import now_iso

    execute(
        """INSERT INTO approvals
           (id, session_id, skill, tool, args, args_hash, risk_level, diff_preview, decision, requested_at)
           VALUES (?,?,?,?,?,?,?,?, 'pending', ?)""",
        (
            row["id"],
            row["sessionId"],
            row["skill"],
            row["tool"],
            row["args"],
            row["argsHash"],
            row["riskLevel"],
            row.get("diffPreview") or "",
            now_iso(),
        ),
    )


def decide_approval(approval_id: str, decision: str, decided_by: str) -> None:
    from .util import now_iso

    execute(
        "UPDATE approvals SET decision=?, decided_at=?, decided_by=? WHERE id=?",
        (decision, now_iso(), decided_by, approval_id),
    )


def get_approval(approval_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
    return dict(row) if row else None


# -------------------- session_allowlist（会话级免审批白名单） --------------------


def upsert_allowlist(session_id: str, skill: str, tool: str, created_by: Optional[str] = None) -> None:
    from .util import now_iso

    execute(
        "INSERT OR REPLACE INTO session_allowlist (session_id, skill, tool, created_at, created_by) VALUES (?,?,?,?,?)",
        (session_id, skill, tool, now_iso(), created_by),
    )


def list_allowlist(session_id: str) -> list[dict[str, Any]]:
    rows = query_all(
        "SELECT skill, tool, created_at, created_by FROM session_allowlist WHERE session_id = ? ORDER BY created_at ASC",
        (session_id,),
    )
    return [
        {"skill": r["skill"], "tool": r["tool"], "createdAt": r["created_at"], "createdBy": r["created_by"]}
        for r in rows
    ]


def delete_allowlist(session_id: str, skill: str, tool: str) -> bool:
    with _lock:
        cur = conn.execute(
            "DELETE FROM session_allowlist WHERE session_id = ? AND skill = ? AND tool = ?",
            (session_id, skill, tool),
        )
        conn.commit()
        return cur.rowcount > 0


def is_allowlisted(session_id: str, skill: str, tool: str) -> bool:
    row = query_one(
        "SELECT 1 FROM session_allowlist WHERE session_id = ? AND skill = ? AND tool = ?",
        (session_id, skill, tool),
    )
    return row is not None


# -------------------- session_checkpoints --------------------


def save_checkpoint_db(session_id: str, checkpoint_json: str) -> None:
    from .util import now_iso

    execute(
        """INSERT INTO session_checkpoints (session_id, checkpoint_json, updated_at)
           VALUES (?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json,
                                                 updated_at=excluded.updated_at""",
        (session_id, checkpoint_json, now_iso()),
    )


def load_checkpoint_db(session_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT checkpoint_json FROM session_checkpoints WHERE session_id = ?", (session_id,))
    return dict(row) if row else None


def delete_checkpoint_db(session_id: str) -> None:
    execute("DELETE FROM session_checkpoints WHERE session_id = ?", (session_id,))


# -------------------- incident_cases --------------------


def insert_case(row: dict[str, Any]) -> None:
    execute(
        """INSERT INTO incident_cases
           (id, title, root_cause_summary, root_cause_category, resolution_steps, created_at,
            problem_type, severity, solutions, tags, source_session_id, embedding)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            row["id"],
            row["title"],
            row["root_cause_summary"],
            row.get("root_cause_category"),
            row.get("resolution_steps"),
            row["created_at"],
            row.get("problem_type"),
            row.get("severity"),
            row.get("solutions"),
            row.get("tags"),
            row.get("source_session_id"),
            row.get("embedding"),
        ),
    )


def get_case(case_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM incident_cases WHERE id = ?", (case_id,))
    return dict(row) if row else None


def list_cases() -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM incident_cases ORDER BY created_at DESC LIMIT 200")
    return [dict(r) for r in rows]


def get_case_by_source_session(session_id: str) -> Optional[dict[str, Any]]:
    """同一会话的自动沉淀案例只应存在一条：用于 upsert 而不是每次追加。"""
    row = query_one(
        "SELECT * FROM incident_cases WHERE source_session_id = ? ORDER BY created_at LIMIT 1", (session_id,)
    )
    return dict(row) if row else None


def update_case(row: dict[str, Any]) -> None:
    execute(
        """UPDATE incident_cases SET
             title = ?, root_cause_summary = ?, root_cause_category = ?, resolution_steps = ?,
             problem_type = ?, severity = ?, solutions = ?, tags = ?, embedding = ?
           WHERE id = ?""",
        (
            row["title"],
            row["root_cause_summary"],
            row.get("root_cause_category"),
            row.get("resolution_steps"),
            row.get("problem_type"),
            row.get("severity"),
            row.get("solutions"),
            row.get("tags"),
            row.get("embedding"),
            row["id"],
        ),
    )


def delete_case(case_id: str) -> bool:
    with _lock:
        cur = conn.execute("DELETE FROM incident_cases WHERE id = ?", (case_id,))
        conn.commit()
        return cur.rowcount > 0


# -------------------- session_memories --------------------


def upsert_memory(row: dict[str, Any]) -> None:
    execute(
        """INSERT INTO session_memories (id, session_id, title, summary, tags, created_at, updated_at, embedding)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET
             title=excluded.title, summary=excluded.summary, tags=excluded.tags,
             updated_at=excluded.updated_at, embedding=excluded.embedding""",
        (
            row["id"],
            row["session_id"],
            row["title"],
            row["summary"],
            row.get("tags"),
            row["created_at"],
            row["updated_at"],
            row.get("embedding"),
        ),
    )


def get_memory(memory_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM session_memories WHERE id = ?", (memory_id,))
    return dict(row) if row else None


def get_memory_by_session(session_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM session_memories WHERE session_id = ?", (session_id,))
    return dict(row) if row else None


def list_memories() -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM session_memories ORDER BY updated_at DESC")
    return [dict(r) for r in rows]


def delete_memory(memory_id: str) -> None:
    execute("DELETE FROM session_memories WHERE id = ?", (memory_id,))


# -------------------- skills --------------------


def upsert_skill_row(row: dict[str, Any]) -> None:
    from .util import now_iso

    execute(
        """INSERT INTO skills (name, dir, source, version, enabled, installed_at, checksum)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
             dir=excluded.dir, source=excluded.source, version=excluded.version,
             enabled=excluded.enabled, installed_at=excluded.installed_at, checksum=excluded.checksum""",
        (
            row["name"],
            row["dir"],
            row.get("source"),
            row.get("version"),
            1 if row.get("enabled", 1) else 0,
            now_iso(),
            row.get("checksum"),
        ),
    )


def list_skill_rows() -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM skills ORDER BY name")
    return [dict(r) for r in rows]


def set_skill_enabled_row(name: str, enabled: bool) -> None:
    execute("UPDATE skills SET enabled=? WHERE name=?", (1 if enabled else 0, name))


def delete_skill_row(name: str) -> None:
    execute("DELETE FROM skills WHERE name=?", (name,))


# -------------------- alerts --------------------


def insert_alert(row: dict[str, Any]) -> None:
    execute(
        """INSERT OR IGNORE INTO alerts (id, severity, title, source, service, status, started_at, session_id,
           source_type, fingerprint, labels, annotations, count, ack_at, resolved_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            row["id"],
            row["severity"],
            row["title"],
            row["source"],
            row["service"],
            row["status"],
            row["started_at"],
            row.get("session_id"),
            row.get("source_type"),
            row.get("fingerprint"),
            json.dumps(row["labels"], ensure_ascii=False) if row.get("labels") else None,
            json.dumps(row["annotations"], ensure_ascii=False) if row.get("annotations") else None,
            int(row.get("count") or 1),
            row.get("ack_at"),
            row.get("resolved_at"),
        ),
    )


def get_alert_by_fingerprint(fingerprint: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM alerts WHERE fingerprint = ?", (fingerprint,))
    return dict(row) if row else None


def update_alert(alert_id: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
    allowed = {"status", "session_id", "severity", "title", "ack_at", "resolved_at", "count", "labels", "annotations"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if sets:
        assignments = ", ".join(f"{k}=?" for k in sets)
        execute(f"UPDATE alerts SET {assignments} WHERE id=?", (*sets.values(), alert_id))
    return get_alert(alert_id)


def list_alerts(status: Optional[str] = None, severity: Optional[str] = None) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if severity:
        clauses.append("severity = ?")
        params.append(severity)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = query_all(f"SELECT * FROM alerts{where} ORDER BY started_at DESC", params)
    return [dict(r) for r in rows]


def get_alert(alert_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM alerts WHERE id = ?", (alert_id,))
    return dict(row) if row else None


def parse_json(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


# -------------------- llm_calls（P0 Token 用量/成本统计） --------------------


def insert_llm_call(row: dict[str, Any]) -> None:
    execute(
        """INSERT INTO llm_calls (id, session_id, provider_id, model, call_type, prompt_tokens,
           completion_tokens, total_tokens, latency_ms, cost, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            row["id"],
            row.get("session_id"),
            row.get("provider_id"),
            row["model"],
            row.get("call_type") or "agent",
            int(row.get("prompt_tokens") or 0),
            int(row.get("completion_tokens") or 0),
            int(row.get("total_tokens") or 0),
            int(row.get("latency_ms") or 0),
            float(row.get("cost") or 0),
            row["created_at"],
        ),
    )


def list_llm_calls(session_id: Optional[str] = None, limit: int = 500) -> list[dict[str, Any]]:
    if session_id:
        rows = query_all(
            "SELECT * FROM llm_calls WHERE session_id=? ORDER BY created_at DESC LIMIT ?", (session_id, limit)
        )
    else:
        rows = query_all("SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT ?", (limit,))
    return [dict(r) for r in rows]


def delete_llm_calls_by_session(session_id: str) -> None:
    execute("DELETE FROM llm_calls WHERE session_id=?", (session_id,))


# -------------------- users（P0 认证与 RBAC） --------------------


def insert_user(row: dict[str, Any]) -> None:
    execute(
        """INSERT INTO users (id, username, display_name, role, password_hash, created_at, disabled)
           VALUES (?,?,?,?,?,?,?)""",
        (
            row["id"],
            row["username"],
            row["display_name"],
            row["role"],
            row["password_hash"],
            row["created_at"],
            1 if row.get("disabled") else 0,
        ),
    )


def get_user_by_username(username: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM users WHERE username=?", (username,))
    return dict(row) if row else None


def get_user(user_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM users WHERE id=?", (user_id,))
    return dict(row) if row else None


def list_users() -> list[dict[str, Any]]:
    return [dict(r) for r in query_all("SELECT * FROM users ORDER BY created_at")]


def count_sessions_for_user(user_id: str) -> int:
    row = query_one("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", (user_id,))
    return int(row["n"]) if row else 0


def sum_tokens_for_user(user_id: str) -> int:
    row = query_one(
        "SELECT COALESCE(SUM(l.total_tokens), 0) AS n FROM llm_calls l "
        "JOIN sessions s ON s.id = l.session_id WHERE s.user_id = ?",
        (user_id,),
    )
    return int(row["n"]) if row else 0


def update_user(user_id: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
    allowed = {"display_name", "role", "password_hash", "disabled"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return get_user(user_id)
    assignments = ", ".join(f"{k}=?" for k in sets)
    execute(f"UPDATE users SET {assignments} WHERE id=?", (*sets.values(), user_id))
    return get_user(user_id)


def delete_user(user_id: str) -> None:
    execute("DELETE FROM users WHERE id=?", (user_id,))


def insert_artifact(row: dict[str, Any]) -> None:
    with _lock:
        conn.execute(
            "INSERT INTO artifacts (id, session_id, name, path, mime, size, kind, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row["id"],
                row.get("session_id"),
                row["name"],
                row["path"],
                row.get("mime") or "application/octet-stream",
                int(row.get("size") or 0),
                row.get("kind"),
                row.get("sha256"),
                row["created_at"],
            ),
        )
        conn.commit()


def list_artifacts(session_id: Optional[str] = None) -> list[dict[str, Any]]:
    if session_id:
        rows = query_all("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC", (session_id,))
    else:
        rows = query_all("SELECT * FROM artifacts ORDER BY created_at ASC")
    return [dict(r) for r in rows]


def get_artifact(artifact_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))
    return dict(row) if row else None


def get_artifact_by_path(session_id: Optional[str], path: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM artifacts WHERE session_id = ? AND path = ?", (session_id, path))
    return dict(row) if row else None


def delete_artifact(artifact_id: str) -> bool:
    with _lock:
        cur = conn.execute("DELETE FROM artifacts WHERE id = ?", (artifact_id,))
        conn.commit()
        return cur.rowcount > 0


def upsert_eval_case(row: dict[str, Any]) -> None:
    with _lock:
        conn.execute(
            """
            INSERT INTO eval_cases (id, case_json, source_session_id, origin, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              case_json = excluded.case_json,
              source_session_id = excluded.source_session_id,
              origin = excluded.origin,
              updated_at = excluded.updated_at
            """,
            (
                row["id"],
                row["case_json"],
                row.get("source_session_id"),
                row.get("origin") or "manual",
                row["created_at"],
                row["updated_at"],
            ),
        )
        conn.commit()


def _eval_case_from_row(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["case"] = parse_json(item.pop("case_json"), {})
    return item


def list_eval_cases() -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM eval_cases ORDER BY created_at ASC")
    return [_eval_case_from_row(r) for r in rows]


def get_eval_case(case_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM eval_cases WHERE id = ?", (case_id,))
    return _eval_case_from_row(row) if row else None


def delete_eval_case(case_id: str) -> bool:
    with _lock:
        cur = conn.execute("DELETE FROM eval_cases WHERE id = ?", (case_id,))
        conn.commit()
        return cur.rowcount > 0


def insert_eval_run(row: dict[str, Any]) -> None:
    with _lock:
        conn.execute(
            "INSERT INTO eval_runs (id, case_id, session_id, passed, score, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                row["id"],
                row["case_id"],
                row.get("session_id"),
                1 if row.get("passed") else 0,
                float(row.get("score") or 0),
                row.get("detail_json"),
                row["created_at"],
            ),
        )
        conn.commit()


def list_eval_runs(case_id: Optional[str] = None, limit: int = 100) -> list[dict[str, Any]]:
    if case_id:
        rows = query_all("SELECT * FROM eval_runs WHERE case_id = ? ORDER BY created_at DESC LIMIT ?", (case_id, limit))
    else:
        rows = query_all("SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?", (limit,))
    out = []
    for row in rows:
        item = dict(row)
        item["passed"] = bool(item.get("passed"))
        out.append(item)
    return out


def insert_schedule(row: dict[str, Any]) -> None:
    with _lock:
        conn.execute(
            """
            INSERT INTO schedules (id, name, cron, prompt, enabled, skills, user_id, created_at, updated_at,
              last_run_at, next_run_at, run_count, last_session_id, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row["name"],
                row["cron"],
                row["prompt"],
                1 if row.get("enabled", True) else 0,
                json.dumps(row.get("skills") or [], ensure_ascii=False),
                row.get("user_id"),
                row["created_at"],
                row["updated_at"],
                row.get("last_run_at"),
                row.get("next_run_at"),
                int(row.get("run_count") or 0),
                row.get("last_session_id"),
                row.get("last_error"),
            ),
        )
        conn.commit()


def _schedule_from_row(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["enabled"] = bool(item.get("enabled"))
    item["skills"] = parse_json(item.get("skills"), [])
    return item


def list_schedules() -> list[dict[str, Any]]:
    rows = query_all("SELECT * FROM schedules ORDER BY created_at ASC")
    return [_schedule_from_row(r) for r in rows]


def get_schedule(schedule_id: str) -> Optional[dict[str, Any]]:
    row = query_one("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
    return _schedule_from_row(row) if row else None


def update_schedule(schedule_id: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
    allowed = {
        "name",
        "cron",
        "prompt",
        "enabled",
        "skills",
        "next_run_at",
        "last_run_at",
        "run_count",
        "last_session_id",
        "last_error",
        "updated_at",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_schedule(schedule_id)
    sets: list[str] = []
    params: list[Any] = []
    for key, value in updates.items():
        sets.append(f"{key} = ?")
        if key == "enabled":
            params.append(1 if value else 0)
        elif key == "skills":
            params.append(json.dumps(value or [], ensure_ascii=False))
        else:
            params.append(value)
    params.append(schedule_id)
    with _lock:
        conn.execute(f"UPDATE schedules SET {', '.join(sets)} WHERE id = ?", params)
        conn.commit()
    return get_schedule(schedule_id)


def delete_schedule(schedule_id: str) -> bool:
    with _lock:
        cur = conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
        conn.commit()
        return cur.rowcount > 0


def count_users() -> int:
    row = query_one("SELECT COUNT(*) AS c FROM users")
    return int(row["c"]) if row else 0
