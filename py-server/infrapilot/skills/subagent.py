"""Subagent Skill（P2）—— 主 Agent 用于派发隔离子任务。

工具命名遵循 `{skill}__{tool}` 约定（此处为 `subagent__task`）。
风险级别 low：仅派生内部调查会话；子会话内的写操作仍受 Command Gateway 审批约束。
"""

from __future__ import annotations

import time
from typing import Any

from ..models import ToolDef, ToolExecutionResult
from ..subagent import run_subagent

TOOLS: list[ToolDef] = [
    ToolDef(
        name="task",
        skill="subagent",
        risk="low",
        description=(
            "派发一个独立的子 Agent 去完成一个聚焦的子任务（如：排查某服务最近错误日志），"
            "返回其结论/置信度/证据数。适用于把长链路调查与主会话隔离，避免上下文膨胀。"
            "子 Agent 需要审批时会暂停并如实上报，不会自行执行变更。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "子任务的自然语言描述（尽量自包含、可独立完成）"},
                "title": {"type": "string", "description": "可选，子会话标题"},
                "skills": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "可选，建议子 Agent 优先启用的 skill 名列表",
                },
                "max_iterations": {"type": "number", "description": "可选，子 Agent 最大迭代次数，默认 8"},
            },
            "required": ["task"],
            "additionalProperties": False,
        },
    ),
]


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    start = time.time()
    if tool != "task":
        return ToolExecutionResult(success=False, error=f"未知的subagent工具: {tool}", durationMs=0)
    task = str(args.get("task") or "").strip()
    if not task:
        return ToolExecutionResult(success=False, error="task 不能为空", durationMs=0)
    try:
        result = await run_subagent(
            task,
            title=args.get("title"),
            skills=args.get("skills") or None,
            max_iterations=int(args.get("max_iterations") or 8),
        )
    except Exception as err:  # noqa: BLE001 - 子 Agent 异常不应中断主会话
        return ToolExecutionResult(success=False, error=f"子 Agent 执行失败: {err}", durationMs=int((time.time() - start) * 1000))
    return ToolExecutionResult(
        success=bool(result.get("ok")),
        data=result,
        error=None if result.get("ok") else result.get("error") or result.get("note"),
        durationMs=int((time.time() - start) * 1000),
    )
