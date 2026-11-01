"""Skill Registry —— 工具注册与 RAG 检索式路由（对应 `skills/registry/skillRegistry.ts`）。"""

from __future__ import annotations

from dataclasses import dataclass

from .embedder import InMemoryEmbeddingStore, SearchResult, create_embedder
from .models import ToolDef

ALWAYS_AVAILABLE_TOOLS = {
    "linux__get_cpu_usage",
    "linux__get_memory_info",
    "linux__get_process_info",
    "k8s__list_clusters",
    "k8s__list_pods",
    "k8s__describe_pod",
    "k8s__get_events",
    "elk__search_logs",
    "clickhouse__search_logs",
}


def tool_key(tool: ToolDef) -> str:
    return f"{tool.skill}__{tool.name}"


def tool_to_text(tool: ToolDef) -> str:
    params = ", ".join((tool.parameters.get("properties") or {}).keys())
    return "\n".join(
        [
            f"Skill: {tool.skill}",
            f"Tool: {tool.name}",
            f"Risk: {tool.risk}",
            f"Description: {tool.description}",
            f"Parameters: {{ {params} }}",
        ]
    )


@dataclass
class ToolRecallResult:
    tool: ToolDef
    score: float


class SkillRegistry:
    def __init__(self) -> None:
        self._tools: list[ToolDef] = []
        self._embedder = create_embedder()
        self._store: InMemoryEmbeddingStore[ToolDef] = InMemoryEmbeddingStore()
        self._built = False

    def build(self, tools: list[ToolDef]) -> None:
        self._tools = list(tools)
        self._embedder = create_embedder()
        self._store.clear()
        corpus = [tool_to_text(t) for t in tools]
        self._embedder.fit(corpus)
        for tool, text in zip(tools, corpus):
            self._store.add(tool_key(tool), tool, self._embedder.embed(text))
        self._built = True

    def recall(self, query: str, top_k: int = 12, min_score: float = 0.0) -> list[ToolRecallResult]:
        if not self._built:
            raise RuntimeError("Skill Registry 尚未构建，请先调用 build()")
        query_vector = self._embedder.embed(query)
        results: list[SearchResult[ToolDef]] = self._store.search(query_vector, top_k, min_score)
        recalled_keys = {tool_key(r.item) for r in results}
        always: list[SearchResult[ToolDef]] = []
        for tool in self._tools:
            key = tool_key(tool)
            if key in ALWAYS_AVAILABLE_TOOLS and key not in recalled_keys:
                always.append(SearchResult(item=tool, score=0.0))
                recalled_keys.add(key)
        return [ToolRecallResult(tool=r.item, score=r.score) for r in [*results, *always]]

    def all(self) -> list[ToolDef]:
        return self._tools

    def is_built(self) -> bool:
        return self._built


_registry = SkillRegistry()


def build_registry(tools: list[ToolDef]) -> None:
    _registry.build(tools)


def recall_tools(query: str, top_k: int = 12, min_score: float = 0.0) -> list[ToolRecallResult]:
    return _registry.recall(query, top_k, min_score)


def get_all_registered_tools() -> list[ToolDef]:
    return _registry.all()


def is_registry_built() -> bool:
    return _registry.is_built()
