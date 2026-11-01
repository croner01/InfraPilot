"""定时任务框架（P2）—— 无第三方依赖（stdlib asyncio + 极简 cron 解析）。

对应差距分析 P2「定时任务框架」。与 `server/`（Node 版无此能力）不同，Python 版新增：
- `schedules` 表持久化任务（cron 表达式 / `@every 30m` 间隔）；
- 后台 asyncio 轮询循环（`INFRAPILOT_SCHEDULER=0` 可关闭，`INFRAPILOT_SCHEDULER_TICK` 调间隔）；
- 到期任务自动创建会话并触发一次 Agent 诊断（复用 orchestrator）；
- 手动触发（`POST /api/schedules/:id/run`）与任务 CRUD 路由。

不引入 apscheduler：该依赖在部署环境未预装，且最小实现足以覆盖"按 cron 自动跑诊断"。
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from . import db, sessions
from .util import new_id, now_iso

_MINUTE = 60.0

_ALIASES = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
}

_DOW_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
_MONTH_NAMES = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}

_INTERVAL_RE = re.compile(r"^@every\s+(\d+)\s*(s|m|h|d)$", re.IGNORECASE)


def _norm_value(token: str, aliases: dict[str, int]) -> int:
    token = token.strip().lower()
    if token in aliases:
        return aliases[token]
    return int(token)


def _parse_field(field: str, lo: int, hi: int, aliases: Optional[dict[str, int]] = None) -> set[int]:
    aliases = aliases or {}
    values: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            raise ValueError(f"cron 字段非法: {field!r}")
        step = 1
        if "/" in part:
            part, _, step_raw = part.partition("/")
            step = int(step_raw)
            if step <= 0:
                raise ValueError(f"cron step 必须为正: {field!r}")
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part[1:]:
            a, _, b = part.partition("-")
            start = _norm_value(a, aliases)
            end = _norm_value(b, aliases)
        else:
            start = end = _norm_value(part, aliases)
        if start > end:
            start, end = end, start
        if start < lo or end > hi:
            raise ValueError(f"cron 字段超范围 [{lo},{hi}]: {field!r}")
        values.update(range(start, end + 1, step))
    if not values:
        raise ValueError(f"cron 字段为空: {field!r}")
    return values


def parse_cron(expr: str) -> dict[str, Any]:
    """解析 cron 表达式或 `@every` 间隔，返回调度描述。"""
    raw = (expr or "").strip()
    if not raw:
        raise ValueError("cron 表达式为空")
    interval = _INTERVAL_RE.match(raw)
    if interval:
        value = int(interval.group(1))
        unit = interval.group(2).lower()
        seconds = value * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
        if seconds <= 0:
            raise ValueError("间隔必须大于 0")
        return {"kind": "interval", "seconds": seconds}
    if raw.startswith("@"):
        if raw.lower() not in _ALIASES:
            raise ValueError(f"不支持的特殊表达式: {raw}")
        raw = _ALIASES[raw.lower()]
    fields = raw.split()
    if len(fields) != 5:
        raise ValueError("cron 表达式需为 5 段: 分 时 日 月 周")
    minute, hour, dom, month, dow = fields
    return {
        "kind": "cron",
        # 对 weekday：把 7 归一化为 0（Sunday），与 cron 惯例一致
        "minute": _parse_field(minute, 0, 59),
        "hour": _parse_field(hour, 0, 23),
        "dom": _parse_field(dom, 1, 31),
        "month": _parse_field(month, 1, 12, _MONTH_NAMES),
        "dow": {0 if v == 7 else v for v in _parse_field(dow, 0, 7, _DOW_NAMES)},
    }


def _matches(parsed: dict[str, Any], moment: datetime) -> bool:
    # cron 语义：dom 与 dow 同时受限时取"或"，否则取"与"（与主流实现一致）
    dom_restricted = parsed["dom"] != set(range(1, 32))
    dow_restricted = parsed["dow"] != set(range(0, 7))
    dom_ok = moment.day in parsed["dom"]
    # Python weekday(): Monday=0；cron 约定 Sunday=0
    dow = (moment.weekday() + 1) % 7
    dow_ok = dow in parsed["dow"]
    if dom_restricted and dow_restricted:
        day_ok = dom_ok or dow_ok
    else:
        day_ok = dom_ok and dow_ok
    return (
        moment.minute in parsed["minute"]
        and moment.hour in parsed["hour"]
        and moment.month in parsed["month"]
        and day_ok
    )


def next_run(expr: str, after: Optional[datetime] = None, *, max_days: int = 366) -> datetime:
    """计算下一次触发时间（本地时区，秒级归零）。"""
    parsed = parse_cron(expr)
    base = (after or datetime.now()).replace(second=0, microsecond=0)
    if parsed["kind"] == "interval":
        return base + timedelta(seconds=parsed["seconds"])
    candidate = base + timedelta(minutes=1)
    limit = base + timedelta(days=max_days)
    while candidate <= limit:
        if _matches(parsed, candidate):
            return candidate
        candidate += timedelta(minutes=1)
    raise ValueError(f"cron 在 {max_days} 天内没有匹配时间: {expr}")


def validate(expr: str) -> None:
    parse_cron(expr)


# -------------------- 运行时调度 --------------------


def _default_tick() -> float:
    try:
        return max(1.0, float(os.environ.get("INFRAPILOT_SCHEDULER_TICK") or 15))
    except ValueError:
        return 15.0


class Scheduler:
    """后台轮询循环：到期任务 → 创建会话 → 触发一次诊断。"""

    def __init__(self, tick: Optional[float] = None) -> None:
        self.tick = tick or _default_tick()
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self.running = False

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._loop())
        self.running = True

    async def stop(self) -> None:
        if self._task is None:
            self.running = False
            return
        self._stop.set()
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - 关闭时吞掉任何异常
            pass
        self._task = None
        self.running = False

    async def _loop(self) -> None:
        # 启动时为缺失 next_run_at 的任务补齐调度时间
        for job in db.list_schedules():
            if job["enabled"] and not job.get("next_run_at"):
                try:
                    db.update_schedule(job["id"], {"next_run_at": next_run(job["cron"]).isoformat()})
                except Exception as err:  # noqa: BLE001
                    db.update_schedule(job["id"], {"last_error": f"cron 非法: {err}"})
        while not self._stop.is_set():
            try:
                await self.run_due()
            except Exception as err:  # noqa: BLE001 - 单次 tick 失败不应终止循环
                print(f"[scheduler] tick 失败: {err}")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.tick)
            except asyncio.TimeoutError:
                continue

    async def run_due(self) -> list[dict[str, Any]]:
        now = datetime.now()
        fired: list[dict[str, Any]] = []
        for job in db.list_schedules():
            if not job["enabled"]:
                continue
            due_raw = job.get("next_run_at")
            if not due_raw:
                try:
                    db.update_schedule(job["id"], {"next_run_at": next_run(job["cron"]).isoformat()})
                except Exception as err:  # noqa: BLE001
                    db.update_schedule(job["id"], {"last_error": f"cron 非法: {err}"})
                continue
            try:
                due = datetime.fromisoformat(due_raw)
            except ValueError:
                due = now
            if due <= now:
                fired.append(await self.trigger(job["id"]))
        return fired

    async def trigger(self, schedule_id: str, *, prompt: Optional[str] = None) -> dict[str, Any]:
        """立即执行任务（供到期轮询与手动触发共用）。"""
        job = db.get_schedule(schedule_id)
        if job is None:
            raise ValueError("schedule not found")
        now = datetime.now()
        run_count = int(job.get("run_count") or 0) + 1
        error: Optional[str] = None
        session_id: Optional[str] = None
        try:
            session = sessions.create_session(job["name"] or f"定时任务 {job['cron']}", job.get("user_id"))
            session_id = session.id
            text = prompt or job["prompt"]
            sessions.emit_event(session_id, "user_message", {"message": text, "role": "user", "source": "scheduler"})
            asyncio.create_task(_run_diagnosis(session_id, text))
        except Exception as err:  # noqa: BLE001
            error = str(err)
        try:
            upcoming = next_run(job["cron"], now)
        except ValueError:
            upcoming = None
        updated = db.update_schedule(
            schedule_id,
            {
                "last_run_at": now.isoformat(),
                "next_run_at": upcoming.isoformat() if upcoming else None,
                "run_count": run_count,
                "last_session_id": session_id,
                "last_error": error,
                "updated_at": now_iso(),
            },
        )
        return {"ok": error is None, "schedule": updated, "sessionId": session_id, "error": error}


async def _run_diagnosis(session_id: str, prompt: str) -> None:
    from .orchestrator import start_agent_turn

    try:
        await start_agent_turn(session_id, prompt)
    except Exception as err:  # noqa: BLE001 - 自动运行失败只记录，不影响调度
        print(f"[scheduler] 任务执行失败: {err}")


scheduler = Scheduler()


def enabled() -> bool:
    return os.environ.get("INFRAPILOT_SCHEDULER", "1") not in ("0", "false", "False", "")
