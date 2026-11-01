"""Skill 工具注册表与统一派发 —— 对应 `server/src/gateway/policy.ts` 的 ALL_TOOLS
与 `commandGateway.ts` 的 `dispatch()`。

新增 Skill 时：实现 `TOOLS: list[ToolDef]` 与 `async def execute(tool, args)`，
然后在下方 `_MODULES` 注册即可（Policy Engine 与 Gateway 会自动感知）。
"""

from __future__ import annotations

import importlib
from typing import Any, Awaitable, Callable

from ..models import ToolDef, ToolExecutionResult

_MODULES = {
    "linux": "infrapilot.skills.linux",
    "k8s": "infrapilot.skills.k8s",
    "elk": "infrapilot.skills.elk",
    "clickhouse": "infrapilot.skills.clickhouse",
    "prom": "infrapilot.skills.prom",
    "trace": "infrapilot.skills.trace",
    "knowledge": "infrapilot.skills.knowledge",
    "topology": "infrapilot.skills.topology",
    "openstack": "infrapilot.skills.openstack",
    "drawio": "infrapilot.skills.drawio",
    "skills": "infrapilot.skills.packages",
    "subagent": "infrapilot.skills.subagent",
    "interpreter": "infrapilot.skills.interpreter",
}

_Executor = Callable[[str, dict[str, Any]], Awaitable[ToolExecutionResult]]


def _load(skill: str) -> tuple[list[ToolDef], _Executor]:
    module = importlib.import_module(_MODULES[skill])
    return module.TOOLS, module.execute


def all_tools() -> list[ToolDef]:
    tools: list[ToolDef] = []
    for skill in _MODULES:
        module_tools, _ = _load(skill)
        tools.extend(module_tools)
    return tools


def implemented_skills() -> list[str]:
    return list(_MODULES)


async def dispatch(skill: str, tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    if skill not in _MODULES:
        return ToolExecutionResult(success=False, error=f"未知skill: {skill}", durationMs=0)
    _, executor = _load(skill)
    return await executor(tool, args)
