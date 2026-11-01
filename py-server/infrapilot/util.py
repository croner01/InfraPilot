"""小工具函数。"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional


def kill_quietly(proc: Optional[Any]) -> None:
    """尽力终止子进程；已退出/不存在的进程静默跳过。

    用于任务被中断（task.cancel）或超时的场景，避免命令在后台继续执行。
    """
    if proc is None or getattr(proc, "returncode", 0) is not None:
        return
    try:
        proc.kill()
    except (ProcessLookupError, RuntimeError, OSError):
        pass


def now_iso() -> str:
    """与 JS `new Date().toISOString()` 一致的 UTC 毫秒时间戳。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def new_id() -> str:
    return str(uuid.uuid4())
