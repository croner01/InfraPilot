"""Skill 包管理 API —— 对应 `server/src/routes/skills.ts` 与 api.ts 的 drawio 端点。"""

from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import Response

from ..skill_installer import install_from_github, list_curated_skills, uninstall_skill
from ..skill_packages import skill_store
from ..skills import drawio

skills_router = APIRouter()


def _list_skills_payload() -> list[dict[str, Any]]:
    skill_store.init()
    return [
        {
            "name": s.name,
            "description": s.frontmatter.get("description"),
            "enabled": s.enabled,
            "references": s.references,
            "scripts": s.scripts,
            "assets": s.assets,
            "source": s.source,
            "version": s.version,
        }
        for s in skill_store.list()
    ]


# -------------------- Draw.io（先于 /{name} 注册，避免被动态段吞掉） --------------------


@skills_router.post("/drawio/generate")
async def drawio_generate(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    relations = body.get("log_relations")
    if not isinstance(relations, list) or not relations:
        raise HTTPException(status_code=400, detail="log_relations 不能为空数组")
    try:
        output_path = drawio.sanitize_diagram_path(f"{int(time.time() * 1000)}-flowchart.drawio")
        result = await drawio.execute(
            "generate_flowchart",
            {"log_relations": relations, "output_path": output_path, "title": body.get("title") or "日志关系流程图"},
        )
        if not result.success:
            raise HTTPException(status_code=500, detail=result.error or "生成失败")
        xml = Path(output_path).read_text(encoding="utf-8")
        return {"ok": True, "xml": xml, **(result.data or {})}
    except HTTPException:
        raise
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(err)) from err


@skills_router.post("/drawio/export")
async def drawio_export(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    input_path, fmt = body.get("input_path"), body.get("format")
    if not input_path or not fmt:
        raise HTTPException(status_code=400, detail="input_path 和 format 必填")
    if fmt not in ("png", "svg", "pdf"):
        raise HTTPException(status_code=400, detail="format 必须是 png/svg/pdf 之一")
    try:
        safe_input = drawio.sanitize_diagram_path(str(input_path))
        output_path = safe_input[:-len(".drawio")] + f".{fmt}" if safe_input.endswith(".drawio") else f"{safe_input}.{fmt}"
        result = await drawio.execute("export_diagram", {"input_path": safe_input, "output_path": output_path, "format": fmt})
        if not result.success:
            raise HTTPException(status_code=500, detail=result.error or "导出失败")
        data = base64.b64encode(Path(output_path).read_bytes()).decode("ascii")
        return {"ok": True, "output_path": output_path, "format": fmt, "data": data}
    except HTTPException:
        raise
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(err)) from err


@skills_router.get("/drawio/download")
def drawio_download(request: Request) -> Response:
    try:
        file_path = drawio.sanitize_diagram_path(request.query_params.get("path") or "")
        data = Path(file_path).read_bytes()
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(err)) from err
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    mime = (
        "image/svg+xml"
        if ext == "svg"
        else "application/pdf"
        if ext == "pdf"
        else "application/xml"
        if ext == "drawio"
        else "image/png"
    )
    return Response(
        content=data,
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{Path(file_path).name}"'},
    )


# -------------------- Skill Packages --------------------


@skills_router.get("")
@skills_router.get("/")
def list_skills() -> dict[str, Any]:
    try:
        return {"skills": _list_skills_payload()}
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(err)) from err


@skills_router.get("/curated")
def curated_skills() -> dict[str, Any]:
    return {"skills": list_curated_skills()}


@skills_router.post("/install")
def install_skill(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    if not body.get("repo") or not body.get("path"):
        raise HTTPException(status_code=400, detail="repo 与 path 必填")
    try:
        name = install_from_github(
            {
                "repo": str(body["repo"]),
                "path": str(body["path"]),
                "ref": str(body["ref"]) if body.get("ref") else None,
                "token": str(body["token"]) if body.get("token") else None,
            }
        )
        return {"ok": True, "name": name}
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(err)) from err


@skills_router.patch("/{name}")
def set_skill_enabled(name: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        skill_store.set_enabled(name, bool((payload or {}).get("enabled")))
        return {"ok": True}
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(err)) from err


@skills_router.delete("/{name}")
def remove_skill(name: str) -> dict[str, Any]:
    try:
        uninstall_skill(name)
        return {"ok": True}
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(err)) from err


# -------------------- Skill Factory（P1，先于 /{name} 之外的动态段注册） --------------------


@skills_router.get("/factory/sessions")
def factory_sessions() -> dict[str, Any]:
    from .. import skill_factory

    return {"sessions": skill_factory.list_candidate_sessions()}


@skills_router.post("/factory/generate")
async def factory_generate(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import skill_factory

    session_id = str((payload or {}).get("sessionId") or "")
    if not session_id:
        raise HTTPException(status_code=400, detail="sessionId 必填")
    try:
        return {"ok": True, **await skill_factory.generate_draft(session_id)}
    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err


@skills_router.get("/factory/pending")
def factory_pending() -> dict[str, Any]:
    from .. import skill_factory

    return {"drafts": skill_factory.list_pending_drafts()}


@skills_router.post("/factory/approve")
def factory_approve(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import skill_factory

    body = payload or {}
    name = str(body.get("name") or "")
    if not name:
        raise HTTPException(status_code=400, detail="name 必填")
    try:
        installed = skill_factory.approve_draft(name, body.get("content"))
        return {"ok": True, "name": installed}
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@skills_router.post("/factory/reject")
def factory_reject(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    from .. import skill_factory

    name = str((payload or {}).get("name") or "")
    path = skill_factory.DRAFTS_DIR / f"{name}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="draft not found")
    path.unlink()
    return {"ok": True}
