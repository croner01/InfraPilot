"""Policy Engine 与 Command Gateway 的安全语义测试。"""

from __future__ import annotations

import asyncio

import pytest

from infrapilot import db, skills
from infrapilot.gateway import execute_tool_call
from infrapilot.models import PendingToolCall, ToolExecutionResult
from infrapilot.policy import classify_risk, find_tool, render_diff_preview


def _pending(skill: str, tool: str, args: dict, approval_id: str | None = None) -> PendingToolCall:
    return PendingToolCall(
        id="tc-1", skill=skill, tool=tool, args=args, risk=classify_risk(skill, tool, args), approvalId=approval_id
    )


def test_readonly_tool_needs_no_approval():
    decision = classify_risk("linux", "get_memory_info", {"host": "local"})
    assert decision.level == "readonly"
    assert decision.requiresApproval is False


def test_high_risk_tool_requires_approval_and_preview():
    decision = classify_risk("linux", "restart_service", {"host": "local", "service_name": "nginx"})
    assert decision.level == "high"
    assert decision.requiresApproval is True
    assert decision.requiresTwoPerson is False
    assert render_diff_preview("linux", "restart_service", {"host": "local"}).startswith("linux.restart_service(")


def test_k8s_patch_preview_matches_node_format():
    args = {"namespace": "order-service", "deployment_name": "order-api", "container_name": "order-api", "memory_limit_mi": 512}
    preview = render_diff_preview("k8s", "patch_resource_limits", args)
    assert "resources.limits.memory" in preview
    assert "+   512Mi" in preview


def test_unregistered_tool_is_critical():
    decision = classify_risk("k8s", "delete_namespace", {"name": "prod"})
    assert decision.level == "critical"
    assert decision.requiresTwoPerson is True


def test_global_deny_blacklist():
    decision = classify_risk("linux", "run_command", {"command": "sh", "args": ["-c", "rm -rf /"]})
    assert decision.level == "critical"
    assert "黑名单" in decision.reason


def test_registered_tool_lookup():
    assert find_tool("linux", "get_cpu_usage") is not None
    assert find_tool("linux", "not_a_tool") is None


def test_gateway_rejects_high_risk_without_approval(monkeypatch):
    called = {"n": 0}

    async def fake_dispatch(skill, tool, args):
        called["n"] += 1
        return ToolExecutionResult(success=True, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)
    result = asyncio.run(
        execute_tool_call(_pending("linux", "restart_service", {"host": "local", "service_name": "nginx"}), "s-1", "linux-skill")
    )
    assert result.success is False
    assert "缺少审批令牌" in (result.error or "")
    assert called["n"] == 0
    audits = db.list_audit_by_session("s-1")
    assert len(audits) == 1 and audits[0]["success"] == 0


def test_gateway_rejects_tampered_args(monkeypatch):
    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)
    db.insert_approval(
        {
            "id": "ap-tamper",
            "sessionId": "s-2",
            "skill": "linux",
            "tool": "restart_service",
            "args": "{}",
            "argsHash": "deadbeef",
            "riskLevel": "high",
            "diffPreview": "",
        }
    )
    db.decide_approval("ap-tamper", "approved", "on-call")
    result = asyncio.run(
        execute_tool_call(
            _pending("linux", "restart_service", {"host": "local", "service_name": "nginx"}, "ap-tamper"),
            "s-2",
            "linux-skill",
        )
    )
    assert result.success is False
    assert "不匹配" in (result.error or "")


def test_gateway_executes_approved_matching_call(monkeypatch):
    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, data={"restarted": True}, durationMs=3)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)
    from infrapilot.args_hash import compute_args_hash

    args = {"host": "local", "service_name": "nginx"}
    db.insert_approval(
        {
            "id": "ap-ok",
            "sessionId": "s-3",
            "skill": "linux",
            "tool": "restart_service",
            "args": "{}",
            "argsHash": compute_args_hash("linux", "restart_service", args),
            "riskLevel": "high",
            "diffPreview": "",
        }
    )
    db.decide_approval("ap-ok", "approved", "on-call")
    result = asyncio.run(
        execute_tool_call(
            _pending("linux", "restart_service", args, "ap-ok"), "s-3", "linux-skill", "on-call"
        )
    )
    assert result.success is True
    audits = [a for a in db.list_audit_by_session("s-3")]
    assert len(audits) == 1
    assert audits[0]["approved_by"] == "on-call"
    assert audits[0]["risk_level"] == "high"
