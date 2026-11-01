"""会话产物 API（P3）—— `/api/artifacts/*`。

差距分析 §3 #15「Artifact 文件管理（会话产物下载）」。Node 版缺失；新增路由为追加，
不影响既有前端契约。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response

from .. import artifacts

artifacts_router = APIRouter()


@artifacts_router.get("")
def list_artifacts(sessionId: Optional[str] = Query(default=None)) -> dict[str, Any]:
    items = artifacts.list_for_session(sessionId) if sessionId else artifacts.list_all()
    return {"artifacts": items, "count": len(items)}


@artifacts_router.post("")
def register_artifact(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    path = str(body.get("path") or "")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    artifact = artifacts.register(
        path,
        session_id=body.get("sessionId"),
        name=body.get("name"),
        kind=body.get("kind") or "manual",
    )
    if artifact is None:
        raise HTTPException(status_code=400, detail="文件不存在或不在允许的产物目录内")
    return {"ok": True, "artifact": artifact}


@artifacts_router.get("/{artifact_id}/download")
def download_artifact(artifact_id: str) -> Response:
    row = artifacts.get(artifact_id)
    path = artifacts.file_path(artifact_id)
    if row is None:
        raise HTTPException(status_code=404, detail="artifact not found")
    if path is None:
        raise HTTPException(status_code=404, detail="artifact file missing")
    return Response(
        content=Path(path).read_bytes(),
        media_type=row["mime"],
        headers={"Content-Disposition": f'attachment; filename="{row["name"]}"'},
    )


@artifacts_router.delete("/{artifact_id}")
def delete_artifact(artifact_id: str) -> dict[str, Any]:
    if not artifacts.delete(artifact_id):
        raise HTTPException(status_code=404, detail="artifact not found")
    return {"ok": True}
