"""P3 CLI / ChatOps：事件渲染 + 子命令（用假 HTTP 客户端，不联网）。"""

from __future__ import annotations

from infrapilot import cli


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.closed = False

    def post(self, path, **kwargs):
        self.calls.append(("POST", path))
        if path == "/sessions":
            return {"id": "s1"}
        if path == "/eval/judge":
            return {"score": 0.9, "verdict": "pass", "mode": "llm", "rationale": "证据充分", "weaknesses": []}
        return {"ok": True}

    def get(self, path, **kwargs):
        self.calls.append(("GET", path))
        if path == "/sessions":
            return [{"id": "s1", "status": "concluded", "title": "kafka 起不来"}]
        if path == "/sessions/s1/events":
            return [
                {"id": "e1", "type": "tool_call_start", "payload": {"skill": "k8s", "tool": "list_pods"}},
                {"id": "e2", "type": "assistant_message", "payload": {"content": "已定位"}},
                {"id": "e3", "type": "rca_conclusion", "payload": {"content": "emptyDir 被驱逐"}},
                {"id": "e4", "type": "done", "payload": {}},
            ]
        if path == "/sessions/s1":
            return {"id": "s1", "status": "concluded", "title": "t", "iteration": 3, "evidence": [{"id": "ev"}], "executedToolCalls": [], "rootCause": {"summary": "R", "confidence": 0.8}}
        if path == "/sessions/s1/artifacts":
            return {"artifacts": [{"name": "a.drawio", "size": 10, "mime": "application/xml", "downloadUrl": "/api/artifacts/x/download"}]}
        return {}

    def close(self):
        self.closed = True


def test_format_event_variants():
    assert cli.format_event({"type": "assistant_message", "payload": {"content": "hi"}}) == "🤖 hi"
    assert "根因结论" in cli.format_event({"type": "rca_conclusion", "payload": {"content": "X"}})
    assert "需要审批" in cli.format_event({"type": "approval_request", "payload": {"skill": "k8s", "tool": "patch", "risk": {"level": "high"}, "args": {}}})
    assert cli.format_event({"type": "error", "payload": {"message": "boom"}}).startswith("❌")
    assert cli.format_event({"type": "done", "payload": {}}) is None
    # 过程事件仅在 verbose 下展示
    tool_event = {"type": "tool_call_start", "payload": {"skill": "k8s", "tool": "list_pods"}}
    assert cli.format_event(tool_event) is None
    assert "k8s.list_pods" in cli.format_event(tool_event, verbose=True)
    steps = cli.format_event({"type": "remediation_plan", "payload": {"summary": "提高 limit", "steps": [{"description": "patch"}]}})
    assert "提高 limit" in steps and "1. patch" in steps


def test_render_session_and_artifacts():
    text = cli.render_session({"id": "s1", "status": "concluded", "title": "t", "iteration": 2, "evidence": [], "executedToolCalls": [], "rootCause": {"summary": "R", "confidence": 0.7}})
    assert "s1" in text and "R" in text
    assert cli.render_artifacts([]) == "（无产物）"
    assert "a.drawio" in cli.render_artifacts([{"name": "a.drawio", "size": 1, "mime": "text/plain", "downloadUrl": "/d"}])


def test_cmd_ask_follows_until_concluded():
    client = FakeClient()
    args = cli.build_parser().parse_args(["ask", "kafka 起不来"])
    lines: list[str] = []
    assert cli.cmd_ask(client, args, lines.append) == 0
    joined = "\n".join(lines)
    assert "[session] s1" in joined
    assert "已定位" in joined and "emptyDir 被驱逐" in joined
    assert ("POST", "/sessions/s1/messages") in client.calls


def test_cmd_sessions_show_artifacts_judge():
    client = FakeClient()
    parser = cli.build_parser()
    out: list[str] = []

    assert cli.cmd_sessions(client, parser.parse_args(["sessions"]), out.append) == 0
    assert any("kafka 起不来" in line for line in out)

    out.clear()
    assert cli.cmd_show(client, parser.parse_args(["show", "s1"]), out.append) == 0
    assert any("已定位" in line for line in out)

    out.clear()
    assert cli.cmd_artifacts(client, parser.parse_args(["artifacts", "s1"]), out.append) == 0
    assert any("a.drawio" in line for line in out)

    out.clear()
    assert cli.cmd_judge(client, parser.parse_args(["judge", "s1"]), out.append) == 0
    assert any("pass" in line for line in out)


def test_main_uses_client_and_handles_errors(monkeypatch, capsys):
    fake = FakeClient()
    monkeypatch.setattr(cli, "ApiClient", lambda base, token=None: fake)
    assert cli.main(["sessions"]) == 0
    assert fake.closed is True
    assert "kafka 起不来" in capsys.readouterr().out

    class Boom(FakeClient):
        def get(self, path, **kwargs):
            raise RuntimeError("GET /sessions -> 500: boom")

    monkeypatch.setattr(cli, "ApiClient", lambda base, token=None: Boom())
    assert cli.main(["sessions"]) == 1
