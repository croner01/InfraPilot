"""Command Gateway —— 对应 `server/src/gateway/commandGateway.ts`。

唯一的工具执行入口：校验审批令牌 -> 校验 argsHash 防篡改 -> 执行 -> 写审计日志。
"""

from __future__ import annotations

import json
import time

from . import artifacts, db, skills
from .args_hash import compute_args_hash
from .models import PendingToolCall, ToolExecutionResult
from .util import new_id, now_iso


async def execute_tool_call(
    pending: PendingToolCall,
    session_id: str,
    caller_agent: str,
    approved_by: str | None = None,
) -> ToolExecutionResult:
    started_at = now_iso()
    start = time.time()

    if pending.risk.requiresApproval and not pending.approvalId:
        return _reject(pending, session_id, caller_agent, approved_by, started_at, start, "该操作需要审批但缺少审批令牌,已拒绝执行")

    if pending.risk.requiresApproval and pending.approvalId:
        approval = db.get_approval(pending.approvalId)
        if approval is None:
            return _reject(pending, session_id, caller_agent, approved_by, started_at, start, "审批记录不存在，已拒绝执行")
        if approval["decision"] != "approved":
            return _reject(
                pending,
                session_id,
                caller_agent,
                approved_by,
                started_at,
                start,
                f"审批记录状态为 {approval['decision']}，已拒绝执行",
            )
        current_hash = compute_args_hash(pending.skill, pending.tool, pending.args)
        if approval["args_hash"] != current_hash:
            return _reject(
                pending,
                session_id,
                caller_agent,
                approved_by,
                started_at,
                start,
                "审批令牌与当前命令参数不匹配，可能存在篡改，已拒绝执行",
            )

    result = await skills.dispatch(pending.skill, pending.tool, pending.args)
    if result.success and result.data is not None:
        # P3 Artifact：把工具产物（drawio 图 / 沙箱输出）登记到会话维度，失败不影响主链路
        artifacts.register_from_tool_result(session_id, pending.skill, pending.tool, result.data)
    _write_audit(pending, session_id, caller_agent, approved_by, result, started_at)
    return result


def _reject(
    pending: PendingToolCall,
    session_id: str,
    caller_agent: str,
    approved_by: str | None,
    started_at: str,
    start: float,
    error: str,
) -> ToolExecutionResult:
    result = ToolExecutionResult(success=False, error=error, durationMs=int((time.time() - start) * 1000))
    _write_audit(pending, session_id, caller_agent, approved_by, result, started_at)
    return result


def _write_audit(
    pending: PendingToolCall,
    session_id: str,
    caller_agent: str,
    approved_by: str | None,
    result: ToolExecutionResult,
    started_at: str,
) -> None:
    db.insert_audit(
        {
            "id": new_id(),
            "sessionId": session_id,
            "callerAgent": caller_agent,
            "skill": pending.skill,
            "tool": pending.tool,
            "args": json.dumps(pending.args, ensure_ascii=False),
            "riskLevel": pending.risk.level,
            "approvalId": pending.approvalId,
            "approvedBy": approved_by,
            "success": result.success,
            "resultSummary": json.dumps(result.model_dump(), ensure_ascii=False)[:2000],
            "startedAt": started_at,
            "finishedAt": now_iso(),
        }
    )
