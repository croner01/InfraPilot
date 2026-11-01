"""认证 API（P0）—— 对应登录页注释中的 POST /api/auth/login。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request

from .. import auth, db

auth_router = APIRouter()


@auth_router.post("/login")
def login(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    body = payload or {}
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="username 与 password 必填")
    user = auth.authenticate(username, password)
    if not user:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return {"ok": True, "token": auth.issue_token(user), "user": auth.public_user(user)}


@auth_router.get("/me")
def me(request: Request) -> dict[str, Any]:
    user = auth.user_from_request(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    return {"user": auth.public_user(user)}


@auth_router.post("/logout")
def logout() -> dict[str, Any]:
    # JWT 无状态：前端清除本地 token 即可
    return {"ok": True}


@auth_router.get("/roles")
def list_roles() -> dict[str, Any]:
    return {"roles": list(auth.ROLES)}


@auth_router.get("/users")
def list_users(request: Request) -> dict[str, Any]:
    auth.require_role(request, ("admin",))
    users = []
    for row in db.list_users():
        public = auth.public_user(row)
        public["sessionCount"] = db.count_sessions_for_user(row["id"])
        public["totalTokens"] = db.sum_tokens_for_user(row["id"])
        users.append(public)
    return {"users": users}


@auth_router.post("/users")
def create_user(request: Request, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    auth.require_role(request, ("admin",))
    body = payload or {}
    if not body.get("username") or not body.get("password"):
        raise HTTPException(status_code=400, detail="username 与 password 必填")
    try:
        row = auth.create_user(
            str(body["username"]),
            str(body.get("displayName") or body["username"]),
            str(body.get("role") or "viewer"),
            str(body["password"]),
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return {"ok": True, "user": auth.public_user(row)}


@auth_router.patch("/users/{user_id}")
def update_user(user_id: str, request: Request, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    auth.require_role(request, ("admin",))
    body = payload or {}
    fields: dict[str, Any] = {}
    if "displayName" in body:
        fields["display_name"] = body["displayName"]
    if "role" in body:
        if body["role"] not in auth.ROLES:
            raise HTTPException(status_code=400, detail=f"非法角色: {body['role']}")
        fields["role"] = body["role"]
    if "password" in body and body["password"]:
        fields["password_hash"] = auth.hash_password(str(body["password"]))
    if "disabled" in body:
        fields["disabled"] = 1 if body["disabled"] else 0
    row = db.update_user(user_id, fields)
    if not row:
        raise HTTPException(status_code=404, detail="user not found")
    return {"ok": True, "user": auth.public_user(row)}


@auth_router.delete("/users/{user_id}")
def delete_user(user_id: str, request: Request) -> dict[str, Any]:
    auth.require_role(request, ("admin",))
    if not db.get_user(user_id):
        raise HTTPException(status_code=404, detail="user not found")
    db.delete_user(user_id)
    return {"ok": True}
