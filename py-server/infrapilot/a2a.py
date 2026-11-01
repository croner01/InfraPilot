"""A2A（Agent-to-Agent）协议支持（P3）—— 对应差距分析 §3 #16。

把 InfraPilot 作为可被其他 Agent 调用的 A2A 服务端：
- Agent Card：`GET /.well-known/agent.json`（同时提供 `/.well-known/agent-card.json`）；
- JSON-RPC 端点：`POST /api/a2a`，实现 `message/send`、`message/stream`、
  `tasks/get`、`tasks/cancel`、`tasks/resubscribe`；
- Task↔Session 映射：A2A 的 task id 即 InfraPilot 会话 id，状态按会话状态映射为
  submitted / working / input-required / completed / canceled / failed；
- 会话产物（P3 #15）以 A2A artifact 的 file part 形式返回（uri + mimeType）。

流式：`message/stream` 通过 SSE 返回 `Task` → 若干 `status-update` / `artifact-update`，
最后以 `final=true` 的 `status-update` 收尾；`tasks/resubscribe` 支持断线重连
（回放已持久化时间线 + 续订实时事件，SSE `id:` / `Last-Event-ID` 增量补齐）。
Agent Card `capabilities.streaming=true`。
非流式调用方仍可用 `message/send` + 轮询 `tasks/get`，或传 `configuration.blocking=true`。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Optional

from . import artifacts as artifacts_mod
from . import db
from . import sessions
from .bus import bus
from .util import new_id, now_iso

AGENT_VERSION = "0.4.0"
A2A_PROTOCOL_VERSION = "0.2.5"

# SSE 空闲心跳间隔（秒）
STREAM_IDLE_SECONDS = 15.0

# 避免非阻塞任务被 GC 回收
_background: set[asyncio.Task] = set()

# 进行中的诊断轮次（session_id → task），供 `tasks/resubscribe` 判断是否仍在运行
_active_turns: dict[str, asyncio.Task] = {}

_STATE_MAP = {
    "intake": "submitted",
    "planning": "working",
    "executing": "working",
    "reflecting": "working",
    "remediating": "working",
    "awaiting_approval": "input-required",
    "concluded": "completed",
    "closed": "canceled",
}


def agent_card(base_url: str) -> dict[str, Any]:
    return {
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "name": "InfraPilot",
        "description": "AI SRE Agent：Kubernetes / Linux / OpenSearch / OpenStack 故障诊断与受控修复",
        "url": f"{base_url.rstrip('/')}/api/a2a",
        "version": AGENT_VERSION,
        "provider": {"organization": "InfraPilot"},
        "capabilities": {"streaming": True, "pushNotifications": False, "stateTransitionHistory": True},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            {"id": "diagnose", "name": "故障诊断", "description": "多数据源交叉验证的根因分析（RCA）", "tags": ["sre", "rca", "kubernetes", "logs"]},
            {"id": "remediate", "name": "受控修复", "description": "经审批网关执行的变更操作（五级风险 + 双人审批）", "tags": ["remediation", "approval"]},
            {"id": "topology", "name": "服务拓扑", "description": "K8s 服务拓扑发现", "tags": ["topology"]},
            {"id": "evaluate", "name": "评测", "description": "LLM-as-judge 会话质量评分", "tags": ["eval", "judge"]},
        ],
    }


def _text_of(message: dict[str, Any]) -> str:
    parts = message.get("parts") or []
    chunks = [str(p.get("text") or "") for p in parts if isinstance(p, dict) and p.get("kind") in ("text", None)]
    return "\n".join(c for c in chunks if c).strip()


def _status_payload(state: str, text: Optional[str] = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"state": state, "timestamp": now_iso()}
    if text:
        payload["message"] = {"role": "agent", "parts": [{"kind": "text", "text": text}]}
    return payload


def _status(session: Any) -> dict[str, Any]:
    state = _STATE_MAP.get(getattr(session, "status", "") or "", "working")
    text = None
    if state == "completed" and getattr(session, "rootCause", None):
        text = session.rootCause.summary
    elif state == "input-required":
        text = "等待人工审批后继续"
    return _status_payload(state, text)


def _artifact_parts(artifact: dict[str, Any]) -> dict[str, Any]:
    return {
        "artifactId": artifact["id"],
        "name": artifact["name"],
        "parts": [
            {
                "kind": "file",
                "file": {"name": artifact["name"], "mimeType": artifact["mime"], "uri": artifact["downloadUrl"]},
            }
        ],
    }


def _task_of(session: Any) -> dict[str, Any]:
    session_artifacts = artifacts_mod.list_for_session(session.id)
    artifacts = [_artifact_parts(a) for a in session_artifacts]
    history: list[dict[str, Any]] = []
    if getattr(session, "incidentSummary", None):
        history.append({"role": "user", "parts": [{"kind": "text", "text": session.incidentSummary}]})
    if getattr(session, "rootCause", None):
        history.append({"role": "agent", "parts": [{"kind": "text", "text": session.rootCause.summary}]})
    return {
        "id": session.id,
        "contextId": session.id,
        "kind": "task",
        "status": _status(session),
        "artifacts": artifacts,
        "history": history,
        "metadata": {
            "title": session.title,
            "infrapilotStatus": session.status,
            "iteration": session.iteration,
            "evidenceCount": len(session.evidence or []),
        },
    }


def _rpc_ok(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


async def _run_turn(session_id: str, text: str) -> None:
    from .orchestrator import start_agent_turn

    try:
        await start_agent_turn(session_id, text)
    except Exception as err:  # noqa: BLE001 - A2A 后台任务失败不应影响响应
        print(f"[a2a] 会话 {session_id} 执行失败: {err}")


def _spawn_turn(session_id: str, text: str) -> asyncio.Task:
    """启动后台诊断轮次并登记到 `_active_turns`（供 resubscribe 判断活跃状态）。"""
    task = asyncio.create_task(_run_turn(session_id, text))
    _background.add(task)
    _active_turns[session_id] = task

    def _cleanup(finished: asyncio.Task) -> None:
        _background.discard(finished)
        if _active_turns.get(session_id) is finished:
            _active_turns.pop(session_id, None)

    task.add_done_callback(_cleanup)
    return task


async def send_message(params: dict[str, Any], *, user_id: Optional[str] = None) -> dict[str, Any]:
    """A2A `message/send`：建会话 + 触发诊断，返回 Task（可选阻塞等待）。"""
    message = params.get("message") or {}
    text = _text_of(message)
    if not text:
        raise ValueError("message.parts 中缺少文本内容")
    config = params.get("configuration") or {}
    blocking = bool(config.get("blocking"))

    session = sessions.create_session(sessions.derive_session_title(text), user_id)
    sessions.emit_event(session.id, "user_message", {"message": text, "role": "user", "source": "a2a"})

    task = _spawn_turn(session.id, text)

    if blocking:
        timeout = float(config.get("timeoutSeconds") or 300)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.TimeoutError:
            pass  # 超时后转为后台继续执行，返回当前状态
    refreshed = sessions.get_session(session.id) or session
    return _task_of(refreshed)


def _final_state(session: Any, *, canceled: bool) -> str:
    if canceled:
        return "canceled"
    status = getattr(session, "status", "") or ""
    if status == "awaiting_approval":
        return "input-required"
    if status in ("concluded", "closed"):
        return "completed"
    return _STATE_MAP.get(status, "completed")


def _final_text(session: Any) -> Optional[str]:
    root = getattr(session, "rootCause", None)
    if root is not None:
        return root.summary
    if getattr(session, "status", "") == "awaiting_approval":
        return "等待人工审批后继续"
    return None


class _Frame(dict):
    """A2A 结果负载（dict 子类）+ 关联时间线事件 id，供 SSE `id:` 续传游标使用。"""

    __slots__ = ("event_id",)

    def __init__(self, payload: dict[str, Any], *, event_id: Optional[str] = None) -> None:
        super().__init__(payload)
        self.event_id = event_id


def _row_to_event(row: dict[str, Any]) -> dict[str, Any]:
    """把 timeline_events 表行还原为事件字典（payload 反序列化为对象）。"""
    payload = row.get("payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {}
    return {
        "id": row.get("id"),
        "sessionId": row.get("session_id") or row.get("sessionId"),
        "type": row.get("type"),
        "timestamp": row.get("timestamp"),
        "payload": payload,
    }


def _replay_events(session_id: str, last_event_id: Optional[str]) -> list[dict[str, Any]]:
    """回放已持久化的时间线事件；给定游标则只回放其后的增量。"""
    events = [_row_to_event(r) for r in db.list_timeline_events(session_id)]
    if not last_event_id:
        return events
    for idx, event in enumerate(events):
        if event.get("id") == last_event_id:
            return events[idx + 1 :]
    return events  # 游标未命中：退化为全量回放


class _EventTranslator:
    """把 InfraPilot 时间线事件翻译为 A2A 流式事件（持有去重集合与状态机）。"""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self.current_state = "submitted"
        self.canceled = False
        self.seen: set[str] = set()

    def _status_update(self, text: Any = None) -> dict[str, Any]:
        return {
            "id": self.task_id,
            "kind": "status-update",
            "status": _status_payload(self.current_state, text),
            "final": False,
        }

    def feed(self, event: dict[str, Any]) -> list[_Frame]:
        event_id = event.get("id")
        if event_id:
            if event_id in self.seen:
                return []
            self.seen.add(event_id)
        etype = event.get("type")
        payload = event.get("payload") or {}
        if etype == "status":
            raw = str(payload.get("status") or "")
            if raw == "canceled":
                self.canceled = True
            if raw in _STATE_MAP:
                self.current_state = _STATE_MAP[raw]
            return [_Frame(self._status_update(payload.get("message")), event_id=event_id)]
        if etype == "error":
            return [_Frame(self._status_update(payload.get("message")), event_id=event_id)]
        if etype in ("assistant_message", "rca_conclusion", "remediation_plan"):
            content = payload.get("content") or payload.get("summary")
            if content:
                return [_Frame(self._status_update(str(content)), event_id=event_id)]
        return []


def _artifact_updates(session_id: str, seen: set[str]) -> list[dict[str, Any]]:
    updates: list[dict[str, Any]] = []
    for artifact in artifacts_mod.list_for_session(session_id):
        if artifact["id"] in seen:
            continue
        seen.add(artifact["id"])
        updates.append({"id": session_id, "kind": "artifact-update", "artifact": _artifact_parts(artifact)})
    return updates


async def _relay(
    session: Any,
    queue: "asyncio.Queue[dict[str, Any]]",
    task: Optional[asyncio.Task],
    *,
    replay: Optional[list[dict[str, Any]]] = None,
    live: bool = True,
) -> AsyncIterator[Optional[dict[str, Any]]]:
    """共享事件中继：先回放 `replay`，再消费 bus 队列直到 `done` / 轮次结束，最后收尾。"""
    translator = _EventTranslator(session.id)
    seen_artifacts = {a["id"] for a in artifacts_mod.list_for_session(session.id)}

    for event in replay or []:
        for out in translator.feed(event):
            yield out
        for update in _artifact_updates(session.id, seen_artifacts):
            yield update

    if live:
        getter = asyncio.ensure_future(queue.get())
        try:
            while True:
                waiters: set[Any] = {getter}
                if task is not None:
                    waiters.add(task)
                done, _pending = await asyncio.wait(
                    waiters, timeout=STREAM_IDLE_SECONDS, return_when=asyncio.FIRST_COMPLETED
                )
                if getter in done:
                    event = getter.result()
                    getter = asyncio.ensure_future(queue.get())
                    for out in translator.feed(event):
                        yield out
                    for update in _artifact_updates(session.id, seen_artifacts):
                        yield update
                    if event.get("type") == "done":
                        break
                    continue
                if task is not None and task in done:
                    break  # 无 `done`（如等待审批/取消）时也要收尾
                yield None  # 空闲心跳
        finally:
            getter.cancel()

    # 让出事件循环，排空 bus 通过 call_soon 投递的剩余事件
    for _ in range(3):
        await asyncio.sleep(0)
    while not queue.empty():
        for out in translator.feed(queue.get_nowait()):
            yield out
    for update in _artifact_updates(session.id, seen_artifacts):
        yield update

    final_session = sessions.get_session(session.id) or session
    yield _Frame(
        {
            "id": session.id,
            "kind": "status-update",
            "status": _status_payload(_final_state(final_session, canceled=translator.canceled), _final_text(final_session)),
            "final": True,
        }
    )


async def stream_message(
    params: dict[str, Any], *, user_id: Optional[str] = None
) -> AsyncIterator[Optional[dict[str, Any]]]:
    """A2A `message/stream`：返回 SSE 事件序列生成器（每次 yield 一个 result 负载）。

    yield 的事件：
    - `{"kind": "task", ...}`：首个事件，完整 Task 快照；
    - `{"kind": "status-update", "status": {...}, "final": bool}`：状态/文本增量；
    - `{"kind": "artifact-update", "artifact": {...}}`：新登记的会话产物；
    - `None`：SSE 心跳占位（传输层转为 `: ping` 注释，不携带数据）。
    """
    message = params.get("message") or {}
    text = _text_of(message)
    if not text:
        raise ValueError("message.parts 中缺少文本内容")

    session = sessions.create_session(sessions.derive_session_title(text), user_id)
    sessions.emit_event(session.id, "user_message", {"message": text, "role": "user", "source": "a2a"})
    # 先订阅事件总线再启动后台轮次：否则 HTTP 传输层在首个 yield 前让出事件循环，
    # 轮次产生的早期事件会在订阅建立前丢失。
    loop = asyncio.get_running_loop()
    sid, queue = bus.subscribe(loop, session.id)
    task = _spawn_turn(session.id, text)

    async def _gen() -> AsyncIterator[Optional[dict[str, Any]]]:
        try:
            yield _task_of(sessions.get_session(session.id) or session)
            async for out in _relay(session, queue, task):
                yield out
        finally:
            bus.unsubscribe(sid)

    return _gen()


async def resubscribe_task(
    params: dict[str, Any], *, last_event_id: Optional[str] = None
) -> AsyncIterator[Optional[dict[str, Any]]]:
    """A2A `tasks/resubscribe`：断线重连续订既有任务的事件流。

    先回放已持久化时间线（可传 `lastEventId` 或 SSE `Last-Event-ID` 做增量补齐），
    随后续订实时事件，最后以 `final=true` 的 status-update 收尾；任务已无活跃轮次时
    回放完直接收尾。返回的生成器不产生首帧 Task 快照（调用方已持有该任务）。
    """
    task_id = str(params.get("id") or params.get("taskId") or "")
    session = sessions.get_session(task_id) if task_id else None
    if session is None:
        raise ValueError("task not found")

    cursor = last_event_id or params.get("lastEventId")
    loop = asyncio.get_running_loop()
    sid, queue = bus.subscribe(loop, session.id)
    active = _active_turns.get(session.id)
    live = active is not None and not active.done()
    replay = _replay_events(session.id, str(cursor) if cursor else None)

    async def _gen() -> AsyncIterator[Optional[dict[str, Any]]]:
        try:
            async for out in _relay(session, queue, active if live else None, replay=replay, live=live):
                yield out
        finally:
            bus.unsubscribe(sid)

    return _gen()


def get_task(params: dict[str, Any]) -> dict[str, Any]:
    task_id = str(params.get("id") or params.get("taskId") or "")
    session = sessions.get_session(task_id) if task_id else None
    if session is None:
        raise ValueError("task not found")
    return _task_of(session)


def cancel_task(params: dict[str, Any]) -> dict[str, Any]:
    task_id = str(params.get("id") or params.get("taskId") or "")
    session = sessions.get_session(task_id) if task_id else None
    if session is None:
        raise ValueError("task not found")
    # 真正打断进行中的轮次：取消 asyncio 任务 + 置位协作标记，而不是只改状态
    interrupted = sessions.request_cancel(session.id)
    sessions.terminate_session(session.id)
    sessions.emit_event(session.id, "status", {"status": "canceled", "message": "A2A 调用方取消任务"})
    if not interrupted:
        sessions.emit_event(session.id, "done", {})
    return _task_of(sessions.get_session(session.id))


async def handle_request(payload: dict[str, Any], *, user_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    if not isinstance(payload, dict):
        return _rpc_error(None, -32600, "invalid request")
    request_id = payload.get("id")
    if "id" not in payload:
        return None
    method = payload.get("method")
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        params = {}
    try:
        if method == "message/send":
            return _rpc_ok(request_id, await send_message(params, user_id=user_id))
        if method == "tasks/get":
            return _rpc_ok(request_id, get_task(params))
        if method == "tasks/cancel":
            return _rpc_ok(request_id, cancel_task(params))
        if method == "ping":
            return _rpc_ok(request_id, {})
        return _rpc_error(request_id, -32601, f"method not found: {method}")
    except ValueError as err:
        return _rpc_error(request_id, -32001, str(err))
