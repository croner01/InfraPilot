"""P2 评测框架：确定性 check / case 存储 / 线上回流 / 评测记录。"""

from __future__ import annotations

from infrapilot import db, eval as eval_mod, sessions
from infrapilot.models import ExecutedToolCall, RiskDecision, RootCause, ToolExecutionResult
from infrapilot.util import now_iso


def test_evaluate_case_all_check_types():
    case = {
        "id": "c1",
        "message": "m",
        "checks": [
            {"type": "hasTool", "skill": "k8s", "tool": "list_pods"},
            {"type": "rootCauseMatches", "regex": "OOM|内存"},
            {"type": "hypothesisStatus", "statementRegex": "内存", "status": "confirmed"},
            {"type": "judgeScore", "min": 0.6},
        ],
    }
    ctx = {
        "toolsUsed": [{"skill": "k8s", "tool": "list_pods"}],
        "rootCause": "内存限制过低导致 OOM",
        "hypotheses": [{"statement": "内存限制过低", "status": "confirmed"}],
        "judge": {"score": 0.8, "verdict": "pass"},
    }
    result = eval_mod.evaluate_case(case, ctx)
    assert result["passedAll"] is True
    assert all(c["passed"] for c in result["checks"])

    failing = eval_mod.evaluate_case(case, {"toolsUsed": [], "rootCause": "DNS 问题", "hypotheses": [], "judge": {"score": 0.2}})
    assert failing["passedAll"] is False
    assert all(not c["passed"] for c in failing["checks"])


def test_list_cases_includes_seeded_kafka_case():
    cases = {c["case"]["id"] for c in eval_mod.list_cases()}
    assert "kafka-evicted-oom" in cases


def test_save_case_validates_and_get_case():
    try:
        eval_mod.save_case({"id": "bad"})
        assert False, "应当抛出 ValueError"
    except ValueError:
        pass
    saved = eval_mod.save_case({"id": "unit-case", "message": "m", "checks": [{"type": "rootCauseMatches", "regex": "x"}]})
    assert saved["origin"] == "manual"
    assert eval_mod.get_case("unit-case")["case"]["message"] == "m"
    db.delete_eval_case("unit-case")
    assert eval_mod.get_case("unit-case") is None


def test_promote_session_creates_online_case():
    session = sessions.create_session("回流会话")
    call = ExecutedToolCall(
        id="tc-1",
        skill="k8s",
        tool="list_pods",
        args={},
        risk=RiskDecision(level="readonly", reason="只读", requiresApproval=False, requiresTwoPerson=False),
        result=ToolExecutionResult(success=True, data={}),
        startedAt=now_iso(),
        finishedAt=now_iso(),
    )

    def _fill(s) -> None:
        s.incidentSummary = "kafka 无法启动"
        s.executedToolCalls = [call]
        s.rootCause = RootCause(summary="emptyDir 被驱逐导致 kafka 无法启动", confidence=0.7)

    sessions.update_session(session.id, _fill)
    promoted = eval_mod.promote_session(session.id, case_id="online-unit")
    assert promoted["origin"] == "online"
    case = promoted["case"]
    assert case["expected"] == "emptyDir 被驱逐导致 kafka 无法启动"
    types = [c["type"] for c in case["checks"]]
    assert "judgeScore" in types
    assert {"type": "hasTool", "skill": "k8s", "tool": "list_pods"} in case["checks"]
    db.delete_eval_case("online-unit")


def test_record_and_list_runs():
    row = eval_mod.record_run("unit-case", {"caseId": "unit-case", "passedAll": True, "checks": []}, session_id="s1", score=0.9)
    assert row["passed"] is True
    runs = db.list_eval_runs("unit-case")
    assert any(r["id"] == row["id"] and r["passed"] is True for r in runs)
    assert db.list_eval_runs("unit-case")[0]["score"] == 0.9
