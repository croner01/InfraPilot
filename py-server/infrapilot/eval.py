"""Agent 离线评测（P2）—— 对应已删除的 Node `server/src/agent/eval/`，并补齐 LLM-as-judge 与线上回流。

- 确定性 check：`hasTool` / `rootCauseMatches` / `hypothesisStatus`；
- 新增 `judgeScore`：由 `judge.py` 的 LLM-as-judge 产出 score 后做阈值判定（`evaluate_case` 保持纯函数）；
- case 存储：内置 `infrapilot/eval_cases/*.json`，并支持写入 DB
  （`origin=online` 表示从真实会话回流的 case）；
- 线上数据回流：`promote_session()` 把一个已结束会话固化为回归 case（含金标准结论 + hasTool + judgeScore）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from . import db, judge as judge_mod
from .util import new_id, now_iso

_PACKAGED_CASES_DIR = Path(__file__).resolve().parent / "eval_cases"

SUPPORTED_CHECKS = ("hasTool", "rootCauseMatches", "hypothesisStatus", "judgeScore")


def cases_dir() -> Path:
    """评测 case 目录：内置副本（infrapilot/eval_cases），可用 INFRAPILOT_EVAL_CASES_DIR 覆盖。"""
    import os

    override = os.environ.get("INFRAPILOT_EVAL_CASES_DIR")
    if override:
        return Path(override)
    return _PACKAGED_CASES_DIR


# -------------------- 确定性评测（纯函数，对应 evaluate.ts） --------------------


def evaluate_case(case: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    tools_used = ctx.get("toolsUsed") or []
    root_cause = str(ctx.get("rootCause") or "")
    hypotheses = ctx.get("hypotheses") or []
    judge = ctx.get("judge") or {}

    results: list[dict[str, Any]] = []
    for check in case.get("checks") or []:
        passed = False
        reason = "未命中"
        kind = check.get("type")
        if kind == "hasTool":
            passed = any(t.get("skill") == check.get("skill") and t.get("tool") == check.get("tool") for t in tools_used)
        elif kind == "rootCauseMatches":
            pattern = re.compile(str(check.get("regex") or ""), re.IGNORECASE)
            passed = bool(pattern.search(root_cause))
        elif kind == "hypothesisStatus":
            pattern = re.compile(str(check.get("statementRegex") or ""), re.IGNORECASE)
            passed = any(pattern.search(str(h.get("statement") or "")) and h.get("status") == check.get("status") for h in hypotheses)
        elif kind == "judgeScore":
            if judge:
                passed = float(judge.get("score") or 0) >= float(check.get("min") or 0.6)
                if not passed:
                    reason = f"judge score {judge.get('score')} < {check.get('min') or 0.6}"
            else:
                reason = "缺少 judge 结果（未启用 LLM-as-judge）"
        else:
            reason = f"未知 check 类型: {kind}"
        results.append({"check": check, "passed": passed, "reason": None if passed else reason})

    return {
        "caseId": case.get("id"),
        "checks": results,
        "passedAll": bool(results) and all(r["passed"] for r in results),
    }


# -------------------- case 读写 --------------------


def _file_case(path: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) and data.get("id") else None


def load_file_cases() -> list[dict[str, Any]]:
    directory = cases_dir()
    if not directory.is_dir():
        return []
    return [c for c in (_file_case(p) for p in sorted(directory.glob("*.json"))) if c]


def list_cases() -> list[dict[str, Any]]:
    """合并文件 case（origin=file）与 DB case（origin=online/manual）。"""
    cases: dict[str, dict[str, Any]] = {}
    for case in load_file_cases():
        cases[case["id"]] = {"origin": "file", "case": case, "sourceSessionId": None}
    for row in db.list_eval_cases():
        case = row.get("case") or {}
        if case.get("id"):
            cases[case["id"]] = {
                "origin": row.get("origin"),
                "case": case,
                "sourceSessionId": row.get("source_session_id"),
                "updatedAt": row.get("updated_at"),
            }
    return list(cases.values())


def get_case(case_id: str) -> Optional[dict[str, Any]]:
    row = db.get_eval_case(case_id)
    if row and (row.get("case") or {}).get("id"):
        return {"origin": row.get("origin"), "case": row["case"], "sourceSessionId": row.get("source_session_id")}
    return next((c for c in list_cases() if c["case"].get("id") == case_id), None)


def save_case(case: dict[str, Any], *, origin: str = "manual", source_session_id: Optional[str] = None) -> dict[str, Any]:
    if not case.get("id") or not case.get("message") or not isinstance(case.get("checks"), list):
        raise ValueError("case 需要 id / message / checks")
    for check in case["checks"]:
        if check.get("type") not in SUPPORTED_CHECKS:
            raise ValueError(f"不支持的 check 类型: {check.get('type')}（可选 {', '.join(SUPPORTED_CHECKS)}）")
    now = now_iso()
    db.upsert_eval_case(
        {
            "id": case["id"],
            "case_json": json.dumps(case, ensure_ascii=False),
            "source_session_id": source_session_id,
            "origin": origin,
            "created_at": now,
            "updated_at": now,
        }
    )
    return get_case(case["id"])  # type: ignore[return-value]


# -------------------- 线上数据回流 --------------------


def promote_session(session_id: str, *, case_id: Optional[str] = None, expected: Optional[str] = None) -> dict[str, Any]:
    """把一个真实会话固化为回归 case（线上 → 评测集回流）。"""
    from . import sessions

    session = sessions.get_session(session_id)
    if session is None:
        raise ValueError("session not found")
    root_cause = (session.rootCause.summary if session.rootCause else "") or ""
    expected_text = (expected or root_cause).strip()
    if not session.incidentSummary and not expected_text:
        raise ValueError("会话缺少问题描述与根因，无法回流为 case")

    tools = sorted({f"{c.skill}.{c.tool}" for c in (session.executedToolCalls or []) if c.skill and c.tool})
    checks: list[dict[str, Any]] = [
        {"type": "hasTool", "skill": skill, "tool": tool} for skill, tool in (t.split(".", 1) for t in tools[:6])
    ]
    checks.append({"type": "judgeScore", "min": 0.6})
    case = {
        "id": case_id or f"online-{session_id[:8]}",
        "message": session.incidentSummary or expected_text,
        "checks": checks,
        "expected": expected_text,
        "source": {"sessionId": session_id, "promotedAt": now_iso()},
    }
    return save_case(case, origin="online", source_session_id=session_id)


def record_run(case_id: str, result: dict[str, Any], *, session_id: Optional[str] = None, score: float = 0.0) -> dict[str, Any]:
    row = {
        "id": new_id(),
        "case_id": case_id,
        "session_id": session_id,
        "passed": bool(result.get("passedAll")),
        "score": score,
        "detail_json": json.dumps(result, ensure_ascii=False, default=str),
        "created_at": now_iso(),
    }
    db.insert_eval_run(row)
    return row


# -------------------- 端到端运行器 --------------------


async def run_case(case: dict[str, Any], *, base_url: str, timeout_s: float = 600, use_judge: bool = True) -> dict[str, Any]:
    """对 base_url 指向的实例跑一个 case（真实建会话 → 等结论 → 评测）。"""
    import asyncio

    import httpx

    async with httpx.AsyncClient(base_url=f"{base_url.rstrip('/')}/api", timeout=30) as client:
        created = await client.post("/sessions", json={"title": f"eval:{case['id']}"})
        created.raise_for_status()
        session_id = created.json()["id"]
        await client.post(f"/sessions/{session_id}/messages", json={"message": case["message"]})

        deadline = asyncio.get_event_loop().time() + timeout_s
        snapshot: dict[str, Any] = {}
        while True:
            res = await client.get(f"/sessions/{session_id}")
            res.raise_for_status()
            snapshot = res.json()
            if snapshot.get("status") in ("concluded", "closed") or asyncio.get_event_loop().time() > deadline:
                break
            await asyncio.sleep(5)

        events = (await client.get(f"/sessions/{session_id}/events")).json()

    # 本地重建上下文并用 judge 评分（judge 需要 LLM；失败自动降级启发式）
    from .models import AgentSession

    session = AgentSession.model_validate(snapshot)
    ctx = judge_mod.collect_context(session, expected=case.get("expected"), events=events)
    wants_judge = use_judge and any((c.get("type") == "judgeScore") for c in case.get("checks") or [])
    verdict = await judge_mod.judge_conclusion(ctx, session_id=session_id) if wants_judge else None
    if verdict:
        ctx["judge"] = verdict
    result = evaluate_case(case, ctx)
    result["sessionId"] = session_id
    result["status"] = session.status
    result["judge"] = verdict
    record_run(case["id"], result, session_id=session_id, score=float((verdict or {}).get("score") or 0))
    return result
