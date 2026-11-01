"""端侧 / CLI 入口（P3）—— 对应差距分析 §3 #17（设计文档 §15 已规划的 ChatOps 入口）。

用法：
    python3 -m infrapilot.cli ask "分析 islap 下 kafka 起不来的原因"
    python3 -m infrapilot.cli sessions
    python3 -m infrapilot.cli show <sessionId> [--verbose]
    python3 -m infrapilot.cli artifacts <sessionId>
    python3 -m infrapilot.cli judge <sessionId>

默认连接 `INFRAPILOT_BASE_URL`（或 `--base`，默认 http://localhost:8787）。
输出为聊天式纯文本；`--json` 输出原始 JSON，便于接入 Slack/飞书等 ChatOps 机器人。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Callable, Optional

import httpx

Out = Callable[[str], None]

_RISK_MARK = {"medium": "🟡", "high": "🟠", "critical": "🔴"}


class ApiClient:
    def __init__(self, base_url: str, *, token: Optional[str] = None, timeout: float = 30) -> None:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._client = httpx.Client(base_url=f"{base_url.rstrip('/')}/api", headers=headers, timeout=timeout)

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        res = self._client.request(method, path, **kwargs)
        if res.status_code >= 400:
            try:
                detail = res.json().get("error")
            except Exception:  # noqa: BLE001
                detail = res.text[:200]
            raise RuntimeError(f"{method} {path} -> {res.status_code}: {detail}")
        return res.json()

    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, **kw: Any) -> Any:
        return self.request("POST", path, **kw)

    def close(self) -> None:
        self._client.close()


# -------------------- 展示（纯函数，便于测试） --------------------


def format_event(event: dict[str, Any], *, verbose: bool = False) -> Optional[str]:
    kind = event.get("type")
    payload = event.get("payload") or {}
    if kind == "assistant_message":
        return f"🤖 {payload.get('content', '')}"
    if kind == "rca_conclusion":
        return f"🎯 根因结论：{payload.get('content', '')}"
    if kind == "remediation_plan":
        steps = payload.get("steps") or []
        body = payload.get("summary") or ""
        lines = [f"🛠  修复方案：{body}"]
        for index, step in enumerate(steps, 1):
            desc = step.get("description") if isinstance(step, dict) else str(step)
            lines.append(f"   {index}. {desc}")
        return "\n".join(lines)
    if kind == "approval_request":
        mark = _RISK_MARK.get(str(payload.get("risk", {}).get("level")), "⚠️")
        return f"{mark} 需要审批：{payload.get('skill')}.{payload.get('tool')} args={json.dumps(payload.get('args'), ensure_ascii=False)} (approvalId={payload.get('approvalId')})"
    if kind == "approval_decision":
        return f"✅ 审批结果：{payload.get('decision')} by {payload.get('decidedBy')}"
    if kind == "error":
        return f"❌ 错误：{payload.get('message')}"
    if kind == "status" and payload.get("message"):
        return f"ℹ️  {payload.get('message')}"
    if verbose and kind == "tool_call_start":
        return f"· 调用 {payload.get('skill')}.{payload.get('tool')}"
    if verbose and kind == "context_compressed":
        return f"· 上下文压缩 {payload.get('beforeTokens')}→{payload.get('afterTokens')} tokens"
    return None


def render_session(session: dict[str, Any], *, verbose: bool = False) -> str:
    lines = [
        f"会话 {session.get('id')}  [{session.get('status')}]  {session.get('title')}",
        f"  迭代: {session.get('iteration')}  证据: {len(session.get('evidence') or [])}  工具调用: {len(session.get('executedToolCalls') or [])}",
    ]
    root_cause = session.get("rootCause")
    if root_cause:
        lines.append(f"  根因: {root_cause.get('summary')} (置信度 {root_cause.get('confidence')})")
    remediation = session.get("remediation")
    if remediation:
        lines.append(f"  修复: {remediation.get('summary')}")
    if verbose:
        for call in session.get("executedToolCalls") or []:
            lines.append(f"  · {call.get('skill')}.{call.get('tool')}")
    return "\n".join(lines)


def render_artifacts(artifacts: list[dict[str, Any]]) -> str:
    if not artifacts:
        return "（无产物）"
    return "\n".join(f"- {a['name']}  {a['size']}B  {a['mime']}  {a['downloadUrl']}" for a in artifacts)


# -------------------- 命令 --------------------


def follow(client: ApiClient, session_id: str, out: Out, *, verbose: bool, timeout_s: float = 900, interval: float = 1.0) -> None:
    """轮询会话时间线并打印新事件，直到 done / 终态 / 超时。"""
    seen: set[str] = set()
    deadline = time.time() + timeout_s
    last_status = ""
    while time.time() < deadline:
        events = client.get(f"/sessions/{session_id}/events")
        for event in events:
            if event.get("id") in seen:
                continue
            seen.add(event.get("id"))
            line = format_event(event, verbose=verbose)
            if line:
                out(line)
        session = client.get(f"/sessions/{session_id}")
        status = session.get("status")
        if status != last_status:
            last_status = status
        if status in ("concluded", "closed") or any(e.get("type") == "done" for e in events):
            if status in ("concluded", "closed"):
                out(render_session(session, verbose=verbose))
            return
        if status == "awaiting_approval":
            out("（等待人工审批，可稍后用 `show` 查看进度）")
            return
        time.sleep(interval)
    out("（等待超时，未收到最终结论）")


def cmd_ask(client: ApiClient, args: argparse.Namespace, out: Out) -> int:
    if args.session:
        session_id = args.session
    else:
        session_id = client.post("/sessions", json={"title": args.message[:80]})["id"]
        out(f"[session] {session_id}")
    client.post(f"/sessions/{session_id}/messages", json={"message": args.message})
    if args.json:
        out(json.dumps(client.get(f"/sessions/{session_id}"), ensure_ascii=False, indent=2))
        return 0
    if not args.wait:
        return 0
    follow(client, session_id, out, verbose=args.verbose, timeout_s=args.timeout)
    return 0


def cmd_sessions(client: ApiClient, args: argparse.Namespace, out: Out) -> int:
    sessions = client.get("/sessions")
    if args.json:
        out(json.dumps(sessions, ensure_ascii=False, indent=2))
        return 0
    if not sessions:
        out("（无会话）")
        return 0
    for session in sessions[: args.limit]:
        out(f"{session.get('id')}  [{session.get('status'):>17}]  {session.get('title')}")
    return 0


def cmd_show(client: ApiClient, args: argparse.Namespace, out: Out) -> int:
    session = client.get(f"/sessions/{args.session_id}")
    if args.json:
        out(json.dumps(session, ensure_ascii=False, indent=2))
        return 0
    out(render_session(session, verbose=args.verbose))
    for event in client.get(f"/sessions/{args.session_id}/events"):
        line = format_event(event, verbose=args.verbose)
        if line:
            out(line)
    return 0


def cmd_artifacts(client: ApiClient, args: argparse.Namespace, out: Out) -> int:
    items = client.get(f"/sessions/{args.session_id}/artifacts")["artifacts"]
    if args.json:
        out(json.dumps(items, ensure_ascii=False, indent=2))
        return 0
    out(render_artifacts(items))
    return 0


def cmd_judge(client: ApiClient, args: argparse.Namespace, out: Out) -> int:
    result = client.post("/eval/judge", json={"sessionId": args.session_id, "allowLlm": not args.offline})
    if args.json:
        out(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("verdict") == "pass" else 2
    out(f"评分 {result.get('score')} → {result.get('verdict')} ({result.get('mode')})")
    out(f"说明: {result.get('rationale')}")
    for weakness in result.get("weaknesses") or []:
        out(f"  ⚠️ {weakness}")
    return 0 if result.get("verdict") == "pass" else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="infrapilot", description="InfraPilot CLI / ChatOps")
    parser.add_argument("--base", default=os.environ.get("INFRAPILOT_BASE_URL") or "http://localhost:8787")
    parser.add_argument("--token", default=os.environ.get("INFRAPILOT_TOKEN") or "")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON")
    parser.add_argument("--verbose", action="store_true", help="显示工具调用等过程事件")
    sub = parser.add_subparsers(dest="command", required=True)

    ask = sub.add_parser("ask", help="发起一次诊断")
    ask.add_argument("message")
    ask.add_argument("--session", help="复用已有会话继续对话")
    ask.add_argument("--timeout", type=float, default=900)
    ask.add_argument("--no-wait", dest="wait", action="store_false", help="只提交，不等待结论")
    ask.set_defaults(handler=cmd_ask)

    sessions = sub.add_parser("sessions", help="列出会话")
    sessions.add_argument("--limit", type=int, default=20)
    sessions.set_defaults(handler=cmd_sessions)

    show = sub.add_parser("show", help="查看会话详情与时间线")
    show.add_argument("session_id")
    show.set_defaults(handler=cmd_show)

    artifacts = sub.add_parser("artifacts", help="列出会话产物")
    artifacts.add_argument("session_id")
    artifacts.set_defaults(handler=cmd_artifacts)

    judge = sub.add_parser("judge", help="对会话做 LLM-as-judge 评分")
    judge.add_argument("session_id")
    judge.add_argument("--offline", action="store_true", help="仅用启发式评分，不调用 LLM")
    judge.set_defaults(handler=cmd_judge)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    client = ApiClient(args.base, token=args.token or None)
    out: Out = print
    try:
        return int(args.handler(client, args, out))
    except RuntimeError as err:
        print(f"错误: {err}", file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
