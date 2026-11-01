"""证据摘要 —— 把工具返回的原始 payload 压成一句人类可读的「发现了什么」。

证据卡片（EvidenceList）与假设/结论引用都展示这条摘要。只写工具签名
（如 `k8s.list_pods({"namespace": "ems"})`）看不出结论,因此这里按返回结构
提取计数 / 状态等要点,无法概括时再退回签名。
"""

from __future__ import annotations

import json
from typing import Any

_MAX_LEN = 200
_ARGS_MAX = 80
_SCALAR_KEYS = ("status", "reason", "phase", "state", "message", "error", "name", "nodeName", "pod_name")


def summarize_evidence(skill: str, tool: str, args: dict[str, Any], data: Any) -> str:
    """生成证据摘要：`技能.工具(入参) → 要点`。"""
    signature = f"{skill}.{tool}({_clip(json.dumps(args or {}, ensure_ascii=False), _ARGS_MAX)})"
    digest = _digest(data)
    text = f"{signature} → {digest}" if digest else signature
    return _clip(text, _MAX_LEN)


def _digest(data: Any) -> str | None:
    if data is None:
        return None
    if isinstance(data, list):
        return f"{len(data)} 项"
    if not isinstance(data, dict):
        return _clip(str(data), 60)

    parts: list[str] = []

    total = data.get("total", data.get("count"))
    if isinstance(total, (int, float)) and not isinstance(total, bool):
        parts.append(f"共 {int(total)} 条")

    summary = data.get("summary")
    if isinstance(summary, dict):
        rendered = _render_counts(summary)
        if rendered:
            parts.append(rendered)

    status = data.get("status")
    if isinstance(status, str) and status:
        bits = [f"status={status}"]
        if isinstance(data.get("ready"), bool):
            bits.append(f"ready={data['ready']}")
        restarts = data.get("restartCount")
        if isinstance(restarts, (int, float)) and restarts:
            bits.append(f"restarts={int(restarts)}")
        last = data.get("lastState")
        if isinstance(last, dict) and last.get("reason"):
            bits.append(f"lastState={last['reason']}(exit {last.get('exitCode')})")
        parts.append(", ".join(bits))

    if not parts:
        for key in _SCALAR_KEYS:
            value = data.get(key)
            if isinstance(value, (str, int, float, bool)) and value not in (None, ""):
                parts.append(f"{key}={_clip(str(value), 60)}")
            if len(parts) >= 3:
                break

    if not parts:
        nested = [f"{k}:{_render_inline(v)}" for k, v in data.items() if isinstance(v, (list, dict)) and v]
        parts.extend(nested[:2])

    return _clip("; ".join(dict.fromkeys(parts)), _MAX_LEN) or None


def _render_counts(counts: dict[str, Any]) -> str:
    bits: list[str] = []
    for key, value in list(counts.items())[:6]:
        if isinstance(value, dict):
            inner = ", ".join(f"{k} {v}" for k, v in list(value.items())[:6])
            bits.append(f"{key}: {inner}" if inner else str(key))
        elif isinstance(value, (int, float, str, bool)) and value not in (None, ""):
            bits.append(f"{key} {value}")
    return "; ".join(bits)


def _render_inline(value: Any) -> str:
    if isinstance(value, list):
        return f"{len(value)} 项"
    return f"{len(value)} 字段"


def _clip(text: str, limit: int) -> str:
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else f"{flat[: limit - 1]}…"
