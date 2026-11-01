"""纯函数层测试：argsHash / 输出解析 / 脱敏 / 命令白名单。"""

from __future__ import annotations

from infrapilot import plan
from infrapilot.args_hash import canonicalize, compute_args_hash
from infrapilot.redact import redact
from infrapilot.skills.allowlist import is_command_allowed, sanitize_pattern


def test_args_hash_is_key_order_independent():
    a = compute_args_hash("k8s", "patch_resource_limits", {"b": 2, "a": {"y": 1, "x": [1, 2]}})
    b = compute_args_hash("k8s", "patch_resource_limits", {"a": {"x": [1, 2], "y": 1}, "b": 2})
    assert a == b
    assert len(a) == 64


def test_args_hash_changes_with_value():
    a = compute_args_hash("k8s", "patch_resource_limits", {"memory_limit_mi": 512})
    b = compute_args_hash("k8s", "patch_resource_limits", {"memory_limit_mi": 4096})
    assert a != b


def test_canonicalize_sorts_nested_keys():
    assert list(canonicalize({"b": 1, "a": 2}).keys()) == ["a", "b"]
    assert canonicalize([{"z": 1, "y": 2}]) == [{"y": 2, "z": 1}]


def test_plan_extraction():
    text = "\n".join(
        [
            "【诊断计划】",
            "1. 查看 Pod 状态",
            "- 检索日志",
            "【假设列表】",
            "- [active] 内存 limit 过低",
            "- [confirmed] 存在内存泄漏",
            "【反证检查】",
            "- 无健康副本",
            "【根因分析结论】",
            "容器内存 limit 过低，置信度 0.95",
            "【修复方案】",
            "摘要: 提升内存上限",
            "- k8s.patch_resource_limits(namespace=order-service, memory_limit_mi=512)",
        ]
    )
    assert plan.extract_plan(text) == ["查看 Pod 状态", "检索日志"]
    assert plan.extract_hypotheses(text) == [
        {"statement": "内存 limit 过低", "status": "active"},
        {"statement": "存在内存泄漏", "status": "confirmed"},
    ]
    assert plan.extract_counter_evidence(text) == ["无健康副本"]
    assert "置信度 0.95" in plan.extract_rca(text)
    assert "【修复方案】" not in plan.extract_rca(text)
    remediation = plan.extract_remediation(text)
    assert remediation is not None
    assert remediation["summary"] == "提升内存上限"
    assert remediation["steps"][0]["tool"] == "patch_resource_limits"
    assert remediation["steps"][0]["skill"] == "k8s"


def test_redact_sensitive_values():
    assert "***REDACTED***" in redact("password: hunter2")
    assert "hunter2" not in redact("password: hunter2")
    assert redact("token abc.def") == "token ***REDACTED***"


def test_command_allowlist():
    assert is_command_allowed("kubectl", ["get", "pods"])[0] is True
    assert is_command_allowed("systemctl", ["restart", "nginx"])[0] is False
    assert is_command_allowed("systemctl", ["status", "nginx"])[0] is True
    assert is_command_allowed("/bin/rm", ["-rf", "/"])[0] is False
    assert is_command_allowed("rm", ["-rf", "/"])[0] is False
    assert sanitize_pattern("order; rm -rf /") == "orderrm-rf"
