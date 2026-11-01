"""Topology Skill —— 占位实现（对应 `server/src/skills/topology/tools.ts`）。

保留该模块是为了让 Policy Engine 与 Command Gateway 的注册链路与 Node 版一致。
"""

from __future__ import annotations

from typing import Any

from ..models import ToolDef, ToolExecutionResult

TOOLS: list[ToolDef] = []


async def execute(_tool: str, _args: dict[str, Any]) -> ToolExecutionResult:
    return ToolExecutionResult(success=False, error="topology skill 尚未实现", durationMs=0)
