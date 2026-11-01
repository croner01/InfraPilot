"""FastAPI 应用入口 —— 对应 `server/src/index.ts`。"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import db, settings
from .bus import bus
from .routes.api import api_router
from .routes.config import config_router
from .routes.datasources import data_sources_router
from .routes.skills import skills_router
from .routes.usage import usage_router
from .routes.auth import auth_router
from .routes.schedules import schedules_router
from .routes.mcp import mcp_router
from .routes.eval import eval_router
from .routes.artifacts import artifacts_router
from .routes.a2a import a2a_router, well_known_router
from . import auth, scheduler, log_shipper


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    auth.ensure_seed_users()
    if scheduler.enabled():
        scheduler.scheduler.start()
    if log_shipper.enabled():
        # 真实 Pod 日志 -> OpenSearch 采集管道（移植自 Node 版 logShipper）
        await log_shipper.start()
    try:
        yield
    finally:
        await scheduler.scheduler.stop()
        await log_shipper.stop()


app = FastAPI(title="InfraPilot Server (Python)", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")
app.include_router(config_router, prefix="/api/config")
app.include_router(data_sources_router, prefix="/api/data-sources")
app.include_router(skills_router, prefix="/api/skills")
app.include_router(usage_router, prefix="/api/usage")
app.include_router(auth_router, prefix="/api/auth")
app.include_router(schedules_router, prefix="/api/schedules")
app.include_router(mcp_router, prefix="/api/mcp")
app.include_router(eval_router, prefix="/api/eval")
app.include_router(artifacts_router, prefix="/api/artifacts")
app.include_router(a2a_router, prefix="/api/a2a")
app.include_router(well_known_router)


# MCP 端点使用独立的 MCP JWT（见 mcp_server.verify_bearer），不走 /api 的登录鉴权
_AUTH_WHITELIST = ("/health", "/api/auth/login", "/api/mcp")


@app.middleware("http")
async def _optional_auth_middleware(request: Request, call_next):
    # 默认不强制鉴权（与既有前端契约兼容）；INFRAPILOT_REQUIRE_AUTH=1 时开启
    if auth.require_auth_enabled() and request.url.path.startswith("/api") and not request.url.path.startswith(_AUTH_WHITELIST):
        if not auth.user_from_request(request):
            return JSONResponse(status_code=401, content={"error": "未认证"})
    return await call_next(request)


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    # 与 Node/Express 版保持一致：错误体统一为 {"error": "..."}（而非 FastAPI 默认的 detail）
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "infrapilot-server"}


async def _ws_sender(websocket: WebSocket, queue: "asyncio.Queue[dict[str, Any]]") -> None:
    while True:
        event = await queue.get()
        await websocket.send_json(event)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, sessionId: str | None = None) -> None:
    await websocket.accept()
    if not sessionId:
        await websocket.close(code=4000, reason="sessionId required")
        return

    loop = asyncio.get_running_loop()
    sid, queue = bus.subscribe(loop, sessionId)
    sender = asyncio.create_task(_ws_sender(websocket, queue))
    receiver = asyncio.create_task(websocket.receive_text())
    try:
        done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(sid)
        sender.cancel()
        receiver.cancel()
