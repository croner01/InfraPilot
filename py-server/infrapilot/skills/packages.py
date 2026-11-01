"""Skill 包管理 Skill —— 对应 `server/src/skills/packages/tools.ts`（skill 名 = "skills"）。

list_installed: 列出已安装/启用的技能包（SKILL.md 指令集）
read_reference: 按需读取技能包 references/ 下的参考文档
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ..models import ToolDef, ToolExecutionResult
from ..skill_packages import skill_store

TOOLS: list[ToolDef] = [
    ToolDef(
        name="list_installed",
        skill="skills",
        risk="readonly",
        description="列出当前已安装/启用的技能包（SKILL.md 指令集），包含名称、描述、启停状态与捆绑资源。",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    ),
    ToolDef(
        name="read_reference",
        skill="skills",
        risk="readonly",
        description="读取已激活技能包 references/ 目录下的参考文档全文，用于按需加载技能细节。",
        parameters={
            "type": "object",
            "properties": {
                "skill_name": {"type": "string", "description": "技能名，如 ceph-rbd-108"},
                "file": {"type": "string", "description": "references/ 下的相对文件名，如 pool-blacklist.md"},
            },
            "required": ["skill_name", "file"],
            "additionalProperties": False,
        },
    ),
]


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    if tool == "list_installed":
        skill_store.init()
        skills = [
            {
                "name": s.name,
                "description": s.frontmatter.get("description"),
                "enabled": s.enabled,
                "references": s.references,
                "scripts": s.scripts,
                "assets": s.assets,
                "source": s.source,
                "version": s.version,
            }
            for s in skill_store.list()
        ]
        return _ok({"skills": skills}, started)

    if tool == "read_reference":
        skill_store.init()
        pkg = skill_store.get(str(args.get("skill_name") or ""))
        if not pkg:
            return _err(f"技能 {args.get('skill_name')} 未安装", started)
        rel = str(args.get("file") or "")
        if ".." in rel or Path(rel).is_absolute():
            return _err("非法文件路径", started)
        ref_root = Path(pkg.dir) / "references"
        full = (ref_root / rel).resolve()
        if not str(full).startswith(str(ref_root.resolve())):
            return _err("非法文件路径", started)
        if not full.exists():
            return _err(f"参考文件不存在: {rel}", started)
        content = full.read_text(encoding="utf-8")
        return _ok({"skill": pkg.name, "file": rel, "content": content[:20000]}, started)

    return _err(f"未知 skills 工具: {tool}", started)


def _ok(data: Any, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=True, data=data, durationMs=_ms(started))


def _err(error: str, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=False, error=error, durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)
