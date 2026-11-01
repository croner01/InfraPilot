"""P0/P1 诊断能力加固：生命周期钩子可见性、审批型 delete_pod、案例 upsert、证据链可解释、假设去重、prompt 纪律。"""

from __future__ import annotations

import asyncio

from kubernetes.client import models as k8s_models

from infrapilot import knowledge, policy, prompts, skills
from infrapilot.models import Evidence, Hypothesis
from infrapilot.hypotheses import build_evidence_chain, merge_hypotheses
from infrapilot.skills import k8s as k8s_skill


def run(coro):
    return asyncio.run(coro)


# -------------------- 1. lifecycle / initContainers / hostPath 可见性 --------------------


def _deployment_with_hook() -> k8s_models.V1Deployment:
    return k8s_models.V1Deployment(
        metadata=k8s_models.V1ObjectMeta(name="api", namespace="ems"),
        spec=k8s_models.V1DeploymentSpec(
            replicas=3,
            selector=k8s_models.V1LabelSelector(match_labels={"app": "api"}),
            template=k8s_models.V1PodTemplateSpec(
                spec=k8s_models.V1PodSpec(
                    termination_grace_period_seconds=60,
                    init_containers=[k8s_models.V1Container(name="init", image="entrypoint:v1")],
                    volumes=[k8s_models.V1Volume(name="helm", host_path=k8s_models.V1HostPathVolumeSource(path="/usr/local/bin/helm"))],
                    containers=[
                        k8s_models.V1Container(
                            name="api",
                            image="api:1",
                            lifecycle=k8s_models.V1Lifecycle(
                                post_start=k8s_models.V1LifecycleHandler(
                                    _exec=k8s_models.V1ExecAction(
                                        command=["/bin/sh", "-c", "helm init --client-only"]
                                    )
                                )
                            ),
                        )
                    ],
                )
            ),
        ),
    )


def test_get_deployment_exposes_lifecycle_hook_init_containers_and_hostpath(monkeypatch):
    class _Apps:
        def read_namespaced_deployment(self, name, namespace):
            return _deployment_with_hook()

    monkeypatch.setattr(k8s_skill, "_apps", lambda cluster=None: _Apps())
    payload = k8s_skill._get_deployment_sync("ems", "api")

    container = payload["containers"][0]
    # postStart 失败会被 kubelet 杀掉容器：这行信息缺失时只能靠猜外部原因
    assert container["lifecycle"]["postStart"] == "/bin/sh -c helm init --client-only"
    assert payload["initContainers"] == [{"name": "init", "image": "entrypoint:v1", "lifecycle": {}}]
    assert payload["terminationGracePeriodSeconds"] == 60
    assert payload["volumes"][0]["hostPath"] == "/usr/local/bin/helm"


def test_get_deployment_reports_absent_hooks_as_empty(monkeypatch):
    class _Apps:
        def read_namespaced_deployment(self, name, namespace):
            return _deployment_with_hook()

    monkeypatch.setattr(k8s_skill, "_apps", lambda cluster=None: _Apps())
    assert k8s_skill._get_deployment_sync("ems", "api")["containers"][0].get("lifecycle") is not None


def test_read_pod_surfaces_lifecycle_and_init_containers(monkeypatch):
    pod = k8s_models.V1Pod(
        metadata=k8s_models.V1ObjectMeta(name="api-1", namespace="ems", uid="u1"),
        spec=k8s_models.V1PodSpec(
            node_name="node-1",
            termination_grace_period_seconds=30,
            init_containers=[k8s_models.V1Container(name="init", image="entrypoint:v1")],
            containers=[
                k8s_models.V1Container(
                    name="api",
                    image="api:1",
                    lifecycle=k8s_models.V1Lifecycle(
                        post_start=k8s_models.V1LifecycleHandler(_exec=k8s_models.V1ExecAction(command=["helm", "init"]))
                    ),
                )
            ],
        ),
        status=k8s_models.V1PodStatus(phase="Running"),
    )

    class _Core:
        def read_namespaced_pod(self, name, namespace):
            return pod

    monkeypatch.setattr(k8s_skill, "_core", lambda cluster=None: _Core())
    info = k8s_skill._read_pod_sync("ems", "api-1")
    assert info["lifecycle"]["postStart"] == "helm init"
    assert info["initContainers"][0]["name"] == "init"
    assert info["terminationGracePeriodSeconds"] == 30


def test_describe_pod_passes_cluster_through(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_read_pod(namespace, name, cluster=None):
        captured["cluster"] = cluster
        return {
            "name": name,
            "namespace": namespace,
            "status": "CrashLoopBackOff",
            "restartCount": 290,
            "lastState": None,
            "resources": None,
            "nodeName": "node-1",
            "podIp": "10.0.0.1",
            "containerName": "api",
            "ownerDeployment": "api",
            "startedAt": None,
            "lifecycle": {},
            "initContainers": [],
            "terminationGracePeriodSeconds": 60,
        }

    async def fake_events(namespace, pod_name, cluster=None):
        return []

    monkeypatch.setattr(k8s_skill, "read_pod", fake_read_pod)
    monkeypatch.setattr(k8s_skill, "list_events_for_pod", fake_events)
    result = run(k8s_skill._execute_tool("describe_pod", {"namespace": "ems", "pod_name": "api-1", "cluster": "cluster-x"}))
    assert result.success and captured["cluster"] == "cluster-x"
    assert result.data["lifecycle"] == {}


# -------------------- 2. delete_pod：审批型变更工具 --------------------


def test_delete_pod_is_registered_high_risk_and_approval_gated():
    tool = next(t for t in k8s_skill.TOOLS if t.name == "delete_pod")
    assert tool.risk == "high"
    decision = policy.classify_risk("k8s", "delete_pod", {"namespace": "ems", "pod_name": "api-1"})
    assert decision.requiresApproval is True
    assert "api-1" in decision.blastRadius
    preview = policy.render_diff_preview("k8s", "delete_pod", {"namespace": "ems", "pod_name": "api-1"})
    assert "kubectl delete pod api-1 -n ems" in preview


def test_delete_pod_executes_through_tool_branch(monkeypatch):
    calls: list[tuple] = []

    async def fake_delete(namespace, name, cluster=None):
        calls.append((namespace, name, cluster))

    monkeypatch.setattr(k8s_skill, "delete_pod", fake_delete)
    result = run(k8s_skill._execute_tool("delete_pod", {"namespace": "ems", "pod_name": "api-1"}))
    assert result.success and calls == [("ems", "api-1", None)]
    assert result.data["deleted"] == "ems/api-1"


def test_tool_registry_exposes_delete_pod_to_agent():
    names = {t.name for t in skills.all_tools() if t.skill == "k8s"}
    assert "delete_pod" in names


# -------------------- 3. 自动沉淀案例按会话 upsert --------------------


def test_auto_persisted_case_is_upserted_per_session():
    session_id = "sess-upsert-1"
    body = {
        "title": "自动沉淀: ems/ecp-dashboard-api",
        "problemType": "auto_persisted",
        "severity": "p2",
        "summary": "第一版结论(置信度 0.6)",
        "rootCauses": ["副本被非正常终止"],
        "solutions": ["删除卡死副本"],
        "tags": ["auto_persisted"],
        "sourceSessionId": session_id,
    }
    first = knowledge.add_knowledge_case(dict(body))
    second = knowledge.add_knowledge_case({**body, "summary": "修订版结论(置信度 0.72)", "solutions": ["修复宿主 helm 版本"]})

    assert first["id"] == second["id"], "同一会话的自检修订应更新同一条案例而不是追加"
    cases = [c for c in knowledge.list_knowledge_cases() if c.get("sourceSessionId") == session_id]
    assert len(cases) == 1
    assert cases[0]["summary"].startswith("修订版结论")
    assert cases[0]["solutions"] == ["修复宿主 helm 版本"]
    hits = [c for c in knowledge.search_knowledge_cases("副本被非正常终止", limit=10) if c.get("sourceSessionId") == session_id]
    assert len(hits) == 1, "向量索引先摘后加，不应出现重复命中"


# -------------------- 4. 证据链可解释 + 假设去重 --------------------


def _evidence(eid: str, summary: str) -> Evidence:
    return Evidence(
        id=eid, sourceAgent="k8s-skill", sourceSkill="k8s", type="k8s.describe_pod",
        content={}, confidence=0.7, collectedAt="2026-10-07T00:00:00.000Z", summary=summary,
    )


def test_evidence_chain_carries_the_claim_it_supports():
    evidence = [_evidence("e1", "pod 状态"), _evidence("e2", "探针定义")]
    hypotheses = [
        Hypothesis(id="h1", statement="副本被外部终止", status="confirmed", evidenceIds=["e1"], toolCallIds=[], updatedAt="t"),
        Hypothesis(id="h2", statement="探针失败触发 kill", status="ruled_out", evidenceIds=["e2"], toolCallIds=[], updatedAt="t"),
    ]
    chain = build_evidence_chain(hypotheses, evidence, "结论正文引用 证据#1")
    roles = {c.evidenceId: c.role for c in chain}
    claims = {c.evidenceId: c.claim for c in chain}
    assert roles == {"e1": "primary", "e2": "ruled_out"}
    # 角色来自结论正文引用(primary)，说明文字来自它支撑/反驳的那条假设
    assert claims["e1"] == "支撑: 副本被外部终止"
    assert claims["e2"].startswith("排除: ")


def test_evidence_chain_marks_cited_evidence_without_hypothesis():
    evidence = [_evidence("e9", "自定义指标")]
    chain = build_evidence_chain([], evidence, "见 证据#1")
    assert chain[0].role == "primary" and chain[0].claim == "结论正文直接引用"


def test_merge_hypotheses_dedupes_reworded_duplicates():
    existing = [
        Hypothesis(
            id="h1",
            statement="`8pq6f` 容器被外部发送 SIGTERM 后优雅退出(exit 0)，导致 CrashLoopBackOff，使 Deployment 停在 2/3。",
            status="active",
            evidenceIds=["e1"],
            toolCallIds=[],
            updatedAt="t1",
        )
    ]
    merged = merge_hypotheses(
        existing,
        [
            {
                "statement": "`8pq6f` 容器被**外部(kubelet/容器运行时)发送 SIGTERM** 后优雅退出(exit 0)，导致 CrashLoopBackOff，Deployment 停在 2/3。",
                "status": "confirmed",
            }
        ],
    )
    assert len(merged) == 1, "同一条假设换措辞重出不应新增一条"
    assert merged[0].status == "confirmed"
    assert merged[0].evidenceIds == ["e1"]


# -------------------- 5. prompt 纪律 --------------------


def test_system_prompt_requires_evidence_matched_wording_and_differentials():
    prompt = prompts.build_system_prompt("(tools)")
    assert "措辞必须与证据强度一致" in prompt
    assert "先差分,再谈全局" in prompt
    assert "发起者未证实" in prompt
    assert "increase(x[1h])" in prompt
    # 背景知识里必须有 postStart / hostPath 版本漂移这条最容易被漏掉的路径
    assert "postStart" in prompt and "hostPath" in prompt


def test_prom_instant_query_warns_about_cumulative_counters():
    tool = next(t for t in skills.all_tools() if t.skill == "prom" and t.name == "instant_query")
    assert "increase" in tool.description and "累计" in tool.description
