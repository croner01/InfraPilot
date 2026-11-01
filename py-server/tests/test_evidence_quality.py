"""证据摘要 / 假设关联 / 结论证据链 —— 让「证据链」在真实会话里可用且不夸大。"""

from __future__ import annotations

from infrapilot.hypotheses import build_evidence_chain, link_hypotheses_to_evidence
from infrapilot.models import Evidence, Hypothesis
from infrapilot.tool_summary import summarize_evidence


def _evidence(eid: str, summary: str, content=None, skill="k8s") -> Evidence:
    return Evidence(
        id=eid,
        sourceAgent=f"{skill}-skill",
        sourceSkill=skill,
        type=f"{skill}.tool",
        content=content,
        confidence=0.7,
        collectedAt="2026-10-07T03:00:00.000Z",
        summary=summary,
    )


def _hypothesis(statement: str, status: str, evidence_ids=None) -> Hypothesis:
    return Hypothesis(
        id=f"hyp-{statement[:6]}",
        statement=statement,
        status=status,  # type: ignore[arg-type]
        evidenceIds=evidence_ids or [],
        toolCallIds=[],
        updatedAt="2026-10-07T03:00:00.000Z",
    )


# -------------------- 证据摘要 --------------------


def test_list_pods_summary_surfaces_counts_not_just_signature():
    text = summarize_evidence(
        "k8s",
        "list_pods",
        {"namespace": "ems"},
        {
            "summary": {"total": 22, "running": 10, "abnormal": 20, "byReason": {"CrashLoopBackOff": 1}},
            "pods": [{"name": "a"}],
        },
    )
    assert text.startswith('k8s.list_pods({"namespace": "ems"}) → ')
    assert "total 22" in text
    assert "CrashLoopBackOff 1" in text


def test_describe_pod_summary_surfaces_state_and_restarts():
    text = summarize_evidence(
        "k8s",
        "describe_pod",
        {"namespace": "ems", "pod_name": "ecp-dashboard-api-abc"},
        {"status": "CrashLoopBackOff", "ready": False, "restartCount": 271, "lastState": {"reason": "Completed", "exitCode": 0}},
    )
    assert "status=CrashLoopBackOff" in text
    assert "ready=False" in text
    assert "restarts=271" in text
    assert "lastState=Completed(exit 0)" in text


def test_summary_falls_back_to_signature_and_is_bounded():
    text = summarize_evidence("k8s", "get_node", {"node_name": "node-1"}, None)
    assert text == 'k8s.get_node({"node_name": "node-1"})'
    long_arg = {"keyword": "x" * 400}
    assert len(summarize_evidence("clickhouse", "search_logs", long_arg, {"total": 3})) <= 200


# -------------------- 假设关联 --------------------


def test_links_cited_evidence_by_index():
    evidence = [_evidence("e1", "a"), _evidence("e2", "b")]
    linked = link_hypotheses_to_evidence([_hypothesis("见 证据#2 的结论", "active")], evidence)
    assert linked[0].evidenceIds == ["e2"]


def test_links_by_entity_name_when_model_omits_citations():
    """真实会话里模型常不写「证据#N」，只写实体名；此前这类假设永远关联不到证据。"""
    evidence = [
        _evidence("e1", 'k8s.describe_pod({"namespace": "ems", "pod_name": "ecp-dashboard-api-fd78c5b6b-8pq6f"})'),
        _evidence("e2", 'k8s.list_pods({"namespace": "ems"})'),
        _evidence("e3", 'clickhouse.search_logs({"namespace": "ceph"})'),
    ]
    linked = link_hypotheses_to_evidence(
        [_hypothesis("ecp-dashboard-api-fd78c5b6b-8pq6f 副本被外部优雅终止", "confirmed")], evidence
    )
    assert "e1" in linked[0].evidenceIds
    assert "e3" not in linked[0].evidenceIds


def test_linking_is_stable_for_hypotheses_without_matches():
    evidence = [_evidence("e1", "unrelated payload")]
    linked = link_hypotheses_to_evidence([_hypothesis("磁盘写满", "active")], evidence)
    assert linked[0].evidenceIds == []


# -------------------- 结论证据链 --------------------


def test_chain_only_keeps_referenced_evidence():
    evidence = [_evidence("e1", "one"), _evidence("e2", "two"), _evidence("e3", "three")]
    hypotheses = [
        _hypothesis("确认项", "confirmed", ["e2"]),
        _hypothesis("排除项", "ruled_out", ["e3"]),
        _hypothesis("进行中", "active", ["e1"]),
    ]
    chain = build_evidence_chain(hypotheses, evidence, "结论正文")
    # e1 只被未定论假设引用，不应算作结论证据；此前会把全部证据都标成 supporting
    assert [(item.evidenceId, item.role) for item in chain] == [("e2", "supporting"), ("e3", "ruled_out")]


def test_chain_prefers_primary_role_for_cited_evidence():
    evidence = [_evidence("e1", "one")]
    hypotheses = [_hypothesis("确认项", "confirmed", ["e1"])]
    chain = build_evidence_chain(hypotheses, evidence, "见 证据#1")
    assert [(item.evidenceId, item.role) for item in chain] == [("e1", "primary")]


def test_chain_is_empty_when_nothing_is_attributable():
    evidence = [_evidence("e1", "one")]
    assert build_evidence_chain([_hypothesis("未定论", "active")], evidence, "无引用") == []
