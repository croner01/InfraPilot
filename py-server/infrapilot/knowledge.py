"""Knowledge Store —— 案例持久化与 RAG 向量索引（对应 `skills/knowledge/store.ts`）。"""

from __future__ import annotations

import json
from typing import Any, Optional

from . import db
from .embedder import InMemoryEmbeddingStore, create_embedder
from .models import KnowledgeCase, KnowledgeCaseInput
from .util import new_id, now_iso


def _case_to_text(c: dict[str, Any]) -> str:
    return "\n".join(
        [
            f"title: {c['title']}",
            f"problem_type: {c.get('problemType') or ''}",
            f"severity: {c.get('severity') or ''}",
            f"summary: {c['summary']}",
            "root_causes: " + "\n".join(c.get("rootCauses") or []),
            "solutions: " + "\n".join(c.get("solutions") or []),
            f"service: {c['serviceName']}" if c.get("serviceName") else "",
            f"tags: {','.join(c['tags'])}" if c.get("tags") else "",
        ]
    ).strip()


def _row_to_case(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "problemType": row.get("problem_type") or "",
        "severity": row.get("severity") or "p3",
        "summary": row["root_cause_summary"],
        "rootCauses": db.parse_json(row.get("root_cause_category"), []),
        "solutions": db.parse_json(row.get("resolution_steps"), []),
        "tags": db.parse_json(row.get("tags"), []),
        "sourceSessionId": row.get("source_session_id"),
        "serviceName": None,
        "createdAt": row["created_at"],
        "resolved": True,
    }


class KnowledgeStore:
    def __init__(self) -> None:
        self._embedder = create_embedder()
        self._index: InMemoryEmbeddingStore[dict[str, Any]] = InMemoryEmbeddingStore()
        self._initialized = False

    def init(self) -> None:
        if self._initialized:
            return
        self._embedder = create_embedder()
        self._index.clear()
        cases = [_row_to_case(row) for row in db.list_cases()]
        self._embedder.fit([_case_to_text(c) for c in cases])
        for c in cases:
            self._index.add(c["id"], c, self._embedder.embed(_case_to_text(c)))
        self._initialized = True

    def add(self, payload: KnowledgeCaseInput | dict[str, Any]) -> dict[str, Any]:
        """新增/更新案例。

        带 sourceSessionId 时按会话 upsert：同一会话的结论可能被「证据缺口自检」修正后重出，
        追加插入会在知识库里留下同一会话的多条互相矛盾的案例(实测会话 235f9099/ bdddfb3a 各留两条)。
        """
        self.init()
        data = payload.model_dump() if isinstance(payload, KnowledgeCaseInput) else dict(payload)
        case = {"id": new_id(), "createdAt": now_iso(), "resolved": True, **data}
        session_id = case.get("sourceSessionId")
        existing = db.get_case_by_source_session(session_id) if session_id else None
        if existing is not None:
            case["id"] = existing["id"]
            case["createdAt"] = existing["created_at"]
        vector = self._embedder.embed(_case_to_text(case))
        row = {
            "id": case["id"],
            "title": case["title"],
            "root_cause_summary": case["summary"],
            "root_cause_category": json.dumps(case.get("rootCauses") or [], ensure_ascii=False),
            "resolution_steps": json.dumps(case.get("solutions") or [], ensure_ascii=False),
            "problem_type": case.get("problemType"),
            "severity": case.get("severity"),
            "solutions": json.dumps(case.get("solutions") or [], ensure_ascii=False),
            "tags": json.dumps(case.get("tags") or [], ensure_ascii=False),
            "source_session_id": session_id,
            "embedding": json.dumps(vector.weights),
        }
        if existing is not None:
            db.update_case(row)
        else:
            row["created_at"] = case["createdAt"]
            db.insert_case(row)
        # 向量索引先摘后加：InMemoryEmbeddingStore.add 是追加语义，不去重会让检索出现重复命中和陈旧内容
        self._index.remove(case["id"])
        self._index.add(case["id"], case, vector)
        return case

    def search(
        self,
        query: str,
        problem_type: Optional[str] = None,
        service_name: Optional[str] = None,
        limit: int = 5,
        min_score: float = 0.01,
    ) -> list[dict[str, Any]]:
        self.init()
        results = self._index.search(self._embedder.embed(query), limit * 4, min_score)
        filtered: list[dict[str, Any]] = []
        for r in results:
            c = r.item
            if problem_type and c.get("problemType") != problem_type:
                continue
            if service_name and c.get("serviceName") != service_name:
                continue
            filtered.append({**c, "score": r.score})
        return filtered[:limit]

    def get(self, case_id: str) -> Optional[dict[str, Any]]:
        row = db.get_case(case_id)
        return _row_to_case(row) if row else None

    def all(self) -> list[dict[str, Any]]:
        return [_row_to_case(row) for row in db.list_cases()]

    def remove(self, case_id: str) -> bool:
        """删除案例：先删库，再从向量索引摘掉，避免搜索结果里留下已删案例。"""
        if not db.delete_case(case_id):
            return False
        self._index.remove(case_id)
        return True

    def reset(self) -> None:
        self._index.clear()
        self._initialized = False


_store = KnowledgeStore()


def add_knowledge_case(payload: KnowledgeCaseInput | dict[str, Any]) -> dict[str, Any]:
    return _store.add(payload)


def search_knowledge_cases(
    query: str,
    problem_type: Optional[str] = None,
    service_name: Optional[str] = None,
    limit: int = 5,
    min_score: float = 0.01,
) -> list[dict[str, Any]]:
    return _store.search(query, problem_type=problem_type, service_name=service_name, limit=limit, min_score=min_score)


def get_knowledge_case(case_id: str) -> Optional[dict[str, Any]]:
    return _store.get(case_id)


def list_knowledge_cases() -> list[dict[str, Any]]:
    return _store.all()


def delete_knowledge_case(case_id: str) -> bool:
    return _store.remove(case_id)
