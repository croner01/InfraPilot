"""Linux Skill —— 对应 `server/src/skills/linux/{tools,agentTools}.ts`。

`host="local"` 在 InfraPilot 服务端所在主机本地执行；`host=<Host Registry 别名>`
经 SSH 通道在远端节点执行**只读**诊断命令（见 infrapilot/remote.py 与
docs/ssh-proxy-linux-remote.md）。任何非 local 的调用都由 policy 强制人工审批。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from ..models import ToolDef, ToolExecutionResult
from ..redact import redact
from ..util import kill_quietly
from .. import remote as remote_skill
from .allowlist import is_command_allowed, sanitize_pattern

_HOST_PROP = {
    "host": {
        "type": "string",
        "description": "目标主机名；'local' 表示 InfraPilot 服务端主机，其它取值必须是 Host Registry 中已注册的"
        "节点别名（如 'node-1'）。非 local 会 SSH 登录目标节点执行只读命令，需人工审批。",
    }
}

# 服务端容器内一般没有 kubectl，命中时给出可执行的替代方案
_KUBECTL_FALLBACK = (
    "本地 kubectl 不可用（服务端容器未安装）。请改用 k8s 技能："
    "k8s.list_pods / k8s.describe_pod / k8s.get_events / k8s.get_pod_logs。"
)


def _tool(name: str, risk: str, description: str, properties: dict[str, Any], required: list[str]) -> ToolDef:
    return ToolDef(
        name=name,
        skill="linux",
        risk=risk,  # type: ignore[arg-type]
        description=description,
        parameters={
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    )


TOOLS: list[ToolDef] = [
    _tool(
        "get_cpu_usage",
        "readonly",
        "获取主机CPU使用率及Top进程列表(基于 top/ps)。支持指定远程主机名,未指定则在本机执行。",
        {**_HOST_PROP},
        ["host"],
    ),
    _tool(
        "get_memory_info",
        "readonly",
        "获取主机内存使用情况(free)、是否存在OOM历史(dmesg)、以及指定pid的详细内存占用(/proc/pid/status)。支持远程主机。",
        {**_HOST_PROP, "pid": {"type": "number", "description": "可选,指定进程pid以获取该进程的详细内存占用"}},
        ["host"],
    ),
    _tool("get_disk_usage", "readonly", "获取磁盘使用率(df -h)。支持远程主机。", {**_HOST_PROP}, ["host"]),
    _tool(
        "get_process_info",
        "readonly",
        "按名称模式查找进程详情(ps),常用于定位某服务对应的具体pid/内存/CPU/存活时长。支持远程主机。",
        {
            **_HOST_PROP,
            "name_pattern": {"type": "string", "description": "进程名匹配模式,如 'orderApiWorker'"},
        },
        ["host", "name_pattern"],
    ),
    _tool(
        "tail_recent_dmesg_or_syslog",
        "readonly",
        "获取内核/系统近期日志,用于判断是否有OOM Killer触发记录等内核级事件。支持远程主机。",
        {**_HOST_PROP},
        ["host"],
    ),
    # ---- agentTools.ts ----
    _tool(
        "get_network_stats",
        "readonly",
        "获取主机网络统计信息：连接数分布、TCP状态、接口收发/错误计数。支持远程主机。",
        {**_HOST_PROP, "iface": {"type": "string", "description": "可选，指定网卡名；不指定返回所有非 lo 接口"}},
        ["host"],
    ),
    _tool(
        "restart_service",
        "high",
        "重启指定的系统服务。仅允许白名单中的服务（如 nginx/docker/kubelet/sshd/cron/containerd）。需要审批。",
        {**_HOST_PROP, "service_name": {"type": "string", "description": "服务名，如 'nginx'"}},
        ["host", "service_name"],
    ),
    _tool(
        "kill_process",
        "high",
        "向指定 PID 发送信号。仅允许 SIGTERM/SIGHUP/SIGUSR1/SIGUSR2。需要审批。",
        {
            **_HOST_PROP,
            "pid": {"type": "number", "description": "进程 PID"},
            "signal": {"type": "string", "description": "信号名，默认 SIGTERM"},
        },
        ["host", "pid"],
    ),
    _tool(
        "run_command",
        "readonly",
        "在目标主机执行白名单内的 Linux/K8s 诊断命令。支持 cat/less/head/tail/ls/ps/ss/ip/df/free/dmesg/journalctl/systemctl/kubectl/crictl/docker 等。禁止执行变更类子命令（如 systemctl restart 必须走 restart_service 工具）。",
        {
            **_HOST_PROP,
            "command": {"type": "string", "description": "命令名，如 'cat'、'kubectl'"},
            "args": {"type": "array", "items": {"type": "string"}, "description": "命令参数数组"},
            "timeout_ms": {"type": "number", "description": "超时毫秒数，默认 10000"},
        },
        ["host", "command"],
    ),
    _tool(
        "read_file",
        "readonly",
        "读取远程或本地文件内容（cat 的封装）。",
        {**_HOST_PROP, "path": {"type": "string", "description": "文件路径"}},
        ["host", "path"],
    ),
    _tool(
        "tail_file",
        "readonly",
        "读取文件尾部 N 行（tail 的封装）。",
        {
            **_HOST_PROP,
            "path": {"type": "string", "description": "文件路径"},
            "lines": {"type": "number", "description": "行数，默认 20"},
        },
        ["host", "path"],
    ),
    _tool(
        "list_directory",
        "readonly",
        "列出目录内容（ls -la 的封装）。",
        {**_HOST_PROP, "path": {"type": "string", "description": "目录路径，默认当前目录"}},
        ["host"],
    ),
    _tool(
        "check_service_status",
        "readonly",
        "查看系统服务状态（systemctl status 的封装）。",
        {**_HOST_PROP, "service_name": {"type": "string", "description": "服务名，如 'nginx'"}},
        ["host", "service_name"],
    ),
    _tool(
        "get_kubernetes_resource",
        "readonly",
        "获取 K8s 资源（kubectl get 的封装）。",
        {
            **_HOST_PROP,
            "resource": {"type": "string", "description": "资源类型，如 pods/deployments/services"},
            "namespace": {"type": "string", "description": "命名空间，默认 default"},
            "all_namespaces": {"type": "boolean", "description": "是否跨命名空间查询"},
            "name": {"type": "string", "description": "资源名（可选）"},
            "output": {"type": "string", "description": "输出格式：wide/yaml/json"},
        },
        ["host", "resource"],
    ),
    _tool(
        "describe_kubernetes_resource",
        "readonly",
        "描述 K8s 资源详情（kubectl describe 的封装）。",
        {
            **_HOST_PROP,
            "resource": {"type": "string", "description": "资源类型"},
            "namespace": {"type": "string", "description": "命名空间"},
            "name": {"type": "string", "description": "资源名"},
        },
        ["host", "resource", "name"],
    ),
    _tool(
        "get_pod_logs",
        "readonly",
        "获取 Pod 日志（kubectl logs 的封装）。",
        {
            **_HOST_PROP,
            "namespace": {"type": "string", "description": "命名空间"},
            "pod_name": {"type": "string", "description": "Pod 名称"},
            "container": {"type": "string", "description": "容器名（多容器 Pod 必填）"},
            "tail_lines": {"type": "number", "description": "返回最近 N 行，默认 100"},
            "previous": {"type": "boolean", "description": "是否查看上一次容器实例日志"},
            "since": {"type": "string", "description": "例如 '5m' / '1h'"},
        },
        ["host", "pod_name"],
    ),
    _tool(
        "inspect_files",
        "medium",
        "跨主机比对文件/宿主路径的「变更面指纹」(类型/大小/mtime/权限, 可选 sha256), 返回逐主机结果与差异清单。"
        "用于定位节点间差异: 当异常只出现在部分节点时(同镜像同配置却只有某节点崩溃), 先用本工具比对它们"
        "共享的宿主路径(如 hostPath 挂载的二进制、驱动、配置)的版本/大小/时间戳。"
        "hosts 必填且至少 1 个(可含 'local', 可直接用 k8s 节点名如 'node-1', 会解析到唯一匹配的 Host Registry 注册项); "
        "paths 必须是绝对路径。SSH 登录远端, 需人工审批。",
        {
            "hosts": {
                "type": "array",
                "items": {"type": "string"},
                "description": "目标主机别名列表, 如 ['node-1','node-2','node-3']; 'local' 表示服务端主机",
            },
            "paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "绝对路径列表, 如 ['/usr/local/bin/helm', '/etc/kubernetes/kubelet.conf']",
            },
            "hash": {"type": "boolean", "description": "是否计算 sha256(内容比对, 较大文件更慢), 默认 false"},
        },
        ["hosts", "paths"],
    ),
]


async def run(cmd: str, args: list[str], timeout_ms: int = 8000) -> dict[str, Any]:
    """封装本地命令执行，语义对齐 node:child_process.execFile。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            cmd, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except (FileNotFoundError, PermissionError, OSError) as err:
        return {"stdout": "", "stderr": "", "code": 127, "error": str(err)}
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout_ms / 1000)
    except asyncio.TimeoutError:
        kill_quietly(proc)
        try:
            await proc.wait()
        except Exception:  # noqa: BLE001
            pass
        # 与 Node 版一致：超时被杀时 err.code 为空 -> code 归一为 0
        return {"stdout": "", "stderr": "", "code": 0}
    except BaseException:
        # 会话被中断：立刻终止子进程，避免 kubectl/shell 命令在后台继续跑
        kill_quietly(proc)
        raise
    return {
        "stdout": stdout.decode("utf-8", "replace"),
        "stderr": stderr.decode("utf-8", "replace"),
        "code": proc.returncode or 0,
    }


async def execute_on_host(
    host: str, command: str, args: list[str], timeout_ms: int = 8000
) -> ToolExecutionResult:
    start = time.time()
    if host and host != "local":
        res = await asyncio.to_thread(
            remote_skill.ssh_execute, host, command, args, timeout_ms, "linux-skill"
        )
        if not res.get("success"):
            return ToolExecutionResult(
                success=False,
                error=res.get("error") or f"远程主机 {host} 执行失败",
                durationMs=int((time.time() - start) * 1000),
            )
        code = res.get("code") or 0
        out, err = res.get("stdout") or "", res.get("stderr") or ""
        if code != 0:
            return ToolExecutionResult(
                success=False,
                stdout=out,
                stderr=err,
                error=f"远程命令退出码非 0: {code}" + (f"; stderr: {err.strip()[:400]}" if err.strip() else ""),
                durationMs=int((time.time() - start) * 1000),
            )
        return ToolExecutionResult(
            success=True,
            stdout=out,
            stderr=err,
            durationMs=int((time.time() - start) * 1000),
        )
    try:
        result = await run(command, args, timeout_ms)
    except Exception as err:  # noqa: BLE001
        return ToolExecutionResult(
            success=False,
            stdout="",
            stderr="",
            durationMs=int((time.time() - start) * 1000),
            error=f"本地执行失败: {err}",
        )
    code = result["code"]
    # run() 在命令不存在时返回 code=127 并带上原始 errno 说明；直接吞掉会让模型只看到
    # 「退出码非 0: 127」，无法判断是命令缺失还是命令自身失败。
    detail = result.get("error")
    return ToolExecutionResult(
        success=code == 0,
        stdout=redact(result["stdout"]),
        stderr=redact(result["stderr"]),
        durationMs=int((time.time() - start) * 1000),
        error=(f"本地命令退出码非 0: {code}" + (f"（{detail}）" if detail else "")) if code != 0 else None,
    )


def _ms(start: float) -> int:
    return int((time.time() - start) * 1000)


def _sh(script: str) -> list[str]:
    return ["-c", script]


async def _execute_local(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    start = time.time()
    host = str(args.get("host") or "local")

    if tool == "get_cpu_usage":
        r = await execute_on_host(host, "sh", _sh("top -b -n 1 | head -n 15"), 10000)
        r.durationMs = _ms(start)
        return r

    if tool == "get_memory_info":
        free_res, dmesg_res = await asyncio.gather(
            execute_on_host(host, "free", ["-m"], 8000),
            execute_on_host(
                "local", "sh", _sh("dmesg 2>/dev/null | grep -i 'out of memory\\|oom' | tail -n 10 || true"), 8000
            ),
        )
        proc_detail: dict[str, Any] | None = None
        pid = args.get("pid")
        if pid:
            try:
                status = await execute_on_host(host, "cat", [f"/proc/{int(pid)}/status"])
                import re

                rss = re.search(r"VmRSS:\s+(\d+)\s+kB", status.stdout or "")
                vm_size = re.search(r"VmSize:\s+(\d+)\s+kB", status.stdout or "")
                proc_detail = {
                    "pid": pid,
                    "rss_mb": round(int(rss.group(1)) / 1024) if rss else None,
                    "vm_size_mb": round(int(vm_size.group(1)) / 1024) if vm_size else None,
                }
            except Exception:  # noqa: BLE001
                proc_detail = {"pid": pid, "error": "process not found (可能已退出/重启)"}
        return ToolExecutionResult(
            success=free_res.success,
            data={
                "free_output": redact(free_res.stdout or ""),
                "oom_history": redact(dmesg_res.stdout or "")
                or "(无OOM Killer触发记录, 说明是容器级/应用级自我判断退出, 而非内核强杀)",
                "process_detail": proc_detail,
            },
            stderr=free_res.stderr or dmesg_res.stderr,
            error=free_res.error or dmesg_res.error,
            durationMs=_ms(start),
        )

    if tool == "get_disk_usage":
        r = await execute_on_host(host, "df", ["-h"], 8000)
        r.durationMs = _ms(start)
        return r

    if tool == "get_process_info":
        pattern = sanitize_pattern(str(args.get("name_pattern") or ""))
        r = await execute_on_host(
            "local",
            "sh",
            _sh(f"ps -eo pid,rss,pcpu,etimes,cmd | grep -i '{pattern}' | grep -v grep || true"),
            8000,
        )
        r.stdout = r.stdout or "(未找到匹配进程)"
        r.durationMs = _ms(start)
        return r

    if tool in ("tail_recent_dmesg_or_syslog", "tail_syslog"):
        r = await execute_on_host(
            "local",
            "sh",
            _sh("dmesg 2>/dev/null | tail -n 20 || echo '(无dmesg访问权限, 生产环境通过node常驻agent或特权容器采集)'"),
            8000,
        )
        r.durationMs = _ms(start)
        return r

    if tool == "get_network_stats":
        r = await execute_on_host(host, "ss", ["-s"], 8000)
        r.durationMs = _ms(start)
        return r

    if tool == "run_command":
        command = str(args.get("command") or "")
        cmd_args = [str(a) for a in args.get("args") or []] if isinstance(args.get("args"), list) else []
        allowed, reason = is_command_allowed(command, cmd_args)
        if not allowed:
            return ToolExecutionResult(success=False, error=reason, durationMs=_ms(start))
        r = await execute_on_host(host, command, cmd_args, int(args.get("timeout_ms") or 10000))
        r.durationMs = _ms(start)
        return r

    if tool == "read_file":
        r = await execute_on_host(host, "cat", [str(args.get("path") or "")], 10000)
        r.durationMs = _ms(start)
        return r

    if tool == "tail_file":
        r = await execute_on_host(
            "local", "tail", ["-n", str(args.get("lines") or 20), str(args.get("path") or "")], 10000
        )
        r.durationMs = _ms(start)
        return r

    if tool == "list_directory":
        r = await execute_on_host(host, "ls", ["-la", str(args.get("path") or ".")], 8000)
        r.durationMs = _ms(start)
        return r

    if tool == "check_service_status":
        r = await execute_on_host(host, "systemctl", ["status", str(args.get("service_name") or "")], 10000)
        r.durationMs = _ms(start)
        return r

    if tool in ("get_kubernetes_resource", "describe_kubernetes_resource"):
        sub = "get" if tool == "get_kubernetes_resource" else "describe"
        r = await execute_on_host(host, "kubectl", _build_kubectl_args(sub, args), 15000)
        r.durationMs = _ms(start)
        return _with_kubectl_fallback(r)

    if tool == "get_pod_logs":
        # 服务端容器通常没有 kubectl：改走 K8s API（与 k8s.get_pod_logs 同一实现）
        from . import k8s as k8s_skill

        try:
            logs = await k8s_skill.read_pod_logs(
                str(args.get("namespace") or ""),
                str(args.get("pod_name") or ""),
                container=args.get("container"),
                tail_lines=int(args.get("tail_lines") or 100),
                previous=bool(args.get("previous")),
                since_seconds=k8s_skill.parse_since_seconds(args.get("since")),
            )
        except Exception as err:  # noqa: BLE001 - 读取失败时给出替代方案而不是栈信息
            return ToolExecutionResult(
                success=False,
                error=f"读取 Pod 日志失败: {err}。可改用 k8s.get_pod_logs 或 clickhouse.search_logs。",
                durationMs=_ms(start),
            )
        return ToolExecutionResult(success=True, stdout=redact(logs), durationMs=_ms(start))

    return ToolExecutionResult(success=False, error=f"本地不支持的linux工具: {tool}", durationMs=_ms(start))


def _with_kubectl_fallback(result: ToolExecutionResult) -> ToolExecutionResult:
    """kubectl 缺失（退出码 127）时，把「退出码非 0」换成模型能照做的替代方案。"""
    if not result.success and "退出码非 0: 127" in (result.error or ""):
        result.error = _KUBECTL_FALLBACK
    return result


def _build_kubectl_args(sub_command: str, args: dict[str, Any]) -> list[str]:
    out = [sub_command]
    if args.get("namespace"):
        out += ["-n", str(args["namespace"])]
    if args.get("all_namespaces"):
        out.append("--all-namespaces")
    out.append(str(args.get("resource") or "pods"))
    if args.get("name"):
        out.append(str(args["name"]))
    if args.get("output"):
        out += ["-o", str(args["output"])]
    return out



async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    start = time.time()
    try:
        if tool == "inspect_files":
            return await _inspect_files(args, start)
        return await _execute_local(tool, args)
    except Exception as err:  # noqa: BLE001
        return ToolExecutionResult(success=False, error=str(err), durationMs=_ms(start))


async def _fingerprint_local(paths: list[str], want_hash: bool) -> dict[str, Any]:
    res = await run("stat", ["-c", remote_skill.STAT_FORMAT, *paths], 10000)
    files = remote_skill.parse_stat_lines(res.get("stdout") or "")
    if want_hash and files:
        sha = await run("sha256sum", list(files.keys()), 15000)
        for name, digest in remote_skill.parse_sha_lines(sha.get("stdout") or "").items():
            if name in files:
                files[name]["sha256"] = digest
    return {
        "host": "local",
        "files": [{"path": p, **files[p]} for p in paths if p in files],
        "missing": [p for p in paths if p not in files],
        "errors": [ln.strip() for ln in (res.get("stderr") or "").splitlines() if ln.strip()],
    }


def _diff_fingerprints(per_host: list[dict[str, Any]], paths: list[str]) -> list[dict[str, Any]]:
    """同一路径在不同主机上指纹不一致 -> 这就是节点间"宿主层差异", 是最强的判别量。"""
    out: list[dict[str, Any]] = []
    for path in paths:
        groups: dict[str, dict[str, Any]] = {}
        for entry in per_host:
            found = next((f for f in entry.get("files") or [] if f.get("path") == path), None)
            sig = (
                "missing"
                if found is None
                else "|".join(str(found.get(k)) for k in ("type", "size", "mtime", "mode", "sha256"))
            )
            group = groups.setdefault(sig, {"hosts": [], "fingerprint": found})
            group["hosts"].append(entry.get("host"))
        if len(groups) > 1:
            out.append(
                {
                    "path": path,
                    "groups": sorted(
                        (
                            {"hosts": g["hosts"], **(g["fingerprint"] or {"missing": True})}
                            for g in groups.values()
                        ),
                        key=lambda g: -len(g["hosts"]),
                    ),
                }
            )
    return out


def _render_fingerprint(data: dict[str, Any]) -> str:
    lines: list[str] = []
    for entry in data.get("hosts") or []:
        for f in entry.get("files") or []:
            lines.append(
                f"{entry.get('host')}\t{f.get('path')}\tsize={f.get('size')}\tmtime={f.get('mtimeIso')}"
                f"\tmode={f.get('mode')}\ttype={f.get('type')}"
                + (f"\tsha256={f.get('sha256')}" if f.get("sha256") else "")
            )
        for p in entry.get("missing") or []:
            lines.append(f"{entry.get('host')}\t{p}\t不存在或不可读")
        for e in entry.get("errors") or []:
            lines.append(f"{entry.get('host')}\tERROR\t{e}")
    for diff in data.get("differing") or []:
        parts = []
        for g in diff.get("groups") or []:
            desc = "缺失" if g.get("missing") else f"size={g.get('size')}, mtime={g.get('mtimeIso')}"
            if g.get("sha256"):
                desc += f", sha256={g.get('sha256')[:12]}"
            parts.append(f"{','.join(g.get('hosts') or [])} [{desc}]")
        lines.append(f"DIFF\t{diff.get('path')}\t" + " vs ".join(parts))
    return "\n".join(lines)


async def _inspect_files(args: dict[str, Any], start: float) -> ToolExecutionResult:
    """跨主机比对宿主文件指纹 —— 用于"异常只出现在部分节点"时的差分定位。"""
    hosts = [str(h).strip() for h in (args.get("hosts") or []) if str(h).strip()]
    paths = [str(p).strip() for p in (args.get("paths") or []) if str(p).strip()]
    want_hash = bool(args.get("hash"))
    if not hosts:
        return ToolExecutionResult(success=False, error="inspect_files 需要 hosts(至少 1 个主机别名)", durationMs=_ms(start))
    if not paths:
        return ToolExecutionResult(success=False, error="inspect_files 需要 paths(至少 1 个绝对路径)", durationMs=_ms(start))
    for p in paths:
        if not p.startswith("/") or "\n" in p:
            return ToolExecutionResult(
                success=False, error=f"paths 必须是绝对路径且不含换行: {p}", durationMs=_ms(start)
            )

    per_host: list[dict[str, Any]] = []
    for host in hosts:
        if host == "local":
            per_host.append(await _fingerprint_local(paths, want_hash))
        else:
            per_host.append(await asyncio.to_thread(remote_skill.fingerprint_files, host, paths, want_hash))

    data: dict[str, Any] = {"hosts": per_host, "differing": _diff_fingerprints(per_host, paths)}
    if len(hosts) > 1 and not data["differing"] and not want_hash:
        data["hint"] = "未发现大小/mtime 差异; 若仍怀疑内容不一致, 用 hash=true 重跑比对 sha256。"
    probed = [r for r in per_host if r.get("files")]
    return ToolExecutionResult(
        success=bool(probed),
        data=data,
        stdout=_render_fingerprint(data),
        error=None if probed else "所有主机的宿主路径探测均失败(检查 Host Registry 与路径)",
        durationMs=_ms(start),
    )


async def find_worker_pid(name_pattern: str) -> int | None:
    import re

    result = await execute_on_host("local", "ps", ["-eo", "pid,cmd"])
    for line in (result.stdout or "").split("\n"):
        if name_pattern in line and "grep" not in line:
            m = re.match(r"^(\d+)\s+", line.strip())
            if m:
                return int(m.group(1))
    return None
