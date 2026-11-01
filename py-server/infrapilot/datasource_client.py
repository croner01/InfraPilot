"""日志数据源 REST 客户端 —— OpenSearch 1/2 与 Elasticsearch 7/8 通用。

差距分析 P2：「ES 8 客户端兼容」。Node 版用 `@opensearch-project/opensearch`（兼容 ES 7.x，
ES 8 需 `Elasticsearch` 客户端或 `compatible-with: 8` 兼容头）。Python 版不再引入额外的
`elasticsearch` SDK，而是用 httpx 直接走 REST 接口 —— OpenSearch 与 ES 的 `_search` /
`_cluster/health` / `_mapping` 线上格式一致，这样既覆盖 ES 8，又复用同一份查询构造逻辑。

ELK Skill 的四个工具接口保持不变（search_logs / aggregate_by_field / get_error_timeline /
cluster_similar_errors），索引模式解析规则也不变。
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx

# ES 8 要求显式声明兼容版本，否则 8.x 会返回 400（"Content-Type header [...] is not supported"）。
ES8_COMPAT_ACCEPT = "application/vnd.elasticsearch+json; compatible-with=8"
ES8_COMPAT_CONTENT_TYPE = "application/vnd.elasticsearch+json; compatible-with=8"

REST_FLAVORS = ("es", "es8", "elasticsearch", "elastic", "opensearch-rest")


class LogClientError(RuntimeError):
    """REST 请求失败（非索引缺失类）。"""


class IndexNotFound(LogClientError):
    """目标索引不存在或为空（与 opensearchpy NotFoundError 语义对齐）。"""


def is_rest_flavor(backend: Optional[dict[str, Any]]) -> bool:
    """判断后端是否走 REST（ES 8 / 显式声明）通道。"""
    if not backend:
        return False
    flavor = str(backend.get("flavor") or backend.get("type") or "").lower()
    return flavor in REST_FLAVORS


def credentials(backend: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    username = backend.get("username")
    password = None
    env_name = backend.get("passwordEnv")
    if env_name:
        password = os.environ.get(str(env_name))
    if not password and backend.get("password"):
        password = backend.get("password")
    return username, password


def build_headers(backend: dict[str, Any]) -> dict[str, str]:
    """构造请求头：兼容头、鉴权、自定义 header / headerEnv。"""
    headers: dict[str, str] = {"Accept": "application/json"}
    if is_rest_flavor(backend) or str(backend.get("esVersion") or "").startswith("8"):
        headers["Accept"] = ES8_COMPAT_ACCEPT
        headers["Content-Type"] = ES8_COMPAT_CONTENT_TYPE
    else:
        headers["Content-Type"] = "application/json"
    headers.update({k: str(v) for k, v in dict(backend.get("headers") or {}).items()})
    for key, env_name in (backend.get("headerEnv") or {}).items():
        if os.environ.get(env_name):
            headers[key] = os.environ[env_name]
    return headers


def auth_tuple(backend: dict[str, Any]) -> Optional[tuple[str, Optional[str]]]:
    """返回 httpx 的 (user, password) 元组，未配置用户名时返回 None。"""
    username, password = credentials(backend)
    return (username, password) if username and password is not None else None


def _verify(backend: dict[str, Any]) -> bool:
    # 默认不校验证书（本地/沙箱常见自签），与 Node 版 opensearch 客户端行为一致
    return not bool(backend.get("skipTlsVerify", True))


def _node(backend: dict[str, Any]) -> str:
    node = backend.get("node") or backend.get("url")
    if not node:
        raise LogClientError("log backend 缺少 node/url")
    return str(node).rstrip("/")


def _raise_for_status(response: httpx.Response, index: Optional[str] = None) -> dict[str, Any]:
    if response.status_code < 400:
        try:
            return response.json()
        except Exception:  # noqa: BLE001 - 空响应体（如 clickhouse 探活）
            return {}
    detail = response.text[:300]
    if response.status_code == 404 or "index_not_found_exception" in detail:
        raise IndexNotFound(f"索引不存在或为空({index}): {detail}")
    raise LogClientError(f"日志后端返回 {response.status_code}: {detail}")


def _normalize_body(backend: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    # ES 7+/OpenSearch 对 "now-30m" 的 range 无需改写；此处保留扩展点。
    return body


def search_sync(backend: dict[str, Any], index: str, body: dict[str, Any], *, timeout: float = 10) -> dict[str, Any]:
    """同步 `_search`。index 支持逗号分隔的多模式（与 OpenSearch 一致）。"""
    url = f"{_node(backend)}/{index}/_search"
    headers = build_headers(backend)
    auth = auth_tuple(backend)
    with httpx.Client(timeout=timeout, verify=_verify(backend), auth=auth) as client:
        response = client.post(url, headers=headers, content=json.dumps(_normalize_body(backend, body)))
    return _raise_for_status(response, index)


async def search_async(backend: dict[str, Any], index: str, body: dict[str, Any], *, timeout: float = 10) -> dict[str, Any]:
    url = f"{_node(backend)}/{index}/_search"
    headers = build_headers(backend)
    auth = auth_tuple(backend)
    async with httpx.AsyncClient(timeout=timeout, verify=_verify(backend), auth=auth) as client:
        response = await client.post(url, headers=headers, content=json.dumps(_normalize_body(backend, body)))
    return _raise_for_status(response, index)


def cluster_health_sync(backend: dict[str, Any], *, timeout: float = 10) -> dict[str, Any]:
    url = f"{_node(backend)}/_cluster/health"
    headers = build_headers(backend)
    auth = auth_tuple(backend)
    with httpx.Client(timeout=timeout, verify=_verify(backend), auth=auth) as client:
        response = client.get(url, headers=headers, params={"wait_for_status": "yellow", "timeout": "5s"})
    return _raise_for_status(response)


def mapping_sync(backend: dict[str, Any], index: str, *, timeout: float = 10) -> dict[str, Any]:
    url = f"{_node(backend)}/{index}/_mapping"
    headers = build_headers(backend)
    auth = auth_tuple(backend)
    with httpx.Client(timeout=timeout, verify=_verify(backend), auth=auth) as client:
        response = client.get(url, headers=headers)
    return _raise_for_status(response, index)
