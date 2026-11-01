"""跨会话记忆 —— 对应 `server/src/agent/memoryStore.ts`。"""

from __future__ import annotations

import json
from typing import Any, Optional

from . import db
from .config_store import get_memory_config
from .embedder import InMemoryEmbeddingStore, create_embedder
from .models import AgentSession
from .redact import redact
from .util import new_id, now_iso


def _memory_to_text(m: dict[str, Any]) -> str:
    return "\n".join(
        [
            f"title: {m['title']}",
            f"summary: {m['summary']}",
            f"tags: {','.join(m['tags'])}" if m.get("tags") else "",
        ]
    ).strip()


def _row_to_memory(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "sessionId": row["session_id"],
        "title": row["title"],
        "summary": row["summary"],
        "tags": db.parse_json(row.get("tags"), None) if row.get("tags") else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


class MemoryStore:
    def __init__(self) -> None:
        self._embedder = create_embedder()
        self._index: InMemoryEmbeddingStore[dict[str, Any]] = InMemoryEmbeddingStore()
        self._initialized = False

    def init(self) -> None:
        if self._initialized:
            return
        self._embedder = create_embedder()
        self._index.clear()
        memories = [_row_to_memory(row) for row in db.list_memories()]
        self._embedder.fit([_memory_to_text(m) for m in memories])
        for m in memories:
            self._index.add(m["id"], m, self._embedder.embed(_memory_to_text(m)))
        self._initialized = True

    def add(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.init()
        now = now_iso()
        m = {**payload, "id": new_id(), "createdAt": now, "updatedAt": now}
        vector = self._embedder.embed(_memory_to_text(m))
        db.upsert_memory(
            {
                "id": m["id"],
                "session_id": m["sessionId"],
                "title": m["title"],
                "summary": m["summary"],
                "tags": json.dumps(m["tags"], ensure_ascii=False) if m.get("tags") else None,
                "created_at": m["createdAt"],
                "updated_at": m["updatedAt"],
                "embedding": json.dumps(vector.weights),
            }
        )
        self._index.add(m["id"], m, vector)
        return m

    def search(self, query: str, limit: int = 5, min_score: float = 0.01) -> list[dict[str, Any]]:
        self.init()
        results = self._index.search(self._embedder.embed(query), limit, min_score)
        return [{**r.item, "score": r.score} for r in results]

    def list(self) -> list[dict[str, Any]]:
        return [_row_to_memory(row) for row in db.list_memories()]

    def get(self, memory_id: str) -> Optional[dict[str, Any]]:
        row = db.get_memory(memory_id)
        return _row_to_memory(row) if row else None

    def get_by_session(self, session_id: str) -> Optional[dict[str, Any]]:
        row = db.get_memory_by_session(session_id)
        return _row_to_memory(row) if row else None

    def delete(self, memory_id: str) -> None:
        db.delete_memory(memory_id)
        self._index.remove(memory_id)

    def reset(self) -> None:
        self._index.clear()
        self._initialized = False


_store = MemoryStore()


def init_memory_store() -> None:
    _store.init()


def list_memories() -> list[dict[str, Any]]:
    return _store.list()


def delete_memory(memory_id: str) -> None:
    _store.delete(memory_id)


def extract_memory_summary(session: AgentSession) -> str:
    seen: list[str] = []
    for t in session.executedToolCalls:
        name = f"{t.skill}.{t.tool}"
        if name not in seen:
            seen.append(name)
    tool_names = ", ".join(seen)

    root_cause = getattr(session.rootCause, "summary", None)
    remediation = getattr(session.remediation, "summary", None)
    parts = [
        f"主题: {session.title}",
        f"现象: {session.incidentSummary}" if session.incidentSummary else "",
        f"根因: {root_cause}" if root_cause else "",
        f"方案: {remediation}" if remediation else "",
        f"使用工具: {tool_names}" if tool_names else "",
    ]
    return redact("\n".join(p for p in parts if p))


def extract_and_store_session_memory(session_id: str) -> None:
    from .sessions import get_session

    cfg = get_memory_config()
    if not cfg.get("enabled"):
        return
    if _store.get_by_session(session_id):
        return
    session = get_session(session_id)
    if session is None:
        return
    if not session.incidentSummary and not session.rootCause and not session.executedToolCalls:
        return
    _store.add(
        {
            "sessionId": session_id,
            "title": session.title,
            "summary": extract_memory_summary(session),
            "tags": ["auto_extracted"],
        }
    )


def build_memory_context(query: str) -> str:
    cfg = get_memory_config()
    if not cfg.get("enabled") or int(cfg.get("recallTopK") or 0) <= 0:
        return ""
    memories = _store.search(query, limit=int(cfg["recallTopK"]))
    if not memories:
        return ""
    lines = "\n".join(
        f"- memory_id={m['id']} [相似度 {m['score']:.3f}] {m['title']}\n  摘要: {m['summary']}" for m in memories
    )
    return f"\n# 相关历史会话记忆\n{lines}\n"
