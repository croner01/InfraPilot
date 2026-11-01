"""进程内事件总线 —— 把时间线事件从任意线程推送到 WebSocket 订阅者。

对应 `server/src/agent/sessionStore.ts` 里的 EventEmitter + `ws/hub.ts`。
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Optional


def _put_nowait(queue: "asyncio.Queue[dict[str, Any]]", event: dict[str, Any]) -> None:
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        # 慢消费者：丢弃最旧事件，保证实时流不被阻塞
        try:
            queue.get_nowait()
            queue.put_nowait(event)
        except (asyncio.QueueEmpty, asyncio.QueueFull):
            pass


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seq = 0
        self._subs: dict[int, tuple[asyncio.AbstractEventLoop, "asyncio.Queue[dict[str, Any]]", str]] = {}

    def subscribe(self, loop: asyncio.AbstractEventLoop, session_id: str) -> tuple[int, "asyncio.Queue[dict[str, Any]]"]:
        with self._lock:
            self._seq += 1
            sid = self._seq
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
            self._subs[sid] = (loop, queue, session_id)
            return sid, queue

    def unsubscribe(self, sid: int) -> None:
        with self._lock:
            self._subs.pop(sid, None)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            targets = list(self._subs.items())
        session_id = event.get("sessionId")
        for sid, (loop, queue, subscribed) in targets:
            if subscribed and subscribed != session_id:
                continue
            try:
                loop.call_soon_threadsafe(_put_nowait, queue, event)
            except RuntimeError:
                self.unsubscribe(sid)


bus = EventBus()
