"""P2 定时任务框架：cron 解析 + 任务持久化/触发（纯离线，触发路径打桩）。"""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from infrapilot import db, scheduler
from infrapilot.util import new_id, now_iso


def test_next_run_daily_cron():
    after = datetime(2026, 1, 1, 5, 0)
    assert scheduler.next_run("0 3 * * *", after) == datetime(2026, 1, 2, 3, 0)


def test_next_run_weekday_monday():
    after = datetime(2026, 1, 1, 5, 0)  # 周四
    assert scheduler.next_run("0 9 * * 1", after) == datetime(2026, 1, 5, 9, 0)


def test_next_run_sunday_zero():
    after = datetime(2026, 1, 1, 5, 0)
    assert scheduler.next_run("0 0 * * 0", after) == datetime(2026, 1, 4, 0, 0)


def test_next_run_interval_every():
    after = datetime(2026, 1, 1, 5, 7, 30)
    assert scheduler.next_run("@every 30m", after) == datetime(2026, 1, 1, 5, 37)


def test_next_run_hourly_alias_and_step():
    after = datetime(2026, 1, 1, 5, 7)
    assert scheduler.next_run("@hourly", after) == datetime(2026, 1, 1, 6, 0)
    assert scheduler.next_run("*/15 * * * *", after) == datetime(2026, 1, 1, 5, 15)


def test_invalid_cron_raises():
    for bad in ["", "not a cron", "@every 0m", "* * * *", "60 * * * *"]:
        with pytest.raises((ValueError, TypeError)):
            scheduler.next_run(bad)


def test_schedule_crud_and_trigger(monkeypatch):
    async def _noop(session_id: str, prompt: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(scheduler, "_run_diagnosis", _noop)

    now = now_iso()
    job_id = new_id()
    db.insert_schedule(
        {
            "id": job_id,
            "name": "nightly-check",
            "cron": "@every 10m",
            "prompt": "检查节点状态",
            "enabled": True,
            "skills": ["k8s"],
            "created_at": now,
            "updated_at": now,
            "next_run_at": None,
            "run_count": 0,
        }
    )
    job = db.get_schedule(job_id)
    assert job and job["enabled"] is True and job["skills"] == ["k8s"]
    assert job["run_count"] == 0

    result = asyncio.run(scheduler.scheduler.trigger(job_id))
    assert result["ok"] is True
    assert result["sessionId"]
    updated = db.get_schedule(job_id)
    assert updated["run_count"] == 1
    assert updated["last_session_id"] == result["sessionId"]
    assert updated["next_run_at"]

    assert db.update_schedule(job_id, {"enabled": False})["enabled"] is False
    assert db.delete_schedule(job_id) is True
    assert db.get_schedule(job_id) is None
