"""远端 K8s 集群接入：登记、脱敏、连通性探测，以及技能/审批侧的多集群契约。"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from infrapilot import config_store, k8s_clusters
from infrapilot.main import app
from infrapilot.policy import classify_risk, render_diff_preview
from infrapilot.skills import k8s as k8s_skill


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clean_clusters():
    config_store.set_k8s_clusters([])
    k8s_clusters.invalidate_cache()
    yield
    config_store.set_k8s_clusters([])
    k8s_clusters.invalidate_cache()


def _token_cluster(name: str = "生产集群 A", **over) -> dict:
    body = {
        "name": name,
        "server": "https://10.0.0.1:6443",
        "authType": "token",
        "token": "super-secret-token",
        "insecureSkipTlsVerify": True,
    }
    body.update(over)
    return body


# -------------------- 配置契约 --------------------


def test_first_cluster_becomes_default_and_is_redacted(client):
    res = client.post("/api/config/k8s-clusters", json=_token_cluster()).json()
    assert res["ok"] is True
    assert res["cluster"]["isDefault"] is True
    assert res["cluster"]["hasToken"] is True
    assert "token" not in res["cluster"]

    listed = client.get("/api/config/k8s-clusters").json()
    assert listed["localFallback"] is False
    assert listed["defaultClusterId"] == res["cluster"]["id"]
    assert listed["clusters"][0]["name"] == "生产集群 A"
    assert listed["localTarget"]["id"] == "local"
    assert {c["id"] for c in listed["targets"]} == {res["cluster"]["id"], "local"}
    assert "super-secret-token" not in client.get("/api/config/k8s-clusters").text


def test_cluster_id_is_slugified_and_editable_without_resending_secret(client):
    created = client.post("/api/config/k8s-clusters", json=_token_cluster(name="Staging EU")).json()["cluster"]
    assert created["id"] == "staging-eu"

    # 编辑时只改名字：未回传的 token 必须沿用旧值，否则等于把集群改坏
    updated = client.post(
        "/api/config/k8s-clusters",
        json={"id": created["id"], "name": "Staging EU 2", "server": "https://10.0.0.2:6443", "authType": "token"},
    ).json()["cluster"]
    assert updated["name"] == "Staging EU 2"
    assert updated["hasToken"] is True
    assert k8s_clusters.get_cluster(created["id"])["token"] == "super-secret-token"


def test_non_ascii_name_gets_url_safe_deterministic_id(client):
    first = client.post("/api/config/k8s-clusters", json=_token_cluster(name="生产集群 A")).json()["cluster"]
    assert first["id"].isascii(), first["id"]
    assert first["id"].startswith("cluster-")
    # 同名重复保存必须落到同一个 id，否则每存一次就多出一个集群
    again = client.post("/api/config/k8s-clusters", json=_token_cluster(name="生产集群 A")).json()["cluster"]
    assert again["id"] == first["id"]
    assert len(client.get("/api/config/k8s-clusters").json()["clusters"]) == 1


def test_missing_credentials_are_rejected(client):
    assert client.post("/api/config/k8s-clusters", json={"name": "x", "authType": "kubeconfig"}).status_code == 400
    assert client.post("/api/config/k8s-clusters", json={"name": "x", "authType": "token"}).status_code == 400
    assert client.post("/api/config/k8s-clusters", json={"name": "x"}).status_code == 400


def test_delete_default_promotes_next_cluster(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="A"))
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="B"))
    client.delete("/api/config/k8s-clusters/a")
    clusters = client.get("/api/config/k8s-clusters").json()
    assert [c["id"] for c in clusters["clusters"]] == ["b"]
    assert clusters["clusters"][0]["isDefault"] is True


def test_test_endpoint_reports_unreachable_without_raising(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="Unreachable", server="https://127.0.0.1:1"))
    res = client.post("/api/config/k8s-clusters/unreachable/test").json()
    assert res["ok"] is True
    assert res["reachable"] is False
    assert res["error"]


def test_test_endpoint_404_for_unknown_cluster(client):
    assert client.post("/api/config/k8s-clusters/nope/test").status_code == 404


# -------------------- 安全：绝不静默回退 --------------------


def test_unknown_cluster_reference_never_falls_back_to_local(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster())
    with pytest.raises(k8s_clusters.K8sClusterError):
        k8s_clusters.api_client("prod-that-does-not-exist")
    with pytest.raises(k8s_clusters.K8sClusterError):
        k8s_clusters.core_api("prod-that-does-not-exist")


def test_describe_and_resolve_ref(client):
    created = client.post("/api/config/k8s-clusters", json=_token_cluster(name="Prod A")).json()["cluster"]
    assert k8s_clusters.resolve_id(None) == created["id"]
    assert k8s_clusters.resolve_id("Prod A") == created["id"]
    assert "10.0.0.1:6443" in k8s_clusters.describe_ref("Prod A")
    assert k8s_clusters.resolve_id(None) != "nope"
    assert "未登记" in k8s_clusters.describe_ref("nope")


def test_local_cluster_is_first_class_target(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="Prod A"))
    assert k8s_clusters.is_local_ref("local") is True
    assert k8s_clusters.is_local_ref(k8s_clusters.LOCAL_CLUSTER_NAME) is True
    assert k8s_clusters.resolve_id("local") == "local"
    assert k8s_clusters.resolve_id(None) == "prod-a"
    assert "本地" in k8s_clusters.describe_ref("local")
    # 即使登记了远端默认集群，local 仍走进程内 kubeconfig，而不是被当作未登记报错
    assert k8s_clusters.api_client("local") is None
    with pytest.raises(k8s_clusters.K8sClusterError):
        k8s_clusters.api_client("local-typo")


def test_render_cluster_context_flags_local_vs_default(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="生产集群204"))
    note = k8s_clusters.render_cluster_context()
    assert 'cluster="local"' in note
    assert "生产集群204" in note
    assert "本地" in note


# -------------------- 技能与审批 --------------------


def test_list_clusters_tool_reports_registry(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="Prod A"))
    result = asyncio.run(k8s_skill.execute("list_clusters", {}))
    assert result.success is True
    assert result.data["localFallback"] is False
    assert [c["id"] for c in result.data["clusters"]] == ["prod-a", "local"]
    assert result.data["clusters"][-1]["isLocal"] is True
    assert result.data["clusters"][-1]["isDefault"] is False
    assert result.data["defaultCluster"] == "prod-a"


def test_list_clusters_tool_reports_local_fallback_when_empty():
    result = asyncio.run(k8s_skill.execute("list_clusters", {}))
    assert result.success is True
    assert [c["id"] for c in result.data["clusters"]] == ["local"]
    assert result.data["clusters"][0]["isDefault"] is True
    assert result.data["localFallback"] is True
    assert result.data["defaultCluster"] == "local"


def test_mutation_on_remote_cluster_keeps_approval_and_names_the_cluster(client):
    client.post("/api/config/k8s-clusters", json=_token_cluster(name="生产集群 A"))
    args = {
        "namespace": "order-service",
        "deployment_name": "order-api",
        "container_name": "order-api",
        "memory_limit_mi": 512,
        "cluster": "生产集群 A",
    }
    decision = classify_risk("k8s", "patch_resource_limits", args)
    assert decision.requiresApproval is True
    assert decision.level == "high"
    assert "生产集群 A" in (decision.blastRadius or "")
    assert "10.0.0.1:6443" in (decision.blastRadius or "")

    preview = render_diff_preview("k8s", "patch_resource_limits", args)
    assert "生产集群 A" in preview
    assert "+   512Mi" in preview


def test_all_k8s_tools_accept_cluster_param():
    for tool in k8s_skill.TOOLS:
        props = tool.parameters.get("properties") or {}
        if tool.name == "list_clusters":
            assert "cluster" not in props
        else:
            assert "cluster" in props, tool.name
