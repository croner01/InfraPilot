"""Skill Factory（P1）—— 从诊断会话自主生成 SKILL.md playbook 并审核入库。

流程：选择会话 → 从时间线/结论生成 SKILL.md 预览 → 人工审核 → 校验工具名后入库。
默认使用确定性模板（可从结论+证据复现）；设置 `INFRAPILOT_FACTORY_USE_LLM=1`
时改由 LLM 生成（失败自动回退模板）。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

from . import db, sessions
from .policy import ALL_TOOLS
from .settings import DATA_DIR
from .skill_packages import parse_frontmatter, skill_store

DRAFTS_DIR = (DATA_DIR / "skill-drafts").resolve()
TOOL_REF_RE = re.compile(r"\b([a-z][a-z0-9_]*)__([a-z][a-z0-9_]*)\b")


def list_candidate_sessions(limit: int = 30) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in db.list_sessions():
        session = sessions.get_session(row["id"])
        if session is None:
            continue
        if session.status not in ("concluded", "closed"):
            continue
        out.append(
            {
                "id": session.id,
                "title": session.title,
                "concluded": session.rootCause.model_dump() if session.rootCause else None,
                "planSteps": len(session.plan or []),
                "tools": sorted({f"{t.skill}.{t.tool}" for t in session.executedToolCalls}),
                "status": session.status,
            }
        )
        if len(out) >= limit:
            break
    return out


def _slugify(title: str) -> str:
    # 注意：uninstallSkill 拒绝 "sre-" 前缀（保留给内置技能），故生成包用 "pb-" 前缀
    ascii_part = re.sub(r"[^a-zA-Z0-9]+", "-", title).strip("-").lower()
    return f"pb-{ascii_part[:40] or 'generated-playbook'}"


def build_template_draft(session_id: str) -> dict[str, Any]:
    session = sessions.get_session(session_id)
    if session is None:
        raise ValueError(f"会话不存在: {session_id}")

    name = _slugify(session.title)
    root_cause = session.rootCause
    rca_summary = root_cause.summary if root_cause else "（会话尚未产出结论）"
    remedies = session.remediation.steps if session.remediation else []
    tools = sorted({f"{t.skill}.{t.tool}" for t in session.executedToolCalls})
    evidence_lines = [f"- ({e.type}) {e.summary}" for e in session.evidence[:10]]

    content = "\n".join(
        [
            "---",
            f"name: {name}",
            f"description: 由诊断会话《{session.title}》沉淀的排查 playbook",
            "---",
            "",
            f"# {session.title}",
            "",
            "## 适用场景",
            f"{session.title} 类故障（自动沉淀自会话 {session_id}）。",
            "",
            "## 症状",
            rca_summary,
            "",
            "## 排查步骤",
            *(f"{i + 1}. {line.lstrip('- ')}" for i, line in enumerate(evidence_lines) if line.strip()),
            "",
            "## 结论与处置",
            rca_summary,
            "",
            "## 修复步骤",
            *(f"{i + 1}. {step}" for i, step in enumerate(remedies)),
            "",
            "## 相关工具",
            *(f"- `{t}`" for t in tools),
            "",
        ]
    )
    return {"name": name, "content": content, "sessionId": session_id, "source": "template"}


async def generate_draft(session_id: str) -> dict[str, Any]:
    draft = build_template_draft(session_id)
    if os.environ.get("INFRAPILOT_FACTORY_USE_LLM") == "1":
        try:
            improved = await _generate_with_llm(session_id, draft)
            if improved:
                draft.update({"content": improved, "source": "llm"})
        except Exception as err:  # noqa: BLE001 - 回退模板
            print(f"[skill-factory] LLM 生成失败，回退模板: {err}")
    save_draft(draft)
    return draft


async def _generate_with_llm(session_id: str, draft: dict[str, Any]) -> Optional[str]:
    from . import llm

    completion = await llm.get_client().chat.completions.create(
        model=llm.reasoning_model(),
        messages=[
            {
                "role": "system",
                "content": "你是 SRE 知识工程师，请把一次故障诊断沉淀为标准 SKILL.md（含 --- frontmatter: name/description ---）。",
            },
            {"role": "user", "content": draft["content"]},
        ],
    )
    choices = getattr(completion, "choices", None) or []
    content = getattr(choices[0].message, "content", None) if choices else None
    return content or None


def save_draft(draft: dict[str, Any]) -> str:
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    path = DRAFTS_DIR / f"{draft['name']}.md"
    path.write_text(draft["content"], encoding="utf-8")
    return str(path)


def list_pending_drafts() -> list[dict[str, Any]]:
    if not DRAFTS_DIR.exists():
        return []
    out = []
    for path in sorted(DRAFTS_DIR.glob("*.md")):
        out.append({"name": path.stem, "content": path.read_text(encoding="utf-8"), "path": str(path)})
    return out


def validate_draft(content: str, expected_name: Optional[str] = None) -> None:
    frontmatter, _body = parse_frontmatter(content)
    name = frontmatter["name"]
    if expected_name and name != expected_name:
        raise ValueError(f"frontmatter.name ({name}) 与提交名称 ({expected_name}) 不一致")
    valid_tools = {f"{t.skill}__{t.name}" for t in ALL_TOOLS}
    referenced = {f"{m[0]}__{m[1]}" for m in TOOL_REF_RE.findall(content)}
    if os.environ.get("INFRAPILOT_FACTORY_STRICT_TOOLS") == "1":
        unknown = sorted(r for r in referenced if r not in valid_tools)
        if unknown:
            raise ValueError(f"引用了未注册的工具: {', '.join(unknown)}")


def approve_draft(name: str, content: Optional[str] = None) -> str:
    if not content:
        path = DRAFTS_DIR / f"{name}.md"
        if not path.exists():
            raise ValueError(f"待审核草稿不存在: {name}")
        content = path.read_text(encoding="utf-8")
    validate_draft(content, name)

    from .skill_packages import default_skills_dir

    target = default_skills_dir() / name
    if target.exists():
        raise ValueError(f"技能 {name} 已存在，先卸载或手动覆盖")
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(content, encoding="utf-8")
    db.upsert_skill_row({"name": name, "dir": str(target), "source": "skill-factory", "version": "1", "enabled": 1})
    skill_store.refresh()
    (DRAFTS_DIR / f"{name}.md").unlink(missing_ok=True)
    return name
