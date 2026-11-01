"""文本向量化与向量检索 —— 对应 `server/src/skills/registry/{embedder,store}.ts`。"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Generic, Optional, TypeVar

T = TypeVar("T")

_STOPWORDS = {
    "的", "了", "是", "在", "和", "与", "或", "等", "及", "对", "为", "有", "从", "到", "中", "可",
    "请", "需", "要", "会", "能", "将", "并", "被", "把", "给", "向", "上", "下", "之", "后", "前",
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "will", "would", "could", "should", "may", "might", "can", "to", "of", "in", "for",
    "on", "at", "by", "with", "from", "as", "and", "or", "not", "this", "that", "these", "those",
}

_ASCII_RE = re.compile(r"[a-z0-9_]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fa5]")


def tokenize(text: str) -> list[str]:
    normalized = text.lower()
    tokens: list[str] = list(_ASCII_RE.findall(normalized))
    chinese = _CJK_RE.findall(normalized)
    tokens.extend(chinese)
    for i in range(len(chinese) - 1):
        tokens.append(chinese[i] + chinese[i + 1])
    return [
        t
        for t in tokens
        if (len(t) > 1 or _CJK_RE.match(t)) and t not in _STOPWORDS
    ]


@dataclass
class EmbeddingVector:
    type: str
    weights: dict[str, float]


class TfidfEmbedder:
    def __init__(self) -> None:
        self.document_count = 0
        self.term_document_count: dict[str, int] = {}
        self.documents: list[list[str]] = []

    def fit(self, corpus: list[str]) -> None:
        self.document_count = len(corpus)
        self.term_document_count = {}
        self.documents = [tokenize(doc) for doc in corpus]
        for doc in self.documents:
            for term in set(doc):
                self.term_document_count[term] = self.term_document_count.get(term, 0) + 1

    def embed(self, text: str) -> EmbeddingVector:
        tokens = tokenize(text)
        tf: dict[str, float] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        weights: dict[str, float] = {}
        for term, count in tf.items():
            idf = math.log((self.document_count + 1) / (self.term_document_count.get(term, 0) + 1)) + 1
            weights[term] = count * idf
        return EmbeddingVector(type="sparse", weights=weights)


def create_embedder() -> TfidfEmbedder:
    return TfidfEmbedder()


def _normalize(weights: dict[str, float]) -> dict[str, float]:
    norm = math.sqrt(sum(v * v for v in weights.values()))
    if norm == 0:
        return weights
    return {k: v / norm for k, v in weights.items()}


def cosine_similarity(a: EmbeddingVector, b: EmbeddingVector) -> float:
    na, nb = _normalize(a.weights), _normalize(b.weights)
    return sum(weight * nb[term] for term, weight in na.items() if term in nb)


@dataclass
class SearchResult(Generic[T]):
    item: T
    score: float


class InMemoryEmbeddingStore(Generic[T]):
    def __init__(self) -> None:
        self.entries: list[tuple[str, T, EmbeddingVector]] = []

    def add(self, item_id: str, item: T, vector: EmbeddingVector) -> None:
        self.entries.append((item_id, item, vector))

    def search(self, query: EmbeddingVector, top_k: int, min_score: float = 0.0) -> list[SearchResult[T]]:
        scored = [SearchResult(item=item, score=cosine_similarity(query, vector)) for _, item, vector in self.entries]
        scored = [s for s in scored if s.score >= min_score]
        scored.sort(key=lambda s: s.score, reverse=True)
        return scored[:top_k]

    def clear(self) -> None:
        self.entries = []

    def remove(self, item_id: str) -> None:
        self.entries = [e for e in self.entries if e[0] != item_id]
