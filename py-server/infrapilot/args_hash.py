"""Args Hash —— 审批令牌与 tool+args 绑定（对应 `gateway/argsHash.ts`）。"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonicalize(value: Any) -> Any:
    if value is None or not isinstance(value, (dict, list)):
        return value
    if isinstance(value, list):
        return [canonicalize(v) for v in value]
    return {key: canonicalize(value[key]) for key in sorted(value.keys())}


def compute_args_hash(skill: str, tool: str, args: dict[str, Any]) -> str:
    canonical = json.dumps(canonicalize(args), ensure_ascii=False, separators=(",", ":"))
    payload = f"{skill}:{tool}:{canonical}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
