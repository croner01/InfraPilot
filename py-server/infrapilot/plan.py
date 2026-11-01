"""Plan / Remediation 输出解析 —— 对应 `server/src/agent/plan.ts`。"""

from __future__ import annotations

import json
import re
from typing import Any

PLAN_MARKER = "【诊断计划】"
REMEDIATION_MARKER = "【修复方案】"
RCA_MARKER = "【根因分析结论】"
HYPOTHESIS_MARKER = "【假设列表】"
COUNTER_MARKER = "【反证检查】"

_MARKERS = [PLAN_MARKER, REMEDIATION_MARKER, RCA_MARKER, HYPOTHESIS_MARKER, COUNTER_MARKER]


def _next_marker(text: str, start: int) -> int:
    candidates = [i for i in (text.find(m, start) for m in _MARKERS) if i >= 0]
    return min(candidates) if candidates else len(text)


def _clean_step(line: str) -> str:
    line = re.sub(r"^[-*•]\s*", "", line)
    line = re.sub(r"^\d+[.、)]\s*", "", line)
    return line.strip()


def extract_plan(text: str) -> list[str]:
    idx = text.find(PLAN_MARKER)
    if idx < 0:
        return []
    section = text[idx + len(PLAN_MARKER) : _next_marker(text, idx + len(PLAN_MARKER))]
    steps: list[str] = []
    for raw in section.split("\n"):
        line = raw.strip()
        if not line or line.startswith("```"):
            continue
        if not re.match(r"^[-*•]|\d+[.、)]", line):
            continue
        cleaned = _clean_step(line)
        if cleaned:
            steps.append(cleaned)
    return list(dict.fromkeys(steps))


def _parse_args(raw: str | None) -> dict[str, Any]:
    cleaned = (raw or "").strip()
    if not cleaned:
        return {}
    try:
        parsed = json.loads(cleaned if cleaned.startswith("{") else "{" + cleaned + "}")
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def extract_remediation(text: str) -> dict[str, Any] | None:
    idx = text.find(REMEDIATION_MARKER)
    if idx < 0:
        return None
    section = text[idx + len(REMEDIATION_MARKER) : _next_marker(text, idx + len(REMEDIATION_MARKER))]
    lines = [l.strip() for l in section.split("\n") if l.strip() and not l.strip().startswith("```")]

    steps: list[dict[str, Any]] = []
    summary = ""
    for line in lines:
        if not re.match(r"^[-*•]|\d+[.、)]", line):
            if re.match(r"^(摘要|概述)\s*[:：]", line):
                summary = re.sub(r"^[^:：]*[:：]\s*", "", line)
            continue
        description = _clean_step(line)
        match = re.search(r"([a-z][a-z0-9_]*)[._]{1,2}([a-z][a-z0-9_]*)(?:\(([^)]*)\))?", description)
        steps.append(
            {
                "description": description,
                "skill": match.group(1) if match else None,
                "tool": match.group(2) if match else None,
                "args": _parse_args(match.group(3)) if match else {},
                "risk": "high" if match else "medium",
            }
        )
    if not steps:
        return None
    return {"summary": summary or "Agent 生成的修复方案", "steps": steps}


def extract_hypotheses(text: str) -> list[dict[str, str]]:
    idx = text.find(HYPOTHESIS_MARKER)
    if idx < 0:
        return []
    section = text[idx + len(HYPOTHESIS_MARKER) : _next_marker(text, idx + len(HYPOTHESIS_MARKER))]
    result: list[dict[str, str]] = []
    for raw in section.split("\n"):
        line = raw.strip()
        if not line:
            continue
        match = re.match(r"^[-*•]\s*\[(active|confirmed|ruled_out)\]\s*(.+)$", line)
        if not match:
            continue
        statement = match.group(2).strip()
        if statement:
            result.append({"statement": statement, "status": match.group(1)})
    return result


def extract_rca(text: str) -> str:
    idx = text.find(RCA_MARKER)
    if idx < 0:
        return ""
    return text[idx + len(RCA_MARKER) : _next_marker(text, idx + len(RCA_MARKER))].strip()


def extract_counter_evidence(text: str) -> list[str]:
    idx = text.find(COUNTER_MARKER)
    if idx < 0:
        return []
    section = text[idx + len(COUNTER_MARKER) : _next_marker(text, idx + len(COUNTER_MARKER))]
    out: list[str] = []
    for raw in section.split("\n"):
        line = re.sub(r"^[-*•]\s*", "", raw.strip())
        if line and not line.startswith("```"):
            out.append(line)
    return out
