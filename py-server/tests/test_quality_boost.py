"""诊断质量与效率优化：Deployment 探针、工具结果预算裁剪、结论置信度自检。"""

from __future__ import annotations

import json
import re
import uuid

from kubernetes.client import models as k8s_models

from infrapilot import compression, sessions
from infrapilot.models import AgentCheckpoint, AgentSession, RootCause, ToolExecutionResult
from infrapilot.runner import _EVIDENCE_GAP_MARKER, evidence_gap_probe, format_tool_result
from infrapilot.skills import k8s as k8s_skill
from infrapilot.skills.k8s import _container_probes, _probe_summary

TOOL_RESULT_RE = re.compile(r'<tool_result source="[^"]+" trust_level="untrusted_data">\n(.*)\n</tool_result>', re.S)


# -------------------- 1. Deployment 探针 --------------------


def test_probe_summary_keeps_diagnostic_fields():
    probe = k8s_models.V1Probe(
        http_get=k8s_models.V1HTTPGetAction(path="/healthz", port=8080),
        initial_delay_seconds=10,
        period_seconds=5,
        failure_threshold=3,
    )
    summary = _probe_summary(probe)
    assert summary["type"] == "httpGet"
    assert summary["target"] == "http://:8080/healthz"
    assert summary["initialDelaySeconds"] == 10
    assert summary["failureThreshold"] == 3


def test_container_probes_reports_absence_as_empty():
    container = k8s_models.V1Container(
        name="api",
        image="api:1",
        liveness_probe=k8s_models.V1Probe(_exec=k8s_models.V1ExecAction(command=["sh", "-c", "true"])),
    )
    probes = _container_probes(container)
    # 真实会话里 RCA 只能靠猜「未配置探针」：空对象必须显式表达「该容器未声明探针」
    assert set(probes) == {"liveness"}
    assert probes["liveness"]["type"] == "exec"
    assert probes["liveness"]["target"] == "sh -c true"
    assert _container_probes(k8s_models.V1Container(name="x", image="y")) == {}


def test_get_deployment_exposes_probes(monkeypatch):
    deployment = k8s_models.V1Deployment(
        metadata=k8s_models.V1ObjectMeta(name="api", namespace="ems"),
        spec=k8s_models.V1DeploymentSpec(
            replicas=3,
            selector=k8s_models.V1LabelSelector(match_labels={"app": "api"}),
            template=k8s_models.V1PodTemplateSpec(
                spec=k8s_models.V1PodSpec(
                    containers=[
                        k8s_models.V1Container(
                            name="api",
                            image="api:1",
                            readiness_probe=k8s_models.V1Probe(
                                tcp_socket=k8s_models.V1TCPSocketAction(port=8080), period_seconds=10
                            ),
                        )
                    ]
                )
            ),
        ),
    )

    class _Apps:
        def read_namespaced_deployment(self, name, namespace):
            return deployment

    monkeypatch.setattr(k8s_skill, "_apps", lambda cluster=None: _Apps())
    payload = k8s_skill._get_deployment_sync("ems", "api")
    probes = payload["containers"][0]["probes"]
    assert probes["readiness"]["type"] == "tcpSocket"
    assert probes["readiness"]["periodSeconds"] == 10


# -------------------- 2. 工具结果预算 --------------------


def _payload_of(text: str) -> object:
    match = TOOL_RESULT_RE.match(text)
    assert match, text[:200]
    return json.loads(match.group(1))


def test_small_tool_result_passes_through_untouched():
    text = format_tool_result("k8s", "list_pods", ToolExecutionResult(success=True, data={"total": 3}, durationMs=1))
    assert _payload_of(text) == {"success": True, "data": {"total": 3}, "stdout": None, "error": None}
    assert "已裁剪" not in text


def test_large_tool_result_is_trimmed_but_still_valid_json():
    logs = {"data": {"lines": [f"2026-10-07 12:00:{i:02d} ERROR request failed trace={uuid.uuid4()}" for i in range(400)]}}
    text = format_tool_result("clickhouse", "search_logs", ToolExecutionResult(success=True, **logs, durationMs=1))
    payload = _payload_of(text)
    assert isinstance(payload, dict)
    note = payload["_truncated"]
    assert "完整返回已存入本会话「证据」面板" in note
    # 结构裁剪优先：长列表被截尾并给出省略说明，而不是把 JSON 从中间硬切
    lines = payload["data"]["lines"]
    assert any("已省略" in line for line in lines if isinstance(line, str))
    assert len(text) < 5000


def test_tool_result_budget_is_per_tool():
    huge = {"data": {"value": "x" * 40_000}}
    small_text = format_tool_result("k8s", "list_pods", ToolExecutionResult(success=True, **huge, durationMs=1))
    big_text = format_tool_result("k8s", "get_deployment", ToolExecutionResult(success=True, **huge, durationMs=1))
    assert len(small_text) < len(big_text)


# -------------------- 3. 结论置信度自检 --------------------


def _session(confidence, evidence=True):
    session = sessions.create_session("置信度自检")
    session.status = "concluded"
    session.rootCause = RootCause(summary="结论", confidence=confidence)
    session.evidence = [object()] * (1 if evidence else 0)
    return session


def _checkpoint(iteration=3, history=None):
    return AgentCheckpoint(sessionId="s1", history=history or [], iteration=iteration, createdAt="2026-10-07T00:00:00.000Z")


def test_gate_triggers_on_low_confidence_with_headroom(monkeypatch):
    monkeypatch.delenv("INFRAPILOT_CONFIDENCE_GATE", raising=False)
    probe = evidence_gap_probe(_session(0.6), _checkpoint(), 20)
    assert probe and _EVIDENCE_GAP_MARKER in probe
    assert "0.6" in probe and "0.75" in probe


def test_gate_skips_when_confident_without_evidence_or_already_probed(monkeypatch):
    monkeypatch.delenv("INFRAPILOT_CONFIDENCE_GATE", raising=False)
    assert evidence_gap_probe(_session(0.9), _checkpoint(), 20) is None
    # 未给出置信度同样算质量缺口，必须追问一次
    assert evidence_gap_probe(_session(None), _checkpoint(), 20) is not None
    # 没采集过证据时无据可补
    assert evidence_gap_probe(_session(0.2, evidence=False), _checkpoint(), 20) is None
    # 只补一次：历史里已有标记就不再追问，避免死循环
    probed = _checkpoint(history=[{"role": "user", "content": _EVIDENCE_GAP_MARKER}])
    assert evidence_gap_probe(_session(0.2), probed, 20) is None
    # 没有迭代余量
    assert evidence_gap_probe(_session(0.2), _checkpoint(iteration=19), 20) is None


def test_gate_can_be_disabled(monkeypatch):
    monkeypatch.setenv("INFRAPILOT_CONFIDENCE_GATE", "0")
    assert evidence_gap_probe(_session(0.1), _checkpoint(), 20) is None


def test_gate_threshold_is_configurable(monkeypatch):
    monkeypatch.setenv("INFRAPILOT_MIN_CONCLUSION_CONFIDENCE", "0.95")
    assert evidence_gap_probe(_session(0.9), _checkpoint(), 20) is not None


# -------------------- 上下文压缩阈值 --------------------


def test_default_budget_triggers_before_old_60k_ceiling():
    assert compression.DEFAULT_MAX_TOKENS <= 32_000
    filler = "故障现象与证据细节" * 40  # 约 320 token/条
    history = [{"role": "system", "content": "SYS"}]
    while compression.history_tokens(history) < 30_000:
        history.append({"role": "user", "content": filler})
    assert compression.history_tokens(history) > compression.max_tokens()
