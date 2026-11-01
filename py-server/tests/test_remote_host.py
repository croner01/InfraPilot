"""远程主机（SSH）通道：只读白名单、命令构造、审批升级与宿主指纹差分。"""

from __future__ import annotations

import asyncio

import pytest

from infrapilot import policy
from infrapilot.skills import linux as linux_skill
from infrapilot import remote as remote_skill


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _inline_to_thread(monkeypatch):
    """本仓库的沙箱里 stdlib asyncio.to_thread 会永久阻塞(工作线程无法被唤醒, 纯 stdlib 可复现);
    生产容器内正常。这里改为同步执行, 以便验证远端路由与结果映射本身。"""

    async def inline(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", inline)


class _FakeChannel:
    def __init__(self, code: int = 0) -> None:
        self._code = code

    def recv_exit_status(self) -> int:
        return self._code


class _FakeStream:
    def __init__(self, text: str, code: int = 0) -> None:
        self._text = text.encode()
        self.channel = _FakeChannel(code)

    def read(self) -> bytes:
        return self._text


class _FakeClient:
    def __init__(self, stdout: str = "", stderr: str = "", code: int = 0) -> None:
        self.calls: list[str] = []
        self._stdout = stdout
        self._stderr = stderr
        self._code = code
        self.closed = False

    def exec_command(self, cmd_line: str, timeout: float | None = None):
        self.calls.append(cmd_line)
        return None, _FakeStream(self._stdout, self._code), _FakeStream(self._stderr, self._code)

    def close(self) -> None:
        self.closed = True


# -------------------- 白名单与命令构造 --------------------


@pytest.mark.parametrize("command", ["rm", "reboot", "chmod", "sudo", "/bin/ls", "./stat"])
def test_remote_allowlist_rejects_dangerous_or_paths(command):
    assert remote_skill.validate_command(command, []) is not None


@pytest.mark.parametrize("command", ["stat", "cat", "ls", "sha256sum", "journalctl", "dmesg", "kubectl"])
def test_remote_allowlist_accepts_readonly(command):
    assert remote_skill.validate_command(command, ["-c", "%s", "/tmp"]) is None


@pytest.mark.parametrize(
    "args",
    [["restart", "kubelet"], ["stop", "docker"], ["daemon-reload"]],
)
def test_remote_rejects_systemctl_mutations(args):
    err = remote_skill.validate_command("systemctl", args)
    assert err is not None and "变更" in err


def test_remote_rejects_kubectl_mutations():
    assert remote_skill.validate_command("kubectl", ["delete", "pod", "x", "-n", "ems"]) is not None
    assert remote_skill.validate_command("kubectl", ["get", "pods", "-n", "ems"]) is None


def test_remote_rejects_arg_with_newline():
    assert remote_skill.validate_command("cat", ["/etc/passwd\nrm -rf /"]) is not None


def test_command_line_is_shell_quoted():
    line = remote_skill.build_command_line("stat", ["-c", "%n %s", "/tmp/a b;rm -rf /"])
    # 每个参数单独单引号包裹: 分号不会被远端 shell 解释为命令分隔符
    assert line == "stat -c '%n %s' '/tmp/a b;rm -rf /'"


# -------------------- 执行路径 --------------------


def test_unknown_host_returns_registry_hint(monkeypatch):
    monkeypatch.setattr(remote_skill, "resolve_host", lambda name: (None, None, []))
    monkeypatch.setattr(remote_skill, "list_hosts", lambda: [{"name": "node-1", "hostname": "10.0.0.1", "port": 22}])
    res = remote_skill.ssh_execute("nope", "stat", ["/tmp"])
    assert res["success"] is False
    assert "Host Registry" in res["error"] and "node-1" in res["error"]


def test_ssh_execute_redacts_and_routes(monkeypatch):
    fake = _FakeClient(stdout="password=supersecret123")
    monkeypatch.setattr(remote_skill, "resolve_host", lambda name: ({"name": name, "hostname": "h", "auth": {"type": "password", "password": "x"}}, name, []))
    monkeypatch.setattr(remote_skill, "_connect", lambda cfg: fake)
    res = remote_skill.ssh_execute("node-1", "stat", ["-c", "%s", "/usr/local/bin/helm"])
    assert res["success"] is True
    assert fake.calls and fake.calls[0].startswith("stat -c")
    assert "supersecret123" not in (res["stdout"] or "") and "REDACTED" in (res["stdout"] or "")
    assert fake.closed is True


def test_ssh_execute_refuses_when_validation_fails(monkeypatch):
    called = {"connected": False}

    def _boom(cfg):
        called["connected"] = True
        raise AssertionError("不应建立连接")

    monkeypatch.setattr(remote_skill, "resolve_host", lambda name: ({"name": name, "hostname": "h"}, name, []))
    monkeypatch.setattr(remote_skill, "_connect", _boom)
    res = remote_skill.ssh_execute("node-1", "rm", ["-rf", "/"])
    assert res["success"] is False
    assert called["connected"] is False


def test_execute_on_host_routes_remote_through_ssh(monkeypatch):
    fake = _FakeClient(stdout="Mem: 100")
    monkeypatch.setattr(remote_skill, "resolve_host", lambda name: ({"name": name, "hostname": "h"}, name, []))
    monkeypatch.setattr(remote_skill, "_connect", lambda cfg: fake)
    result = run(linux_skill.execute_on_host("node-1", "free", ["-m"]))
    assert result.success is True and "Mem: 100" in (result.stdout or "")
    assert fake.calls == ["free -m"]


# -------------------- 审批升级 --------------------


def test_remote_linux_tool_requires_approval():
    local = policy.classify_risk("linux", "get_memory_info", {"host": "local"})
    assert local.requiresApproval is False

    remote = policy.classify_risk("linux", "get_memory_info", {"host": "node-1"})
    assert remote.requiresApproval is True
    assert remote.level == "medium"
    assert "node-1" in (remote.blastRadius or "")


def test_inspect_files_requires_approval_and_preview_shows_ssh():
    decision = policy.classify_risk("linux", "inspect_files", {"hosts": ["node-1", "node-2"], "paths": ["/usr/local/bin/helm"]})
    assert decision.requiresApproval is True
    preview = policy.render_diff_preview("linux", "inspect_files", {"hosts": ["node-1", "node-2"], "paths": ["/usr/local/bin/helm"]})
    assert "ssh" in preview and "stat" in preview


def test_local_only_inspect_files_still_approval_gated_by_definition():
    # inspect_files 定义了 medium(跨主机比对本身有远端语义)，本地调用同样要审批
    decision = policy.classify_risk("linux", "inspect_files", {"hosts": ["local"], "paths": ["/tmp/x"]})
    assert decision.requiresApproval is True


# -------------------- 宿主指纹差分 --------------------


def test_fingerprint_files_parses_stat_and_hash(monkeypatch):
    stat_out = "/usr/local/bin/helm@@regular file@@59383970@@1757000000@@755"
    sha_out = "deadbeef  /usr/local/bin/helm"
    calls: list[str] = []

    def fake_exec(host, command, args, timeout_ms=0, caller=""):
        calls.append(command)
        return {"success": True, "stdout": stat_out if command == "stat" else sha_out, "stderr": "", "code": 0, "host": host}

    monkeypatch.setattr(remote_skill, "ssh_execute", fake_exec)
    res = remote_skill.fingerprint_files("node-1", ["/usr/local/bin/helm"], want_hash=True)
    assert calls == ["stat", "sha256sum"]
    f = res["files"][0]
    assert f["size"] == 59383970 and f["mode"] == "755" and f["sha256"] == "deadbeef"
    assert f["mtimeIso"].startswith("2025-09-04")


def test_diff_fingerprints_finds_node_drift():
    per_host = [
        {"host": "node-1", "files": [{"path": "/usr/local/bin/helm", "type": "regular file", "size": 59383970, "mtime": 1, "mode": "755"}]},
        {"host": "node-2", "files": [{"path": "/usr/local/bin/helm", "type": "regular file", "size": 40501248, "mtime": 2, "mode": "755"}]},
        {"host": "node-3", "files": [{"path": "/usr/local/bin/helm", "type": "regular file", "size": 40501248, "mtime": 2, "mode": "755"}]},
    ]
    diffs = linux_skill._diff_fingerprints(per_host, ["/usr/local/bin/helm"])
    assert len(diffs) == 1
    groups = diffs[0]["groups"]
    assert groups[0]["hosts"] == ["node-2", "node-3"]
    assert groups[1]["hosts"] == ["node-1"]


def test_diff_fingerprints_ignores_missing_path_everywhere():
    per_host = [
        {"host": "node-1", "files": []},
        {"host": "node-2", "files": []},
    ]
    assert linux_skill._diff_fingerprints(per_host, ["/nope"]) == []


def test_inspect_files_rejects_relative_paths():
    res = run(linux_skill.execute("inspect_files", {"hosts": ["local"], "paths": ["relative/path"]}))
    assert res.success is False and "绝对路径" in (res.error or "")


def test_inspect_files_renders_diff(monkeypatch):
    async def fake_local(paths, want_hash):
        return {"host": "local", "files": [{"path": paths[0], "type": "regular file", "size": 1, "mtime": 5, "mode": "644"}], "missing": [], "errors": []}

    def fake_remote(host, paths, want_hash=False, timeout_ms=0):
        return {"host": host, "files": [{"path": paths[0], "type": "regular file", "size": 2, "mtime": 6, "mode": "644"}], "missing": [], "errors": []}

    monkeypatch.setattr(linux_skill, "_fingerprint_local", fake_local)
    monkeypatch.setattr(remote_skill, "fingerprint_files", fake_remote)
    res = run(linux_skill.execute("inspect_files", {"hosts": ["local", "node-1"], "paths": ["/usr/local/bin/helm"]}))
    assert res.success is True
    assert "DIFF" in (res.stdout or "")
    assert res.data["differing"][0]["path"] == "/usr/local/bin/helm"


# -------------------- 主机别名解析 --------------------


def _fake_registry(hosts):
    return {"hosts": hosts}


def test_resolve_host_exact_match(monkeypatch):
    monkeypatch.setattr(
        remote_skill.config_store, "get_host_registry", lambda: _fake_registry([{"name": "node-1", "hostname": "h"}])
    )
    cfg, alias, ambiguous = remote_skill.resolve_host("node-1")
    assert cfg and alias == "node-1" and ambiguous == []


def test_resolve_host_suffix_match_maps_k8s_node_name(monkeypatch):
    monkeypatch.setattr(
        remote_skill.config_store,
        "get_host_registry",
        lambda: _fake_registry([{"name": "生产集群204-node-1", "hostname": "h"}]),
    )
    cfg, alias, ambiguous = remote_skill.resolve_host("node-1")
    assert cfg is not None and alias == "生产集群204-node-1" and ambiguous == []


def test_resolve_host_refuses_ambiguous_suffix(monkeypatch):
    monkeypatch.setattr(
        remote_skill.config_store,
        "get_host_registry",
        lambda: _fake_registry([{"name": "集群A-node-1", "hostname": "a"}, {"name": "集群B-node-1", "hostname": "b"}]),
    )
    cfg, alias, ambiguous = remote_skill.resolve_host("node-1")
    assert cfg is None and alias is None
    assert sorted(ambiguous) == ["集群A-node-1", "集群B-node-1"]


def test_ssh_execute_reports_ambiguous_alias(monkeypatch):
    monkeypatch.setattr(
        remote_skill.config_store,
        "get_host_registry",
        lambda: _fake_registry([{"name": "集群A-node-1", "hostname": "a"}, {"name": "集群B-node-1", "hostname": "b"}]),
    )
    res = remote_skill.ssh_execute("node-1", "stat", ["/usr/local/bin/helm"])
    assert res["success"] is False
    assert "不唯一" in res["error"] and "集群A-node-1" in res["error"]
