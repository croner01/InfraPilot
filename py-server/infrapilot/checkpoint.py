"""Agent Checkpoint 持久化 —— 对应 `server/src/agent/checkpoint.ts`。"""

from __future__ import annotations

from typing import Optional

from . import db
from .models import AgentCheckpoint


def save_checkpoint(checkpoint: AgentCheckpoint) -> None:
    db.save_checkpoint_db(checkpoint.sessionId, checkpoint.model_dump_json())


def load_checkpoint(session_id: str) -> Optional[AgentCheckpoint]:
    row = db.load_checkpoint_db(session_id)
    if not row:
        return None
    try:
        return AgentCheckpoint.model_validate_json(row["checkpoint_json"])
    except ValueError:
        return None


def delete_checkpoint(session_id: str) -> None:
    db.delete_checkpoint_db(session_id)
