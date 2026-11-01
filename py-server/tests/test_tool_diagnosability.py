"""工具失败要可自愈：报错指向可行替代方案，而不是内部异常或裸退出码。"""

from __future__ import annotations

import asyncio

from infrapilot.models import ToolExecutionResult
from infrapilot.skill_packages import MIN_SKILL_SCORE, select_skills_for_turn, skill_store
from infrapilot.skills import k8s as k8s_skill
from infrapilot import remote as remote_skill
from infrapilot.skills import linux as linux_skill


def run(coro):
    return asyncio.run(coro)


# -------------------- linux：host 参数与命令缺失 --------------------


def test_unregistered_remote_host_is_rejected_with_actionable_hint():
    # 直接走 SSH 通道（不经过 asyncio.to_thread：本沙箱内该原语会阻塞）
    result = remote_skill.ssh_execute("no-such-host-xyz", "free", ["-m"])
    assert result["success"] is False
    # 未注册主机必须给出可照做的修复路径（Host Registry），而不是裸报错
    assert "no-such-host-xyz" in result["error"]
    assert "Host Registry" in result["error"]


def test_host_schema_documents_remote_aliases_and_approval():
    tools = {t.name: t for t in linux_skill.TOOLS}
    description = tools["get_memory_info"].parameters["properties"]["host"]["description"]
    assert "local" in description
    assert "Host Registry" in description
    assert "审批" in description


def test_missing_kubectl_becomes_an_actionable_hint():
    raw = ToolExecutionResult(success=False, error="本地命令退出码非 0: 127", durationMs=1)
    hint = linux_skill._with_kubectl_fallback(raw)
    assert "k8s.list_pods" in hint.error and "k8s.get_pod_logs" in hint.error

    ok = ToolExecutionResult(success=True, durationMs=1)
    assert linux_skill._with_kubectl_fallback(ok).error is None


def test_get_pod_logs_no_longer_shells_out_to_kubectl(monkeypatch):
    """服务端容器没有 kubectl，日志读取应走 K8s API。"""
    called = {}

    async def fake_read_pod_logs(namespace, name, **kwargs):
        called.update({"namespace": namespace, "name": name, **kwargs})
        return "line-1\nline-2"

    monkeypatch.setattr(k8s_skill, "read_pod_logs", fake_read_pod_logs)
    result = run(linux_skill.execute("get_pod_logs", {"namespace": "ems", "pod_name": "p1", "tail_lines": 20}))
    assert result.success is True
    assert "line-1" in result.stdout
    assert called["namespace"] == "ems" and called["tail_lines"] == 20


def test_linux_run_surfaces_command_not_found_reason():
    result = run(linux_skill.execute_on_host("local", "definitely-not-a-real-binary-xyz", []))
    assert result.success is False
    assert "127" in result.error
    assert "No such file" in result.error or "not found" in result.error


# -------------------- k8s：exec 前置校验与日志工具 --------------------


def test_get_pod_logs_tool_is_exposed_and_readonly():
    tool = next(t for t in k8s_skill.TOOLS if t.name == "get_pod_logs")
    assert tool.risk == "readonly"
    assert "previous" in tool.parameters["properties"]


def test_parse_since_seconds():
    assert k8s_skill.parse_since_seconds("5m") == 300
    assert k8s_skill.parse_since_seconds("1h") == 3600
    assert k8s_skill.parse_since_seconds("bad") is None


def test_exec_into_crashing_pod_reports_actionable_error(monkeypatch):
    async def fake_read_pod(namespace, name, cluster=None):
        return {"status": "CrashLoopBackOff", "ready": False, "restartCount": 271}

    monkeypatch.setattr(k8s_skill, "read_pod", fake_read_pod)
    result = run(k8s_skill.execute("get_pod_processes", {"namespace": "ems", "pod_name": "ecp-dashboard-api-8pq6f"}))
    assert result.success is False
    # 此前返回的是 'NoneType' object has no attribute 'decode'
    assert "CrashLoopBackOff" in result.error
    assert "k8s.get_pod_logs" in result.error


def test_exec_blocked_reason_allows_healthy_pod(monkeypatch):
    async def fake_read_pod(namespace, name, cluster=None):
        return {"status": "Running", "ready": True, "restartCount": 0}

    monkeypatch.setattr(k8s_skill, "read_pod", fake_read_pod)
    assert run(k8s_skill.exec_blocked_reason("ems", "p1")) is None


# -------------------- 技能召回阈值 --------------------


def test_irrelevant_installed_skill_is_not_activated():
    # 实测 ceph-rbd-108 对 ecp-dashboard-api 的 query 只有 0.048 分
    query = (
        "【服务健康】ems/ecp-dashboard-api\n- 健康状态: warn\n- 可用副本: 2/3\n"
        "请开始诊断：先确认该 Deployment 的期望/可用副本与最近事件。"
    )
    selected = [p.name for p in select_skills_for_turn(query, [])]
    assert "sre-systematic-debugging" in selected  # always-on 不受阈值影响
    assert "ceph-rbd-108" not in selected


def test_relevant_skill_is_still_activated():
    query = "ceph rbd 卷挂载失败，107 集群 osd 异常，pvc 一直 pending，帮忙排查 ceph 存储"
    selected = [p.name for p in select_skills_for_turn(query, [])]
    assert "ceph-rbd-108" in selected


def test_low_score_skills_are_gated_by_threshold(monkeypatch):
    class _Skill:
        def __init__(self, name):
            self.name = name
            self.enabled = True

    monkeypatch.setattr(skill_store, "recall", lambda query, top_k: [(_Skill("noisy-skill"), MIN_SKILL_SCORE / 2)])
    monkeypatch.setattr(skill_store, "list", lambda: [])
    assert select_skills_for_turn("随便问问", []) == []


def test_list_pods_aggregates_by_node_for_differential(monkeypatch):
    """节点间差异是排障首选信号: summary.byNode 必须能一眼看出异常集中在哪个节点。"""
    pods = [
        {"name": "a-1", "namespace": "ems", "status": "Running", "ready": True, "restartCount": 0,
         "nodeName": "node-1", "startedAt": "2026-10-01T00:00:00Z"},
        {"name": "a-2", "namespace": "ems", "status": "Running", "ready": True, "restartCount": 0,
         "nodeName": "node-2", "startedAt": "2026-10-01T00:00:00Z"},
        {"name": "a-3", "namespace": "ems", "status": "Running", "ready": False, "restartCount": 5,
         "nodeName": "node-2", "startedAt": "2026-10-01T00:00:00Z"},
    ]

    async def fake_list_pods(namespace=None, cluster=None):
        return pods

    monkeypatch.setattr(k8s_skill, "list_pods", fake_list_pods)
    result = run(k8s_skill.execute("list_pods", {"namespace": "ems"}))
    assert result.success is True
    by_node = result.data["summary"]["byNode"]
    assert by_node["node-1"] == {"total": 1, "running": 1, "abnormal": 0, "restarts": 0}
    assert by_node["node-2"] == {"total": 2, "running": 1, "abnormal": 1, "restarts": 5}
