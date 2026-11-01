"""会话产物（Artifact）管理（P3）—— 对应差距分析 §3 #15。

把诊断过程中产生的文件（drawio 流程图/导出图、沙箱脚本输出、未来上传件）登记到会话维度，
提供列表与下载，供前端"会话产物"区域或 ChatOps 交付使用。

安全：只登记/读取**白名单根目录**下的文件（`data/diagrams`、`data/sandbox`、`data/artifacts`），
路径一律 `realpath` 校验，避免目录穿越。
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
from pathlib import Path
from typing import Any, Optional

from . import db
from .settings import DATA_DIR
from .util import new_id, now_iso

ARTIFACTS_DIR = (DATA_DIR / "artifacts").resolve()
DIAGRAMS_DIR = (DATA_DIR / "diagrams").resolve()
SANDBOX_DIR = (DATA_DIR / "sandbox").resolve()

_MIME_OVERRIDES = {
    ".drawio": "application/xml",
    ".mxfile": "application/xml",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".log": "text/plain",
    ".txt": "text/plain",
}


def allowed_roots() -> list[Path]:
    return [ARTIFACTS_DIR, DIAGRAMS_DIR, SANDBOX_DIR]


def _under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def resolve_safe(path: str) -> Path:
    """把用户/工具给出的路径解析为白名单根目录下的绝对路径。"""
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = ARTIFACTS_DIR / candidate
    resolved = candidate.resolve()
    if not any(_under(resolved, root) for root in allowed_roots()):
        raise ValueError(f"产物路径不在允许目录内: {path}")
    return resolved


def mime_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _MIME_OVERRIDES:
        return _MIME_OVERRIDES[ext]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def public_artifact(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "sessionId": row.get("session_id"),
        "name": row["name"],
        "path": row["path"],
        "mime": row["mime"],
        "size": int(row.get("size") or 0),
        "kind": row.get("kind"),
        "sha256": row.get("sha256"),
        "createdAt": row["created_at"],
        "downloadUrl": f"/api/artifacts/{row['id']}/download",
    }


def register(
    path: str,
    *,
    session_id: Optional[str] = None,
    name: Optional[str] = None,
    kind: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """登记一个已存在的文件；文件不存在或越界时返回 None（不抛错，避免影响主链路）。"""
    try:
        resolved = resolve_safe(path)
    except ValueError:
        return None
    if not resolved.is_file():
        return None
    existing = db.get_artifact_by_path(session_id, str(resolved))
    if existing:
        return public_artifact(existing)
    data = resolved.read_bytes()
    row = {
        "id": new_id(),
        "session_id": session_id,
        "name": name or resolved.name,
        "path": str(resolved),
        "mime": mime_for(resolved),
        "size": len(data),
        "kind": kind,
        "sha256": hashlib.sha256(data).hexdigest()[:16],
        "created_at": now_iso(),
    }
    db.insert_artifact(row)
    return public_artifact(row)


def list_for_session(session_id: str) -> list[dict[str, Any]]:
    return [public_artifact(r) for r in db.list_artifacts(session_id)]


def list_all() -> list[dict[str, Any]]:
    return [public_artifact(r) for r in db.list_artifacts(None)]


def get(artifact_id: str) -> Optional[dict[str, Any]]:
    row = db.get_artifact(artifact_id)
    return public_artifact(row) if row else None


def file_path(artifact_id: str) -> Optional[Path]:
    row = db.get_artifact(artifact_id)
    if not row:
        return None
    try:
        resolved = resolve_safe(row["path"])
    except ValueError:
        return None
    return resolved if resolved.is_file() else None


def delete(artifact_id: str, *, remove_file: bool = True) -> bool:
    row = db.get_artifact(artifact_id)
    if not row:
        return False
    if remove_file:
        try:
            path = resolve_safe(row["path"])
            if path.is_file():
                path.unlink()
        except (ValueError, OSError):
            pass
    return db.delete_artifact(artifact_id)


# -------------------- 从工具结果自动登记 --------------------


def _candidates(skill: str, data: Any) -> list[tuple[str, Optional[str]]]:
    """从工具返回结构中挑出产物文件：path 可能是绝对路径或相对沙箱工作目录。"""
    if not isinstance(data, dict):
        return []
    out: list[tuple[str, Optional[str]]] = []
    workdir = data.get("workdir")
    for key, kind in (("output_path", skill), ("input_path", skill), ("file", skill), ("path", skill)):
        value = data.get(key)
        if isinstance(value, str) and value:
            out.append((value, kind))
    for item in data.get("files") or []:
        if isinstance(item, str) and item:
            joined = os.path.join(workdir, item) if workdir and not os.path.isabs(item) else item
            out.append((joined, f"{skill}-output"))
    # drawio 批量返回：{outputs: [{output_path: ...}]}
    for item in data.get("outputs") or []:
        if isinstance(item, dict) and isinstance(item.get("output_path"), str):
            out.append((item["output_path"], skill))
    return out


def register_from_tool_result(session_id: str, skill: str, tool: str, data: Any) -> list[dict[str, Any]]:
    """工具执行成功后自动登记产物；任何异常都不应影响工具主链路。"""
    registered: list[dict[str, Any]] = []
    try:
        for path, kind in _candidates(skill, data):
            artifact = register(path, session_id=session_id, kind=kind or tool)
            if artifact:
                registered.append(artifact)
    except Exception as err:  # noqa: BLE001
        print(f"[artifacts] 自动登记失败 ({skill}.{tool}): {err}")
    return registered
