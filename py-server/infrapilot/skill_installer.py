"""Skill 包安装/卸载 —— 对应 `server/src/skills/packages/installer.ts`。

从 GitHub 稀疏克隆 SKILL.md 技能包到 `INFRAPILOT_SKILLS_DIR`，或列出精选技能。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

from . import db
from .skill_packages import default_skills_dir, load_skill_package, skill_store

_CURATED_PATH = Path(__file__).resolve().parent / "data" / "curated-skills.json"
_REPO_CURATED = Path(__file__).resolve().parent.parent.parent / "server" / "src" / "skills" / "packages" / "curated-skills.json"


def list_curated_skills() -> list[dict[str, Any]]:
    for path in (_CURATED_PATH, _REPO_CURATED):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return []


def copy_skill_into_place(src: str, target: str) -> str:
    if os.path.exists(target):
        raise RuntimeError(f"技能 {Path(target).name} 已存在，先卸载或手动覆盖")
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, target)
    load_skill_package(Path(target))  # 校验失败会抛错
    return Path(target).name


def install_from_github(opts: dict[str, Any]) -> str:
    repo = str(opts.get("repo") or "")
    sub_path = str(opts.get("path") or "")
    ref = str(opts.get("ref") or "main")
    dest_name = Path(sub_path).name
    target = default_skills_dir() / dest_name

    tmp = tempfile.mkdtemp(prefix="skill-install-")
    try:
        repo_url = (
            f"https://x-access-token:{opts['token']}@github.com/{repo}.git"
            if opts.get("token")
            else f"https://github.com/{repo}.git"
        )
        subprocess.run(
            ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", "-b", ref, repo_url, tmp],
            check=True,
            capture_output=True,
        )
        subprocess.run(["git", "-C", tmp, "sparse-checkout", "set", sub_path], check=True, capture_output=True)
        src = Path(tmp) / sub_path
        if not (src / "SKILL.md").exists():
            raise RuntimeError(f"路径 {sub_path} 下没有 SKILL.md")
        name = copy_skill_into_place(str(src), str(target))
        db.upsert_skill_row(
            {
                "name": dest_name,
                "dir": str(target),
                "source": f"github:{repo}:{sub_path}",
                "version": ref,
                "enabled": 1,
            }
        )
        skill_store.refresh()
        return name
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def uninstall_skill(name: str) -> None:
    if name.startswith("sre-"):
        raise RuntimeError(f"内置技能 {name} 禁止卸载")
    pkg = skill_store.get(name)
    if not pkg:
        raise RuntimeError(f"技能 {name} 未安装")
    shutil.rmtree(pkg.dir, ignore_errors=True)
    skill_store.remove(name)
