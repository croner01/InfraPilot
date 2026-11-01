"""P3 会话产物：登记/列表/下载/删除 + 路径白名单 + 工具结果自动登记。"""

from __future__ import annotations

import asyncio

from infrapilot import artifacts, gateway, sessions
from infrapilot.models import PendingToolCall, RiskDecision, ToolExecutionResult


def run(coro):
    return asyncio.run(coro)


def _write(name: str, content: str = "hello") -> str:
    artifacts.ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    path = artifacts.ARTIFACTS_DIR / name
    path.write_text(content, encoding="utf-8")
    return str(path)


def test_register_list_get_delete_roundtrip():
    session = sessions.create_session("artifact-roundtrip")
    path = _write("roundtrip.txt", "abcdef")
    row = artifacts.register(path, session_id=session.id, kind="test")
    assert row["name"] == "roundtrip.txt"
    assert row["size"] == 6
    assert row["mime"] == "text/plain"
    assert row["downloadUrl"] == f"/api/artifacts/{row['id']}/download"
    assert row["sha256"]

    assert any(a["id"] == row["id"] for a in artifacts.list_for_session(session.id))
    assert artifacts.get(row["id"])["id"] == row["id"]
    assert artifacts.file_path(row["id"]).read_text() == "abcdef"

    # 幂等：同会话同路径不重复登记
    assert artifacts.register(path, session_id=session.id)["id"] == row["id"]

    assert artifacts.delete(row["id"]) is True
    assert artifacts.get(row["id"]) is None
    assert not artifacts.file_path(row["id"])


def test_register_rejects_missing_and_outside_paths():
    assert artifacts.register("/etc/passwd") is None
    assert artifacts.register(str(artifacts.ARTIFACTS_DIR / "nope.txt")) is None
    try:
        artifacts.resolve_safe("../../etc/passwd")
        assert False, "应当拒绝目录穿越"
    except ValueError:
        pass
    try:
        artifacts.resolve_safe("/tmp/evil.txt")
        assert False, "应当拒绝白名单外路径"
    except ValueError:
        pass


def test_mime_overrides():
    assert artifacts.mime_for(artifacts.ARTIFACTS_DIR / "x.drawio") == "application/xml"
    assert artifacts.mime_for(artifacts.ARTIFACTS_DIR / "x.md") == "text/markdown"
    assert artifacts.mime_for(artifacts.ARTIFACTS_DIR / "x.csv") == "text/csv"


def test_register_from_tool_result_handles_drawio_and_sandbox():
    session = sessions.create_session("artifact-tools")
    drawio_path = _write("flow.drawio", "<mxfile/>")
    sandbox_dir = artifacts.SANDBOX_DIR / "run-1"
    sandbox_dir.mkdir(parents=True, exist_ok=True)
    (sandbox_dir / "out.csv").write_text("a,b\n1,2\n", encoding="utf-8")

    got = artifacts.register_from_tool_result(session.id, "drawio", "generate_flowchart", {"output_path": drawio_path})
    assert len(got) == 1 and got[0]["kind"] == "drawio"

    got2 = artifacts.register_from_tool_result(
        session.id, "interpreter", "run_python", {"workdir": str(sandbox_dir), "files": ["out.csv"], "stdout": "ok"}
    )
    assert len(got2) == 1
    assert got2[0]["name"] == "out.csv"
    assert got2[0]["kind"] == "interpreter-output"
    # 非文件类结果不应登记
    assert artifacts.register_from_tool_result(session.id, "k8s", "list_pods", {"pods": []}) == []


def test_gateway_registers_artifact_after_tool_call(monkeypatch):
    from infrapilot import skills

    session = sessions.create_session("artifact-gateway")
    produced = _write("from-gateway.txt", "gw")

    async def fake_dispatch(skill, tool, args):
        return ToolExecutionResult(success=True, data={"output_path": produced}, durationMs=1)

    monkeypatch.setattr(skills, "dispatch", fake_dispatch)
    pending = PendingToolCall(
        id="tc-1",
        skill="drawio",
        tool="generate_flowchart",
        args={},
        risk=RiskDecision(level="readonly", reason="只读", requiresApproval=False, requiresTwoPerson=False),
    )
    result = run(gateway.execute_tool_call(pending, session.id, "agent"))
    assert result.success is True
    names = [a["name"] for a in artifacts.list_for_session(session.id)]
    assert "from-gateway.txt" in names
