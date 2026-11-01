"""假设树合并/证据关联 —— 对应 `server/src/agent/hypotheses.ts`。"""

from __future__ import annotations

import json
import re

from .models import Evidence, EvidenceChainItem, Hypothesis
from .util import new_id, now_iso

# 模型显式引用证据的写法：证据#3 / 证据 3 / 证据3
_CITED_EVIDENCE_RE = re.compile(r"证据\s*#?\s*(\d+)")
# 假设正文里的实体名（Pod / 节点 / 命名空间 / 服务等）
_ENTITY_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{3,}")
_MIN_ENTITY_LEN = 4
_MAX_LINKS_PER_HYPOTHESIS = 3


# 假设去重阈值：字符 2-gram 的重叠系数。真实会话里「外部 SIGTERM」/「OOM」/「panic」各被重出一遍，
# 靠字符串全等去重不掉，导致 12 条假设里一半是重复项。
_DEDUP_OVERLAP = 0.7
_DEDUP_MIN_CHARS = 12
_DEDUP_STRIP_RE = re.compile(r"[\s`*_#>\u2014:\uff1a;\uff1b,\uff0c.\u3002()\uff08\uff09\[\]\u3010\u3011/|]+")


def _shingles(text: str) -> set[str]:
    normalized = _DEDUP_STRIP_RE.sub("", (text or "").lower())
    if len(normalized) < _DEDUP_MIN_CHARS:
        return {normalized} if normalized else set()
    return {normalized[i : i + 2] for i in range(len(normalized) - 1)}


def _same_claim(a: str, b: str) -> bool:
    """重叠系数（交集/较短者）而不是 Jaccard：一句话是另一句的「更详细版本」时也应该合并。"""
    left, right = _shingles(a), _shingles(b)
    if not left or not right:
        return False
    if len(_DEDUP_STRIP_RE.sub("", a.lower())) < _DEDUP_MIN_CHARS:
        return False
    return len(left & right) / min(len(left), len(right)) >= _DEDUP_OVERLAP


def merge_hypotheses(existing: list[Hypothesis], incoming: list[dict[str, str]]) -> list[Hypothesis]:
    result = [h.model_copy(deep=True) for h in existing]
    for item in incoming:
        statement = item["statement"]
        found = next((h for h in result if h.statement == statement), None) or next(
            (h for h in result if _same_claim(h.statement, statement)), None
        )
        if found:
            # 合并语义重复项：只更新状态（保留首见表述，避免同一假设在 UI 上反复改写）
            found.status = item["status"]  # type: ignore[assignment]
            found.updatedAt = now_iso()
        else:
            result.append(
                Hypothesis(
                    id=f"hyp-{new_id()}",
                    statement=item["statement"],
                    status=item["status"],  # type: ignore[arg-type]
                    evidenceIds=[],
                    toolCallIds=[],
                    updatedAt=now_iso(),
                )
            )
    return result


def link_hypotheses_to_evidence(hypotheses: list[Hypothesis], evidence: list[Evidence]) -> list[Hypothesis]:
    """把假设关联到证据：优先正文里的「证据#N」，否则按实体名兜底匹配。"""
    out: list[Hypothesis] = []
    for h in hypotheses:
        ids = _cited_evidence_ids(h.statement, evidence) or _entity_evidence_ids(h.statement, evidence)
        if ids:
            out.append(h.model_copy(update={"evidenceIds": list(dict.fromkeys([*h.evidenceIds, *ids]))}))
        else:
            out.append(h)
    return out


def _cited_evidence_ids(statement: str, evidence: list[Evidence]) -> list[str]:
    ids: list[str] = []
    for match in _CITED_EVIDENCE_RE.finditer(statement):
        index = int(match.group(1)) - 1
        if 0 <= index < len(evidence):
            ids.append(evidence[index].id)
    return list(dict.fromkeys(ids))


def _entity_evidence_ids(
    statement: str, evidence: list[Evidence], limit: int = _MAX_LINKS_PER_HYPOTHESIS
) -> list[str]:
    """兜底关联：假设里出现的实体名命中某条证据即挂上该证据。

    模型通常只写「8pq6f 副本被外部终止」而不写「证据#3」；缺了这层匹配，
    假设树的引用入口在真实会话里永远是空的。
    """
    tokens = {t for t in _ENTITY_RE.findall(statement) if len(t) >= _MIN_ENTITY_LEN}
    if not tokens:
        return []
    hits: list[str] = []
    for item in evidence:
        haystack = _searchable(item)
        if any(token in haystack for token in tokens):
            hits.append(item.id)
        if len(hits) >= limit:
            break
    return hits


def _searchable(item: Evidence) -> str:
    try:
        content = json.dumps(item.content, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        content = str(item.content)
    return f"{item.summary or ''} {item.type or ''} {content[:2000]}"


def build_evidence_chain(
    hypotheses: list[Hypothesis], evidence: list[Evidence], rca_text: str
) -> list[EvidenceChainItem]:
    """结论的证据链：只保留被结论正文或假设真正引用的证据，并标注角色。

    此前把所有证据一律标成 supporting，等于把与结论无关的采集（例如全命名空间
    list_pods、其它命名空间的日志检索）也当成支撑证据，反而削弱结论可信度。
    """
    known = {e.id: e for e in evidence}
    roles: dict[str, str] = {}

    for match in _CITED_EVIDENCE_RE.finditer(rca_text or ""):
        index = int(match.group(1)) - 1
        if 0 <= index < len(evidence):
            roles.setdefault(evidence[index].id, "primary")

    for h in hypotheses:
        if h.status == "confirmed":
            target = "supporting"
        elif h.status == "ruled_out":
            target = "ruled_out"
        else:
            continue
        for eid in h.evidenceIds:
            if eid in known and roles.get(eid) != "primary":
                roles[eid] = target

    # 每条证据挂上「它支撑/反驳了哪句结论」：否则证据链只是一串 ID，读者无法验证关联是否成立
    claims: dict[str, str] = {}
    for h in hypotheses:
        if h.status not in ("confirmed", "ruled_out"):
            continue
        prefix = "支撑: " if h.status == "confirmed" else "排除: "
        for eid in h.evidenceIds:
            if eid in known and eid not in claims:
                claims[eid] = prefix + _clip_claim(h.statement)
    for eid in roles:
        if roles[eid] == "primary" and eid not in claims:
            claims[eid] = "结论正文直接引用"

    order = [e.id for e in evidence if e.id in roles]
    return [EvidenceChainItem(evidenceId=eid, role=roles[eid], claim=claims.get(eid)) for eid in order]  # type: ignore[arg-type]


def _clip_claim(text: str, limit: int = 120) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else f"{flat[: limit - 1]}…"
