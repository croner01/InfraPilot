"""Agent 评测 API（P2）—— `/api/eval/*`。

Node 版评测只有 CLI（`runEval.ts`），无 HTTP 入口。Python 版补齐：
- case 集管理（文件 case + 回流 case）；
- `POST /api/eval/judge`：对指定会话做 LLM-as-judge 打分；
- `POST /api/eval/promote`：把真实会话回流为回归 case（线上数据回流）；
- `GET /api/eval/runs`：历史评测记录。

新增路由为**追加**，不影响既有前端契约。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query

from .. import db, eval as eval_mod, judge as judge_mod

eval_router = APIRouter()


@eval_router.get("/cases")
def list_cases() -> dict[str, Any]:
    cases = eval_mod.list_cases()
    return {
        "cases": cases,
        "count": len(cases),
        "casesDir": str(eval_mod.cases_dir()),
    }


@eval_router.post("/cases")
def upsert_case(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    case = body.get("case") if isinstance(body.get("case"), dict) else body
    try:
        saved = eval_mod.save_case(case, origin=str(body.get("origin") or "manual"))
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))
    return {"ok": True, "case": saved}


@eval_router.delete("/cases/{case_id}")
def delete_case(case_id: str) -> dict[str, Any]:
    if not db.delete_eval_case(case_id):
        raise HTTPException(status_code=404, detail="case not found")
    return {"ok": True}


@eval_router.post("/promote")
def promote(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    session_id = str(body.get("sessionId") or "")
    if not session_id:
        raise HTTPException(status_code=400, detail="sessionId is required")
    try:
        saved = eval_mod.promote_session(session_id, case_id=body.get("id"), expected=body.get("expected"))
    except ValueError as err:
        raise HTTPException(status_code=404 if "not found" in str(err) else 400, detail=str(err))
    return {"ok": True, "case": saved}


@eval_router.post("/judge")
async def judge(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    session_id = str(body.get("sessionId") or "")
    if not session_id:
        raise HTTPException(status_code=400, detail="sessionId is required")
    try:
        result = await judge_mod.judge_session(
            session_id,
            expected=body.get("expected"),
            allow_llm=body.get("allowLlm", True) is not False,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True, **result}


@eval_router.get("/runs")
def list_runs(case_id: Optional[str] = Query(default=None), limit: int = Query(default=100)) -> dict[str, Any]:
    runs = db.list_eval_runs(case_id, max(1, min(int(limit), 500)))
    return {"runs": runs, "count": len(runs)}


@eval_router.post("/runs")
def record_run(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    case_id = str(body.get("caseId") or "")
    if not case_id:
        raise HTTPException(status_code=400, detail="caseId is required")
    row = eval_mod.record_run(
        case_id,
        body.get("result") or {"caseId": case_id, "passedAll": bool(body.get("passed")), "checks": []},
        session_id=body.get("sessionId"),
        score=float(body.get("score") or 0),
    )
    return {"ok": True, "run": row}
