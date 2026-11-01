"""REST API — 对应 `server/src/routes/api.ts`。

所有路径与响应体字段均与 Node 版保持一致，前端无需改动。
"""

from __future__ import annotations

import json
import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request

from .. import artifacts, db, demo, knowledge, memory, sessions
from ..util import new_id, now_iso
from ..models import KnowledgeCaseInput
from ..orchestrator import resume_agent_turn, start_agent_turn
from ..skills import elk as elk_skill
from ..skills import k8s as k8s_skill

api_router = APIRouter()


@api_router.get("/sessions")
def list_sessions() -> list[dict[str, Any]]:
    return sessions.list_session_summaries()


@api_router.post("/sessions")
def create_session(request: Request, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import auth as auth_mod

    title = (payload or {}).get("title") or sessions.DEFAULT_SESSION_TITLE
    subject = (payload or {}).get("subject") or None
    user = auth_mod.user_from_request(request)
    return sessions.create_session(
        title, user_id=user["id"] if user else None, subject=subject
    ).model_dump()


@api_router.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    session = sessions.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="not found")
    return session.model_dump()


@api_router.get("/sessions/{session_id}/audit")
def get_session_audit(session_id: str) -> list[dict[str, Any]]:
    return db.list_audit_by_session(session_id)


@api_router.get("/sessions/{session_id}/events")
def get_session_events(session_id: str) -> list[dict[str, Any]]:
    rows = db.list_timeline_events(session_id)
    return [
        {
            "id": row["id"],
            "sessionId": row["session_id"],
            "type": row["type"],
            "timestamp": row["timestamp"],
            "payload": db.parse_json(row["payload"], None),
        }
        for row in rows
    ]


@api_router.patch("/sessions/{session_id}")
def patch_session(session_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    title = (payload or {}).get("title")
    if title is not None:
        sessions.update_session_title(session_id, title)
    return {"ok": True, "session": sessions.get_session(session_id).model_dump()}  # type: ignore[union-attr]


@api_router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, Any]:
    if not sessions.delete_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": True}


@api_router.post("/sessions/{session_id}/cancel")
async def cancel_session(session_id: str) -> dict[str, Any]:
    """中断执行：停掉进行中的 Agent 轮次并把会话置为已关闭（幂等，可重复调用）。

    这是前端「停止执行」按钮与 A2A `tasks/cancel` 共用的后端能力：
    - 有活动轮次时立即 `task.cancel()`，LLM 流式请求/工具等待会当场抛出并收尾；
    - 停在等待审批等无活动轮次的场景，只收尾状态并作废未决审批。
    """
    session = sessions.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")

    if session.status not in sessions.RUNNING_STATUSES:
        return {"ok": True, "interrupted": False, "changed": False, "session": session.model_dump()}

    interrupted = sessions.request_cancel(session_id)
    # 未决审批随中断一起作废，避免取消后审批卡仍能恢复执行
    for pending in list(session.pendingToolCalls):
        approval_id = getattr(pending, "approvalId", None)
        if not approval_id:
            continue
        approval = db.get_approval(approval_id)
        if approval and approval["decision"] == "pending":
            db.decide_approval(approval_id, "rejected", "session-canceled")
    sessions.terminate_session(session_id)
    if interrupted:
        # 活动轮次会由 orchestrator 的收尾逻辑广播 canceled/done；这里不重复发事件
        pass
    else:
        sessions.emit_event(session_id, "status", {"status": "canceled", "message": "用户中断执行"})
        sessions.emit_event(session_id, "done", {})
    return {
        "ok": True,
        "interrupted": interrupted,
        "changed": True,
        "session": sessions.get_session(session_id).model_dump(),  # type: ignore[union-attr]
    }


@api_router.get("/sessions/{session_id}/artifacts")
def list_session_artifacts(session_id: str) -> dict[str, Any]:
    return {"artifacts": artifacts.list_for_session(session_id)}


@api_router.get("/sessions/{session_id}/allowlist")
def get_session_allowlist(session_id: str) -> dict[str, Any]:
    return {"allowlist": db.list_allowlist(session_id)}


@api_router.post("/sessions/{session_id}/allowlist")
def add_session_allowlist(
    session_id: str, request: Request, payload: dict[str, Any] = Body(default={})
) -> dict[str, Any]:
    """会话级免审批白名单：仅允许 medium 风险工具，其余仍走人工审批。"""
    from .. import auth as auth_mod
    from ..policy import find_tool

    body = payload or {}
    skill = str(body.get("skill") or "").strip()
    tool = str(body.get("tool") or "").strip()
    if not skill or not tool:
        raise HTTPException(status_code=400, detail="skill and tool are required")
    definition = find_tool(skill, tool)
    if definition is None:
        raise HTTPException(status_code=400, detail="未注册的工具,拒绝加入白名单")
    if definition.risk != "medium":
        raise HTTPException(status_code=400, detail="仅 medium 风险工具支持会话免审批白名单")
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    user = auth_mod.user_from_request(request)
    db.upsert_allowlist(session_id, skill, tool, user["username"] if user else None)
    return {"ok": True, "allowlist": db.list_allowlist(session_id)}


@api_router.delete("/sessions/{session_id}/allowlist/{skill}/{tool}")
def remove_session_allowlist(session_id: str, skill: str, tool: str) -> dict[str, Any]:
    db.delete_allowlist(session_id, skill, tool)
    return {"ok": True, "allowlist": db.list_allowlist(session_id)}


def _public_alert(row: dict[str, Any]) -> dict[str, Any]:
    """alerts 表行 → 前端 Alert（camelCase）；GET 与 PATCH 共用同一响应形状。"""
    item: dict[str, Any] = {
        "id": row["id"],
        "severity": row["severity"],
        "title": row["title"],
        "source": row["source"],
        "service": row["service"],
        "status": row["status"],
        "startedAt": row["started_at"],
    }
    if row.get("session_id"):
        item["sessionId"] = row["session_id"]
    # 告警中心扩展字段（webhook 接入后返回，前端可选渲染）
    for src, dst in (
        ("source_type", "sourceType"),
        ("fingerprint", "fingerprint"),
        ("count", "count"),
        ("ack_at", "ackAt"),
        ("resolved_at", "resolvedAt"),
    ):
        if row.get(src) is not None:
            item[dst] = row[src]
    if row.get("labels"):
        item["labels"] = db.parse_json(row["labels"], {})
    if row.get("annotations"):
        item["annotations"] = db.parse_json(row["annotations"], {})
    return item


@api_router.get("/alerts")
def get_alerts(request: Request) -> dict[str, Any]:
    status = request.query_params.get("status")
    severity = request.query_params.get("severity")
    rows = db.list_alerts(status=status, severity=severity)
    return {"alerts": [_public_alert(row) for row in rows]}


@api_router.post("/alerts/sync")
async def sync_alerts() -> dict[str, Any]:
    """把 Prometheus 当前 firing 告警同步进本地表，让告警列表展示真实数据。"""
    from .. import alerts_ingest

    return await asyncio.to_thread(alerts_ingest.sync_prometheus_alerts)


@api_router.get("/health/services")
async def get_service_health() -> dict[str, Any]:
    """服务健康总览：真实 Prometheus(kube-state-metrics) 聚合，替代前端写死的 demo。"""
    from .. import service_health

    return await asyncio.to_thread(service_health.collect_service_health)


@api_router.patch("/alerts/{alert_id}")
def patch_alert(alert_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    if db.get_alert(alert_id) is None:
        raise HTTPException(status_code=404, detail="alert not found")
    body = payload or {}
    fields: dict[str, Any] = {}
    if body.get("status") is not None:
        fields["status"] = str(body["status"])
        if body["status"] == "acknowledged":
            fields["ack_at"] = now_iso()
        elif body["status"] == "resolved":
            fields["resolved_at"] = now_iso()
    if body.get("sessionId") is not None:
        fields["session_id"] = body["sessionId"]
    return {"ok": True, "alert": _public_alert(db.update_alert(alert_id, fields))}  # type: ignore[arg-type]


@api_router.post("/webhooks/alertmanager")
async def alertmanager_webhook(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import alerts_ingest

    return alerts_ingest.ingest_alertmanager(payload or {})


# -------------------- Demo 场景控制(真实K8s集群) --------------------


@api_router.get("/demo/pod-state")
async def get_demo_pod_state() -> dict[str, Any]:
    try:
        state = await demo.get_real_pod_state()
        return state or {
            "podName": "order-api",
            "namespace": "order-service",
            "status": "NotFound",
            "restartCount": 0,
            "resources": {"limitsMemoryMb": 0},
            "events": [],
            "currentRssMb": 0,
        }
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"查询真实K8s集群失败: {err}") from err


@api_router.post("/demo/restart-scenario")
async def restart_scenario() -> dict[str, Any]:
    try:
        await demo.reset_real_demo_scenario(200)
        return {"ok": True}
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"重置真实K8s场景失败: {err}") from err


# -------------------- 通用 K8s Pod 上下文 --------------------


@api_router.get("/k8s/pods")
async def list_pods(request: Request) -> dict[str, Any]:
    namespace = request.query_params.get("namespace")
    abnormal_only = request.query_params.get("abnormalOnly") == "true"
    try:
        pods = await k8s_skill.list_pods(namespace)
        if abnormal_only:
            pods = [p for p in pods if k8s_skill.is_abnormal_pod(p)]
        return {"pods": pods}
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"查询 Pod 列表失败: {err}") from err


@api_router.get("/k8s/pods/{namespace}/{name}")
async def get_pod_detail(namespace: str, name: str) -> dict[str, Any]:
    try:
        pod, events = await asyncio.gather(
            k8s_skill.read_pod(namespace, name),
            k8s_skill.list_events_for_pod(namespace, name),
        )
        if pod is None:
            raise HTTPException(status_code=404, detail="pod not found")
        return {"pod": pod, "events": events}
    except HTTPException:
        raise
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"查询 Pod 详情失败: {err}") from err


# -------------------- 日志检索（数据源工作台 / 对象上下文） --------------------


@api_router.get("/objects/{namespace}/{name}/logs")
async def get_object_logs(namespace: str, name: str, request: Request) -> dict[str, Any]:
    since = request.query_params.get("since")
    level = request.query_params.get("level")
    limit = request.query_params.get("limit")
    result = await elk_skill.execute(
        "search_logs",
        {
            "namespace": namespace,
            "service": name,
            "level": level,
            "limit": int(limit) if limit else 50,
            "since": since,
        },
    )
    if not result.success:
        raise HTTPException(status_code=500, detail=result.error or "日志查询失败")
    raw = ((result.data or {}).get("logs") or []) if isinstance(result.data, dict) else []
    return {
        "logs": [
            {
                "timestamp": str(log.get("@timestamp") or ""),
                "level": str(log.get("level") or "INFO"),
                "message": str(log.get("message") or ""),
            }
            for log in raw
        ]
    }


@api_router.post("/elk/search")
async def elk_search(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    result = await elk_skill.execute(
        "search_logs",
        {
            "namespace": body.get("namespace") or None,
            "index_prefix": body.get("index_prefix") or None,
            "service": body.get("service") or None,
            "level": body.get("level") or None,
            "keyword": body.get("keyword") or None,
            "limit": int(body["limit"]) if body.get("limit") else 50,
            "since": body.get("since") or None,
        },
    )
    if not result.success:
        return {"ok": False, "error": result.error or "日志查询失败"}
    return {"ok": True, "data": result.data}


@api_router.post("/sessions/{session_id}/messages")
async def post_message(session_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    message = (payload or {}).get("message")
    if sessions.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    if not message:
        raise HTTPException(status_code=400, detail="message required")

    # 首个问题即会话命名：占位标题按用户消息替换，避免所有会话都叫「新的故障排查会话」
    sessions.maybe_auto_title(session_id, message)
    sessions.emit_event(session_id, "user_message", {"message": message, "role": "user"})
    asyncio.create_task(_safe_start_turn(session_id, message))
    return {"accepted": True}


async def _safe_start_turn(session_id: str, message: str) -> None:
    try:
        await start_agent_turn(session_id, message)
    except Exception as err:  # noqa: BLE001
        print(f"[agent error] {err}")


@api_router.post("/approvals/{approval_id}/decide")
async def decide_approval(approval_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    approved = bool(body.get("approved"))
    approved_by = body.get("approvedBy") or "demo-user"
    db.decide_approval(approval_id, "approved" if approved else "rejected", approved_by)
    approval = db.get_approval(approval_id)
    if approval and approval["decision"] == "approved":
        target = sessions.get_session(approval["session_id"])
        if target is None or target.status not in sessions.RUNNING_STATUSES:
            # 会话已被中断/关闭：审批不再触发恢复执行
            db.decide_approval(approval_id, "rejected", "session-canceled")
            return {"ok": True, "resumed": False}
        asyncio.create_task(_safe_resume(approval["session_id"], approval_id))
    return {"ok": True, "resumed": True}


async def _safe_resume(session_id: str, approval_id: str) -> None:
    try:
        await resume_agent_turn(session_id, approval_id)
    except Exception as err:  # noqa: BLE001
        print(f"[resume error] {err}")


# -------------------- Knowledge 案例管理 --------------------


@api_router.get("/knowledge/cases")
def list_knowledge_cases() -> dict[str, Any]:
    return {"cases": knowledge.list_knowledge_cases()}


@api_router.get("/knowledge/cases/{case_id}")
def get_knowledge_case(case_id: str) -> dict[str, Any]:
    case = knowledge.get_knowledge_case(case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="case not found")
    return case


@api_router.delete("/knowledge/cases/{case_id}")
def delete_knowledge_case(case_id: str) -> dict[str, Any]:
    if not knowledge.delete_knowledge_case(case_id):
        raise HTTPException(status_code=404, detail="case not found")
    return {"ok": True}


@api_router.get("/knowledge/search")
def search_knowledge_cases(request: Request) -> dict[str, Any]:
    query = request.query_params.get("query") or ""
    problem_type = request.query_params.get("problem_type")
    service_name = request.query_params.get("service_name")
    limit = request.query_params.get("limit")
    results = knowledge.search_knowledge_cases(
        query,
        problem_type=problem_type,
        service_name=service_name,
        limit=int(limit) if limit else 10,
    )
    return {"results": results}


@api_router.post("/knowledge/cases")
def add_knowledge_case(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    if not body.get("title") or not body.get("summary") or not body.get("rootCauses"):
        raise HTTPException(status_code=400, detail="title, summary and rootCauses are required")
    case = knowledge.add_knowledge_case(KnowledgeCaseInput.model_validate(body))
    return {"ok": True, "case": case}


# -------------------- Cross-Session Memories --------------------


@api_router.get("/memories")
def list_memories() -> dict[str, Any]:
    memory.init_memory_store()
    return {"memories": memory.list_memories()}


@api_router.delete("/memories/{memory_id}")
def delete_memory(memory_id: str) -> dict[str, Any]:
    memory.delete_memory(memory_id)
    return {"ok": True}


# -------------------- 服务拓扑（P1，纯 K8s API 聚合） --------------------


@api_router.get("/topology")
async def get_topology(request: Request) -> dict[str, Any]:
    from .. import topology as topology_mod

    namespace = request.query_params.get("namespace")
    limit = request.query_params.get("limit")
    try:
        return await topology_mod.discover(namespace, int(limit) if limit and limit.isdigit() else 200)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"拓扑发现失败: {err}") from err
