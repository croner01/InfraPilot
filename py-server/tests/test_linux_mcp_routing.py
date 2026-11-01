"""Linux skill 的 MCP 路由：mcp 型主机走远端 tools/call 且 host 归一为 local；ssh 型主机不受影响。"""

from __future__ import annotations

import asyncio

import pytest

from infrapilot import remote as remote_skill
from infrapilot.skills import linux as linux_skill


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def mcp_host_registry(monkeypatch):
    monkeypatch.setattr(
        remote_skill,
        "get_host",
        lambda name: {"name": name, "auth": {"type": "mcp", "endpoint": "10.9.9.9:8443"}} if name == "node-mcp" else None,
    )


@pytest.fixture
def ssh_host_registry(monkeypatch):
    monkeypatch.setattr(
        remote_skill,
        "get_host",
        lambda name: {"name": name, "auth": {"type": "agent"}} if name != "local" else None,
    )
    monkeypatch.setattr(
        remote_skill, "resolve_host", lambda name: ({"name": name, "auth": {"type": "agent"}}, name, [])
    )


def test_mcp_host_routes_to_remote_tool(mcp_host_registry, monkeypatch, tmp_path):
    calls: list[tuple[str, str, dict]] = []

    async def fake_call_tool(endpoint, name, args, timeout_ms=None):
        calls.append((endpoint, name, args))
        return linux_skill.ToolExecutionResult(success=True, stdout="ok", durationMs=1)

    from infrapilot import mcp_client

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)
    monkeypatch.setattr(mcp_client, "discover_endpoint", lambda host: "10.9.9.9:8443")

    result = run(linux_skill.execute("get_cpu_usage", {"host": "node-mcp"}))
    assert result.success is True
    assert calls[0] == ("10.9.9.9:8443", "linux__get_cpu_usage", {"host": "local"})


def test_mcp_host_without_endpoint_errors(mcp_host_registry, monkeypatch):
    from infrapilot import mcp_client

    monkeypatch.setattr(mcp_client, "discover_endpoint", lambda host: None)
    result = run(linux_skill.execute("get_cpu_usage", {"host": "node-mcp"}))
    assert result.success is False
    assert "未配置 endpoint" in (result.error or "")


def test_ssh_host_not_routed_via_mcp(ssh_host_registry, monkeypatch):
    from infrapilot import mcp_client

    def _boom(*a, **k):
        raise AssertionError("ssh 主机不应走 MCP 通道")

    monkeypatch.setattr(mcp_client, "call_tool", _boom)
    monkeypatch.setattr(mcp_client, "discover_endpoint", lambda host: None)
    monkeypatch.setattr(
        remote_skill, "fingerprint_files", lambda *a, **k: {"host": a[0], "files": [], "errors": ["unit"]}
    )
    # 只验证不触达 MCP 分支：read_file 走 SSH 失败路径（白名单/连接错误均可，关键是未进 call_tool）
    result = run(linux_skill.execute("read_file", {"host": "node-ssh", "path": "/etc/hostname"}))
    assert result is not None


def test_local_host_bypasses_mcp(monkeypatch):
    from infrapilot import mcp_client

    def _boom(*a, **k):
        raise AssertionError("local 不应触碰 MCP")

    monkeypatch.setattr(mcp_client, "call_tool", _boom)
    result = run(linux_skill.execute("read_file", {"host": "local", "path": "/etc/hostname"}))
    assert result is not None


def test_inspect_files_fingerprints_mcp_host(mcp_host_registry, monkeypatch):
    from infrapilot import mcp_client

    fingerprint = {
        "host": "node-mcp",
        "files": [{"path": "/usr/local/bin/helm", "exists": True, "size": 1, "mtime": 0, "mode": "755", "type": "file"}],
        "missing": [],
        "errors": [],
        "transport": "mcp",
    }

    async def fake_fingerprint(alias, paths, want_hash):
        return fingerprint

    monkeypatch.setattr(linux_skill, "_fingerprint_via_mcp", fake_fingerprint)
    result = run(
        linux_skill.execute("inspect_files", {"hosts": ["node-mcp"], "paths": ["/usr/local/bin/helm"]})
    )
    assert result.success is True
    assert (result.data or {}).get("hosts") == [fingerprint]


def test_fingerprint_via_mcp_runs_stat(monkeypatch):
    from infrapilot import mcp_client

    # remote.parse_stat_lines 期望 "路径@@类型@@大小@@mtime@@mode"
    stat_out = "/usr/local/bin/helm@@file@@5@@1730000000@@755"

    async def fake_call_tool(endpoint, name, args, timeout_ms=None):
        assert name == "linux__run_command"
        assert args["command"] == "stat"
        return linux_skill.ToolExecutionResult(success=True, stdout=stat_out, stderr="", durationMs=1)

    monkeypatch.setattr(mcp_client, "call_tool", fake_call_tool)
    monkeypatch.setattr(mcp_client, "discover_endpoint", lambda host: "10.9.9.9:8443")

    entry = run(linux_skill._fingerprint_via_mcp("node-mcp", ["/usr/local/bin/helm"], want_hash=False))
    assert entry["host"] == "node-mcp"
    assert entry["files"][0]["path"] == "/usr/local/bin/helm"
    assert entry["transport"] == "mcp"
