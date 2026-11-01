"""OpenStack Skill —— 对应 `server/src/skills/openstack/{client,tools}.ts`。

直接调用 OpenStack REST API（Keystone v3 密码认证 + Nova/Neutron/Placement）。
凭据通过 OS_* 环境变量注入，符合「凭据不走前端输入」的安全约定。
"""

from __future__ import annotations

import os
import time
import urllib.parse
from typing import Any, Optional

import httpx

from ..models import ToolDef, ToolExecutionResult


class OpenStackClientError(Exception):
    def __init__(self, message: str, status: Optional[int] = None, response: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.response = response


def from_env() -> dict[str, Any]:
    auth_url = os.environ.get("OS_AUTH_URL")
    username = os.environ.get("OS_USERNAME")
    password = os.environ.get("OS_PASSWORD")
    project_name = os.environ.get("OS_PROJECT_NAME")
    if not auth_url or not username or not password or not project_name:
        raise OpenStackClientError(
            "缺少 OpenStack 认证环境变量：OS_AUTH_URL、OS_USERNAME、OS_PASSWORD、OS_PROJECT_NAME"
        )
    return {
        "authUrl": auth_url,
        "username": username,
        "password": password,
        "projectName": project_name,
        "projectDomainId": os.environ.get("OS_PROJECT_DOMAIN_ID") or "default",
        "userDomainId": os.environ.get("OS_USER_DOMAIN_ID") or "default",
        "regionName": os.environ.get("OS_REGION_NAME"),
    }


_auth_cache: Optional[dict[str, Any]] = None


def reset_auth_cache() -> None:
    global _auth_cache
    _auth_cache = None


async def _authenticate(config: dict[str, Any]) -> dict[str, Any]:
    body = {
        "auth": {
            "identity": {
                "methods": ["password"],
                "password": {
                    "user": {
                        "name": config["username"],
                        "domain": {"id": config["userDomainId"]},
                        "password": config["password"],
                    }
                },
            },
            "scope": {"project": {"name": config["projectName"], "domain": {"id": config["projectDomainId"]}}},
        }
    }
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(f"{config['authUrl']}/v3/auth/tokens", json=body)
    if res.status_code >= 400:
        raise OpenStackClientError(f"Keystone 认证失败: {res.status_code} {res.text}", res.status_code, res.text)
    token = res.headers.get("X-Subject-Token")
    if not token:
        raise OpenStackClientError("Keystone 响应缺少 X-Subject-Token")
    data = res.json()
    expires_at = data["token"]["expires_at"]
    from datetime import datetime, timezone

    parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    return {"token": token, "expiresAt": parsed.timestamp() * 1000, "catalog": data["token"].get("catalog") or []}


async def _ensure_auth(config: dict[str, Any]) -> dict[str, Any]:
    global _auth_cache
    now_ms = time.time() * 1000
    if _auth_cache and _auth_cache["expiresAt"] - now_ms > 60_000:
        return _auth_cache
    _auth_cache = await _authenticate(config)
    return _auth_cache


def _resolve_endpoint(catalog: list[dict[str, Any]], service_type: str, config: dict[str, Any]) -> str:
    service = next((s for s in catalog if s.get("type") == service_type), None)
    if not service:
        raise OpenStackClientError(f"服务目录中未找到服务类型: {service_type}")
    endpoints = [e for e in (service.get("endpoints") or []) if e.get("interface") == "public"]
    if config.get("regionName"):
        regional = [e for e in endpoints if e.get("region") == config["regionName"]]
        if regional:
            endpoints = regional
    if not endpoints:
        raise OpenStackClientError(f"未找到 {service_type} 的可用 public endpoint")
    return endpoints[0]["url"].rstrip("/")


async def _parse_response(res: httpx.Response) -> dict[str, Any]:
    text = res.text
    data: Any = None
    if text:
        try:
            data = res.json()
        except ValueError:
            data = text
    if res.status_code >= 400:
        message = data.get("message") if isinstance(data, dict) and "message" in data else (text or f"HTTP {res.status_code}")
        raise OpenStackClientError(f"OpenStack API 请求失败: {message}", res.status_code, data)
    return {"status": res.status_code, "data": data}


async def openstack_request(
    service_type: str, path: str, options: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    options = options or {}
    config = from_env()
    cache = await _ensure_auth(config)
    endpoint = _resolve_endpoint(cache["catalog"], service_type, config)
    url = f"{endpoint}{path if path.startswith('/') else '/' + path}"
    headers = {"X-Auth-Token": cache["token"], "Accept": "application/json"}
    if options.get("body") is not None:
        headers["Content-Type"] = "application/json"
    method = options.get("method") or "GET"

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.request(url, method=method, headers=headers, json=options.get("body"))
        if res.status_code == 401:
            reset_auth_cache()
            retry_cache = await _ensure_auth(config)
            retry_headers = {**headers, "X-Auth-Token": retry_cache["token"]}
            res = await client.request(url, method=method, headers=retry_headers, json=options.get("body"))
        return await _parse_response(res)


def _tool(name: str, risk: str, description: str, properties: dict[str, Any], required: list[str]) -> ToolDef:
    return ToolDef(
        name=name,
        skill="openstack",
        risk=risk,
        description=description,
        parameters={"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    )


TOOLS: list[ToolDef] = [
    _tool(
        "server_show",
        "readonly",
        "获取 Nova 虚机详情，包含 status、fault 信息、hypervisor_hostname、flavor、image、addresses 等。用于诊断虚机异常状态或创建失败后的资源分配情况。",
        {"server_id": {"type": "string", "description": "Nova 虚机 UUID"}},
        ["server_id"],
    ),
    _tool(
        "server_list_events",
        "readonly",
        "获取指定虚机的 instance action / event 列表，用于排查创建失败、迁移、重启等生命周期事件。",
        {"server_id": {"type": "string", "description": "Nova 虚机 UUID"}},
        ["server_id"],
    ),
    _tool("hypervisor_list", "readonly", "获取 Nova 计算节点资源余量（vcpus、memory_mb、running_vms 等），用于定位 NoValidHost 类调度失败。", {}, []),
    _tool(
        "allocation_candidate_list",
        "readonly",
        "通过 Placement API 查询满足指定资源需求的 allocation candidate，用于定位 NoValidHost。",
        {"resources": {"type": "string", "description": "Placement resources 查询串，例如 VCPU=1,MEMORY_MB=2048,DISK_GB=20"}},
        ["resources"],
    ),
    _tool("neutron_agent_list", "readonly", "获取 Neutron agent（DHCP、L3、Open vSwitch 等）状态，用于诊断网络相关故障。", {}, []),
    _tool("nova_service_list", "readonly", "获取 Nova 服务（nova-api、nova-scheduler、nova-compute 等）状态，用于诊断控制面服务异常。", {}, []),
    _tool(
        "server_reboot",
        "high",
        "重启指定 Nova 虚机（SOFT=优雅重启，HARD=强制重启）。属于变更操作，需人工审批。",
        {
            "server_id": {"type": "string", "description": "Nova 虚机 UUID"},
            "reboot_type": {"type": "string", "enum": ["SOFT", "HARD"], "description": "SOFT=优雅重启，HARD=强制重启"},
        },
        ["server_id", "reboot_type"],
    ),
]


async def _show_server(server_id: str, started: float) -> ToolExecutionResult:
    try:
        data = (await openstack_request("compute", f"/servers/{server_id}"))["data"]
        server = data["server"]
        normalized = {
            "id": server["id"],
            "name": server["name"],
            "status": server["status"],
            "tenantId": server.get("tenant_id"),
            "flavorId": (server.get("flavor") or {}).get("id"),
            "imageId": (server.get("image") or {}).get("id"),
            "hypervisorHostname": server.get("OS-EXT-SRV-ATTR:hypervisor_hostname"),
            "fault": server.get("fault"),
            "addresses": server.get("addresses"),
            "created": server.get("created"),
            "updated": server.get("updated"),
        }
        return _ok(normalized, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def _list_server_events(server_id: str, started: float) -> ToolExecutionResult:
    try:
        data = (await openstack_request("compute", f"/servers/{server_id}/os-instance-actions"))["data"]
        actions = data.get("instanceActions") or []
        normalized = [
            {
                "action": a.get("action"),
                "instanceUuid": a.get("instance_uuid"),
                "requestId": a.get("request_id"),
                "startTime": a.get("start_time"),
                "message": a.get("message"),
            }
            for a in actions
        ]
        return _ok(normalized, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def _list_hypervisors(started: float) -> ToolExecutionResult:
    try:
        data = (await openstack_request("compute", "/os-hypervisors/detail"))["data"]
        hypervisors = data.get("hypervisors") or []
        normalized = [
            {
                "id": h.get("id"),
                "hypervisorHostname": h.get("hypervisor_hostname"),
                "vcpus": h.get("vcpus"),
                "vcpusUsed": h.get("vcpus_used"),
                "memoryMb": h.get("memory_mb"),
                "memoryMbUsed": h.get("memory_mb_used"),
                "runningVms": h.get("running_vms"),
                "state": h.get("state"),
                "status": h.get("status"),
            }
            for h in hypervisors
        ]
        return _ok(normalized, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def _list_allocation_candidates(resources: str, started: float) -> ToolExecutionResult:
    try:
        encoded = urllib.parse.quote(resources, safe="")
        data = (await openstack_request("placement", f"/allocation_candidates?resources={encoded}"))["data"]
        return _ok(data, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def _list_neutron_agents(started: float) -> ToolExecutionResult:
    try:
        data = (await openstack_request("network", "/v2.0/agents"))["data"]
        agents = data.get("agents") or []
        normalized = [
            {
                "id": a.get("id"),
                "agentType": a.get("agent_type"),
                "host": a.get("host"),
                "availabilityZone": a.get("availability_zone"),
                "alive": a.get("alive"),
                "adminStateUp": a.get("admin_state_up"),
            }
            for a in agents
        ]
        return _ok(normalized, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def _list_nova_services(started: float) -> ToolExecutionResult:
    try:
        data = (await openstack_request("compute", "/os-services"))["data"]
        services = data.get("services") or []
        normalized = [
            {
                "id": s.get("id"),
                "binary": s.get("binary"),
                "host": s.get("host"),
                "status": s.get("status"),
                "state": s.get("state"),
                "zone": s.get("zone"),
            }
            for s in services
        ]
        return _ok(normalized, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def _reboot_server(server_id: str, reboot_type: str, started: float) -> ToolExecutionResult:
    try:
        await openstack_request(
            "compute", f"/servers/{server_id}/action", {"method": "POST", "body": {"reboot": {"type": reboot_type}}}
        )
        return _ok({"serverId": server_id, "rebootType": reboot_type, "message": "重启请求已发送"}, started)
    except Exception as err:  # noqa: BLE001
        return _err(err, started)


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    if tool == "server_show":
        return await _show_server(str(args.get("server_id") or ""), started)
    if tool == "server_list_events":
        return await _list_server_events(str(args.get("server_id") or ""), started)
    if tool == "hypervisor_list":
        return await _list_hypervisors(started)
    if tool == "allocation_candidate_list":
        return await _list_allocation_candidates(str(args.get("resources") or ""), started)
    if tool == "neutron_agent_list":
        return await _list_neutron_agents(started)
    if tool == "nova_service_list":
        return await _list_nova_services(started)
    if tool == "server_reboot":
        return await _reboot_server(str(args.get("server_id") or ""), str(args.get("reboot_type") or ""), started)
    return ToolExecutionResult(success=False, error=f"未知 OpenStack 工具: {tool}", durationMs=0)


def _ok(data: Any, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=True, data=data, durationMs=_ms(started))


def _err(error: Any, started: float) -> ToolExecutionResult:
    return ToolExecutionResult(success=False, error=str(error), durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)
