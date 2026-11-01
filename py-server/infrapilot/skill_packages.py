"""Skill 包（SKILL.md）加载 / 索引 / 按轮选择 —— 对应 `skills/packages/{loader,registry,select}.ts`。"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from . import db
from .embedder import InMemoryEmbeddingStore, create_embedder

ALWAYS_ON_SKILLS = ["sre-systematic-debugging"]
MAX_SKILLS_PER_TURN = 4
# 相关性阈值：TF-IDF 对任何中文 query 都会给出非零分，用 0 等于不设门槛，
# 会把无关技能（如某集群专用的存储技能）注入 prompt 并把排查带偏。
MIN_SKILL_SCORE = 0.12

_FRONTMATTER_RE = re.compile(r"^([a-zA-Z0-9_-]+):\s*(.*)$")


def default_skills_dir() -> Path:
    if os.environ.get("INFRAPILOT_SKILLS_DIR"):
        return Path(os.environ["INFRAPILOT_SKILLS_DIR"]).resolve()
    return Path(__file__).resolve().parent.parent / "skills"


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        raise ValueError("SKILL.md 缺少 --- frontmatter 起始标记")
    end = text.find("\n---", 4)
    if end == -1:
        raise ValueError("SKILL.md frontmatter 未闭合")
    raw = text[4:end]
    body = re.sub(r"^\n", "", text[end + 4 :])
    frontmatter = {"name": "", "description": ""}
    for line in raw.split("\n"):
        m = _FRONTMATTER_RE.match(line)
        if not m:
            continue
        value = m.group(2).strip().strip("\"'")
        if m.group(1) in frontmatter:
            frontmatter[m.group(1)] = value
    if not frontmatter["name"] or not frontmatter["description"]:
        raise ValueError("SKILL.md frontmatter 必须包含 name 与 description")
    return frontmatter, body


def _list_dir(base: Path) -> list[str]:
    try:
        return [p.name for p in sorted(base.iterdir()) if not p.name.startswith(".")]
    except OSError:
        return []


@dataclass
class SkillPackage:
    name: str
    dir: str
    frontmatter: dict[str, str]
    body: str
    references: list[str] = field(default_factory=list)
    scripts: list[str] = field(default_factory=list)
    assets: list[str] = field(default_factory=list)
    source: Optional[str] = None
    version: Optional[str] = None
    enabled: bool = True


def load_skill_package(directory: Path) -> SkillPackage:
    skill_dir = directory.resolve()
    name = skill_dir.name
    raw = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    frontmatter, body = parse_frontmatter(raw)
    if frontmatter["name"] != name:
        raise ValueError(f"技能目录名 {name} 与 frontmatter.name {frontmatter['name']} 不一致")
    return SkillPackage(
        name=name,
        dir=str(skill_dir),
        frontmatter=frontmatter,
        body=body,
        references=[f"references/{p}" for p in _list_dir(skill_dir / "references")],
        scripts=[f"scripts/{p}" for p in _list_dir(skill_dir / "scripts")],
        assets=[f"assets/{p}" for p in _list_dir(skill_dir / "assets")],
    )


def scan_skill_packages(base: Optional[Path] = None) -> list[SkillPackage]:
    root = base or default_skills_dir()
    packages: list[SkillPackage] = []
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return packages
    for entry in entries:
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        try:
            packages.append(load_skill_package(entry))
        except (OSError, ValueError):
            continue
    return packages


def skill_to_text(skill: SkillPackage) -> str:
    return "\n".join([f"Skill: {skill.name}", f"Description: {skill.frontmatter['description']}", skill.body])


class SkillStore:
    def __init__(self) -> None:
        self._embedder = create_embedder()
        self._index: InMemoryEmbeddingStore[SkillPackage] = InMemoryEmbeddingStore()
        self._by_name: dict[str, SkillPackage] = {}
        self._initialized = False

    def init(self) -> None:
        if self._initialized:
            return
        self._embedder = create_embedder()
        self._index.clear()
        self._by_name.clear()

        packages = scan_skill_packages()
        state = {row["name"]: row["enabled"] for row in db.list_skill_rows()}
        self._embedder.fit([skill_to_text(p) for p in packages])
        for p in packages:
            enabled = state.get(p.name, 1) == 1
            pkg = SkillPackage(**{**p.__dict__, "enabled": enabled})
            self._by_name[pkg.name] = pkg
            if enabled:
                self._index.add(pkg.name, pkg, self._embedder.embed(skill_to_text(pkg)))
            if p.name not in state:
                db.upsert_skill_row({"name": p.name, "dir": p.dir, "enabled": 1})
        self._initialized = True

    def recall(self, query: str, top_k: int = 3) -> list[tuple[SkillPackage, float]]:
        self.init()
        return [(r.item, r.score) for r in self._index.search(self._embedder.embed(query), top_k, 0.0)]

    def get(self, name: str) -> Optional[SkillPackage]:
        return self._by_name.get(name)

    def list(self) -> list[SkillPackage]:
        return list(self._by_name.values())

    def refresh(self) -> None:
        self._initialized = False
        self.init()

    def set_enabled(self, name: str, enabled: bool) -> None:
        p = self._by_name.get(name)
        db.upsert_skill_row({"name": name, "dir": p.dir if p else name, "enabled": 1 if enabled else 0})
        db.set_skill_enabled_row(name, enabled)
        self.refresh()

    def remove(self, name: str) -> None:
        db.delete_skill_row(name)
        self.refresh()


skill_store = SkillStore()


def to_skill_doc(p: SkillPackage) -> dict[str, str]:
    return {"name": p.name, "description": p.frontmatter["description"], "body": p.body}


def select_skills_for_turn(query: str, previous: list[str]) -> list[SkillPackage]:
    skill_store.init()
    recalled = skill_store.recall(query, 3)
    positive = [(p, s) for p, s in recalled if s >= MIN_SKILL_SCORE]
    by_name = {p.name: p for p in skill_store.list()}

    always_on = [by_name[n] for n in ALWAYS_ON_SKILLS if n in by_name and by_name[n].enabled]
    relevant = {p.name for p in always_on} | {p.name for p, _ in positive}

    ordered: list[Optional[SkillPackage]] = [
        *always_on,
        *[by_name.get(n) for n in previous],
        *[by_name.get(p.name) for p, _ in positive],
    ]

    merged: list[SkillPackage] = []
    seen: set[str] = set()
    for p in ordered:
        if p is None or not p.enabled or p.name in seen:
            continue
        # previous 中的技能只有仍与本轮 query 相关才保留
        if p.name in previous and p.name not in relevant:
            continue
        seen.add(p.name)
        merged.append(p)
        if len(merged) >= MAX_SKILLS_PER_TURN:
            break
    return merged
