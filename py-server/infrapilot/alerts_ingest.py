"""告警接入（P1）—— Alertmanager webhook → alerts 表 + P0/P1 自动开会话诊断。

对应差异分析 P1「告警自动触发诊断（webhook 入口 + P0 告警自动开会话）」。
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from . import db, sessions
from .util import new_id, now_iso

_SEVERITY_MAP = {"critical": "p0", "error": "p0", "warning": "p1", "warn": "p1", "info": "p2", "none": "p2"}


def _map_severity(value: Optional[str]) -> str:
    return _SEVERITY_MAP.get(str(value or "").lower(), "p2")


def public_alert(row: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not row:
        return None
    parsed = dict(row)
    for key in ("labels", "annotations"):
        if parsed.get(key):
            try:
                parsed[key] = db.parse_json(parsed[key], {})
            except Exception:  # noqa: BLE001
                parsed[key] = {}
    return parsed


def _service_of(labels: dict[str, str]) -> str:
    for key in ("service", "app", "app_kubernetes_io_name", "pod", "deployment", "node_name", "instance"):
        if labels.get(key):
            return labels[key]
    return labels.get("namespace") or "unknown"


def ingest_alertmanager(payload: dict[str, Any]) -> dict[str, Any]:
    """处理一条 Alertmanager webhook；返回创建/更新的告警与会话。"""
    incoming = payload.get("alerts")
    if not isinstance(incoming, list):
        incoming = []
    created: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    auto_sessions: list[dict[str, Any]] = []

    for item in incoming:
        labels = {str(k): str(v) for k, v in (item.get("labels") or {}).items()}
        annotations = {str(k): str(v) for k, v in (item.get("annotations") or {}).items()}
        fingerprint = str(item.get("fingerprint") or f"{labels.get('alertname')}:{_service_of(labels)}")
        severity = _map_severity(labels.get("severity"))
        status = "resolved" if str(item.get("status")) == "resolved" else "firing"
        title = annotations.get("summary") or labels.get("alertname") or "未命名告警"
        service = _service_of(labels)

        existing = db.get_alert_by_fingerprint(fingerprint)
        if existing:
            fields: dict[str, Any] = {"count": int(existing.get("count") or 1) + 1}
            if status == "resolved":
                fields["status"] = "resolved"
                fields["resolved_at"] = now_iso()
            db.update_alert(existing["id"], fields)
            updated.append(public_alert(db.get_alert(existing["id"])))
            continue

        alert_id = new_id()
        row = {
            "id": alert_id,
            "severity": severity,
            "title": title,
            "source": "alertmanager",
            "service": service,
            "status": status,
            "started_at": str(item.get("startsAt") or now_iso()),
            "source_type": "alertmanager",
            "fingerprint": fingerprint,
            "labels": labels,
            "annotations": annotations,
            "count": 1,
            "resolved_at": now_iso() if status == "resolved" else None,
        }
        db.insert_alert(row)
        created.append(public_alert(db.get_alert(alert_id)))

        # P0/P1 且处于 firing：自动开会话并触发诊断
        if status == "firing" and severity in ("p0", "p1"):
            session = sessions.create_session(f"[{severity.upper()}] {title}", subject=service)
            db.update_alert(alert_id, {"status": "diagnosing", "session_id": session.id})
            prompt = (
                f"告警自动诊断：{title}\n"
                f"级别: {severity} / 服务: {service} / 命名空间: {labels.get('namespace', '-')}\n"
                f"标签: {labels}\n附加信息: {annotations}\n"
                "请按标准流程诊断根因，给出结论与修复建议。"
            )
            asyncio.create_task(_start_diagnosis(session.id, prompt))
            auto_sessions.append({"alertId": alert_id, "sessionId": session.id})

    return {"ok": True, "created": created, "updated": updated, "sessions": auto_sessions}


async def _start_diagnosis(session_id: str, prompt: str) -> None:
    from .orchestrator import start_agent_turn

    try:
        sessions.emit_event(session_id, "user_message", {"message": prompt, "role": "user"})
        await start_agent_turn(session_id, prompt)
    except Exception as err:  # noqa: BLE001 - 自动诊断失败不应影响 webhook 响应
        print(f"[alerts] 自动诊断失败: {err}")


def _fingerprint_of(labels: dict[str, str]) -> str:
    group = labels.get("group_id")
    if group:
        return group
    alertname = labels.get("alertname") or "alert"
    anchor = labels.get("node_name") or labels.get("instance") or labels.get("namespace") or ""
    return f"prom:{alertname}:{anchor}"


def sync_prometheus_alerts() -> dict[str, Any]:
    """把 Prometheus `ALERTS{alertstate="firing"}` 同步进 alerts 表（真实告警列表来源）。

    - 按指纹幂等 upsert，不自动开诊断会话（避免批量告警触发风暴）
    - 本轮不再 firing 的 prometheus 告警自动置为 resolved
    """
    from .config_store import get_default_prometheus_backend
    from .skills import prom

    backend = get_default_prometheus_backend()
    if not backend:
        return {"ok": False, "error": "未配置 Prometheus 数据源", "created": 0, "updated": 0, "resolved": 0, "firing": 0}

    try:
        result = prom.prom_instant_query(backend, 'ALERTS{alertstate="firing"}')
    except Exception as err:  # noqa: BLE001 - 数据源不可用时前端展示错误态
        return {"ok": False, "error": str(err), "created": 0, "updated": 0, "resolved": 0, "firing": 0}

    created = updated = 0
    seen: set[str] = set()
    for sample in result.get("samples") or []:
        labels = {str(k): str(v) for k, v in (sample.get("metric") or {}).items() if k != "__name__"}
        alertname = labels.get("alertname") or "未命名告警"
        fingerprint = _fingerprint_of(labels)
        seen.add(fingerprint)
        existing = db.get_alert_by_fingerprint(fingerprint)
        if existing:
            if existing.get("status") != "firing":
                db.update_alert(existing["id"], {"status": "firing", "resolved_at": None})
            updated += 1
            continue
        db.insert_alert(
            {
                "id": new_id(),
                "severity": _map_severity(labels.get("severity")),
                "title": labels.get("summary") or alertname,
                "source": "prometheus",
                "service": _service_of(labels),
                "status": "firing",
                "started_at": labels.get("activeAt") or now_iso(),
                "session_id": None,
                "source_type": "alertmanager",
                "fingerprint": fingerprint,
                "labels": labels,
                "annotations": {},
                "count": 1,
                "resolved_at": None,
            }
        )
        created += 1

    resolved = 0
    for row in db.list_alerts():
        if row.get("source") != "prometheus":
            continue
        if row.get("fingerprint") in seen or row.get("status") == "resolved":
            continue
        db.update_alert(row["id"], {"status": "resolved", "resolved_at": now_iso()})
        resolved += 1

    return {"ok": True, "created": created, "updated": updated, "resolved": resolved, "firing": len(seen)}
