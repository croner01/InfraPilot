"""认证与 RBAC（P0）—— 对应差距分析 §5「用户隔离与多租户」。

- 用户表 + bcrypt 密码哈希 + JWT（HS256）
- 角色：admin / on-call / viewer
- 默认不强制鉴权（保持与既有前端契约兼容）；设置 `INFRAPILOT_REQUIRE_AUTH=1`
  后除登录与健康检查外的 /api/* 请求需携带 `Authorization: Bearer <token>`。
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import bcrypt
import jwt
from fastapi import HTTPException, Request

from . import config_store, db
from .util import new_id, now_iso

ROLES = ("admin", "on-call", "viewer")

# 演示用种子账号（首次启动写入，密码可后续通过管理接口修改）
SEED_USERS = [
    {"username": "admin", "display_name": "管理员", "role": "admin", "password": "admin123"},
    {"username": "oncall-zhang", "display_name": "值班 SRE", "role": "on-call", "password": "oncall123"},
    {"username": "viewer", "display_name": "只读观察", "role": "viewer", "password": "viewer123"},
]

JWT_TTL_SECONDS = 12 * 3600


def _secret() -> str:
    env_secret = os.environ.get("INFRAPILOT_JWT_SECRET")
    if env_secret:
        return env_secret
    runtime = config_store.get_raw().get("auth") or {}
    if runtime.get("jwtSecret"):
        return runtime["jwtSecret"]
    generated = config_store.generate_mcp_jwt_secret()

    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["auth"] = {**(cfg.get("auth") or {}), "jwtSecret": generated}

    config_store.update_raw(_mutate)
    return generated


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def public_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "displayName": row["display_name"],
        "role": row["role"],
        "disabled": bool(row.get("disabled")),
        "createdAt": row["created_at"],
    }


def issue_token(user: dict[str, Any]) -> str:
    payload = {
        "sub": user["id"],
        "username": user["username"],
        "role": user["role"],
        "iat": int(time.time()),
        "exp": int(time.time()) + JWT_TTL_SECONDS,
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


def decode_token(token: str) -> Optional[dict[str, Any]]:
    try:
        return jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def ensure_seed_users() -> None:
    if db.count_users() > 0:
        return
    for seed in SEED_USERS:
        create_user(seed["username"], seed["display_name"], seed["role"], seed["password"])


def create_user(username: str, display_name: str, role: str, password: str) -> dict[str, Any]:
    if role not in ROLES:
        raise ValueError(f"非法角色: {role}（可选 {', '.join(ROLES)}）")
    if db.get_user_by_username(username):
        raise ValueError(f"用户名已存在: {username}")
    row = {
        "id": new_id(),
        "username": username,
        "display_name": display_name or username,
        "role": role,
        "password_hash": hash_password(password),
        "created_at": now_iso(),
        "disabled": 0,
    }
    db.insert_user(row)
    return row


def authenticate(username: str, password: str) -> Optional[dict[str, Any]]:
    row = db.get_user_by_username(username)
    if not row or row.get("disabled"):
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    return row


def require_auth_enabled() -> bool:
    return os.environ.get("INFRAPILOT_REQUIRE_AUTH") == "1"


def user_from_request(request: Request) -> Optional[dict[str, Any]]:
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("bearer "):
        return None
    payload = decode_token(header[7:].strip())
    if not payload:
        return None
    row = db.get_user(str(payload.get("sub")))
    if not row or row.get("disabled"):
        return None
    return row


def current_user_or_401(request: Request) -> dict[str, Any]:
    user = user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="未认证")
    return user


def require_role(request: Request, roles: tuple[str, ...]) -> dict[str, Any]:
    user = current_user_or_401(request)
    if user["role"] not in roles:
        raise HTTPException(status_code=403, detail="权限不足")
    return user
