"""SSH 远程主机执行通道 —— 对应 `server/src/gateway/sshProxy.ts` 与 docs/ssh-proxy-linux-remote.md。

职责:
1. 根据 host 别名从 Host Registry(config_store)取连接信息;
2. 校验只读命令白名单,拒绝变更类操作;
3. 通过 paramiko 在远程主机执行命令;
4. 输出经 redact() 脱敏。

安全边界:
- 本模块是 Python 后端中唯一直接使用 SSH 凭据的模块,Agent 只传主机别名与命令参数;
- 远程执行**只允许只读诊断命令**;systemctl/service 只允许查询子命令;
- 所有参数经 shlex.quote 拼接,不接受调用方传入的原始 shell 字符串。

审批边界:
- `host != "local"` 的调用由 policy.classify_risk 强制升级为需人工审批(medium)。
"""

from __future__ import annotations

import datetime as _dt
import os
import shlex
import time
from typing import Any, Optional

from . import config_store
from .redact import redact

# 只读诊断命令白名单(token 级);变更类命令一律拒绝。
DEFAULT_DIAGNOSTIC_ALLOWLIST: set[str] = {
    # 进程 / CPU / 内存 / 磁盘
    "top", "htop", "ps", "free", "vmstat", "mpstat", "iostat", "pidstat", "df", "du", "lsblk", "fdisk", "ls",
    # 内核 / 系统日志
    "dmesg", "journalctl", "uptime", "uname", "cat", "tail", "head", "grep", "zgrep", "zcat",
    # 网络
    "ss", "netstat", "ip", "ifconfig", "ping", "traceroute", "nslookup", "dig", "curl", "wget", "nc",
    # systemd / 虚拟化 / 网络虚拟化
    "systemctl", "service", "virsh", "ovs-vsctl", "ovs-ofctl", "brctl", "ipvsadm",
    # 文件探测(宿主文件版本漂移排查的关键手段)
    "find", "lsof", "stat", "file", "readlink", "sha256sum", "md5sum", "wc", "which", "dirname", "basename",
    # 容器运行时
    "kubectl", "crictl", "docker", "ctr", "runc",
    # 只读辅助
    "sleep", "echo", "date", "hostname", "cat",
}

# systemctl/service 只允许查询类子命令,禁止 restart/stop 等变更操作。
DANGEROUS_SUBCOMMANDS: set[str] = {
    "restart", "stop", "start", "reload", "enable", "disable", "mask", "unmask",
    "kill", "killall", "reboot", "shutdown", "poweroff", "halt", "daemon-reload",
}

_SHELL_METACHARS = ("\n", "\r", "\x00")


class RemoteError(RuntimeError):
    """远程执行的用户可见错误(不包含凭据/栈信息)。"""


def load_allowlist() -> set[str]:
    extra = os.environ.get("SSH_COMMAND_ALLOWLIST", "")
    allowed = set(DEFAULT_DIAGNOSTIC_ALLOWLIST)
    allowed |= {c.strip() for c in extra.split(",") if c.strip()}
    return allowed


def resolve_auth_secret(auth: dict[str, Any]) -> dict[str, Any]:
    resolved = dict(auth or {})
    for key, target in (("passwordEnv", "password"), ("passphraseEnv", "passphrase")):
        env_name = auth.get(key) if auth else None
        if env_name and os.environ.get(env_name):
            resolved[target] = os.environ[env_name]
    return resolved


def private_key_content(auth: dict[str, Any]) -> Optional[str]:
    if auth.get("privateKey"):
        return str(auth["privateKey"])
    env_name = auth.get("privateKeyEnv")
    if env_name and os.environ.get(env_name):
        return os.environ[env_name]
    path = auth.get("privateKeyPath")
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    return None


def get_host(name: str) -> Optional[dict[str, Any]]:
    return resolve_host(name)[0]


def resolve_host(name: str) -> tuple[Optional[dict[str, Any]], Optional[str], list[str]]:
    """解析主机别名。

    模型从 k8s 看到的是节点名(node-1), 而 Host Registry 里的别名可能是
    "生产集群204-node-1"。先精确匹配, 再按 "-name"/"_name"/".name" 后缀匹配;
    后缀匹配到多个时**不猜**, 返回候选让调用方要求显式指定完整别名。

    返回 (host_cfg, 实际别名, 歧义候选列表)。
    """
    registry = config_store.get_host_registry()
    exact = config_store.find_host(registry, name)
    if exact:
        return exact, name, []
    candidates = [
        h
        for h in registry.get("hosts") or []
        if str(h.get("name") or "").endswith(("-" + name, "_" + name, "." + name))
    ]
    if len(candidates) == 1:
        return candidates[0], str(candidates[0].get("name")), []
    return None, None, [str(h.get("name")) for h in candidates]


def list_hosts() -> list[dict[str, Any]]:
    """仅暴露非敏感字段,用于错误提示与工具描述。"""
    out: list[dict[str, Any]] = []
    for h in config_store.get_host_registry().get("hosts") or []:
        out.append({"name": h.get("name"), "hostname": h.get("hostname"), "port": h.get("port") or 22})
    return out


def _connect(host_cfg: dict[str, Any]):
    import io
    import socket

    import paramiko  # 延迟导入:本地开发环境可无 paramiko,不影响模块导入

    auth = resolve_auth_secret(host_cfg.get("auth") or {})
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict[str, Any] = {
        "hostname": host_cfg.get("hostname"),
        "port": host_cfg.get("port") or 22,
        "username": host_cfg.get("username"),
        "timeout": 8,
        "banner_timeout": 8,
        "auth_timeout": 8,
    }
    if auth.get("type") == "password" and auth.get("password"):
        kwargs["password"] = auth["password"]
    elif auth.get("type") == "privateKey":
        key_content = private_key_content(auth)
        if not key_content:
            raise RemoteError("未找到私钥内容(privateKey/privateKeyEnv/privateKeyPath 均不可用)")
        kwargs["pkey"] = paramiko.RSAKey.from_private_key(io.StringIO(key_content), password=auth.get("passphrase"))
    elif auth.get("type") == "agent":
        sock_path = os.environ.get("SSH_AUTH_SOCK") or "/run/user/0/keyring/ssh"
        kwargs["sock"] = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        kwargs["sock"].connect(sock_path)
        kwargs["look_for_keys"] = False
    client.connect(**kwargs)
    return client


def test_connection(host_cfg: dict[str, Any]) -> bool:
    client = _connect(host_cfg)
    try:
        return True
    finally:
        client.close()


def validate_command(command: str, args: list[str]) -> Optional[str]:
    """返回错误信息(None 表示通过)。与 allowlist.is_command_allowed 同构但更严。"""
    if not command:
        return "命令为空"
    if "/" in command or "\\" in command or command.startswith("."):
        return "command 只能是 PATH 中的命令名,不能包含路径"
    if command not in load_allowlist():
        return f"命令 {command} 不在远程只读白名单中。可通过 SSH_COMMAND_ALLOWLIST 扩展"
    for arg in args:
        if any(ch in str(arg) for ch in _SHELL_METACHARS):
            return "参数中不允许出现换行或 NUL 字符"
    if command in ("systemctl", "service"):
        sub = next((str(a) for a in args if not str(a).startswith("-")), "")
        if sub in DANGEROUS_SUBCOMMANDS:
            return f"远程主机禁止执行 {command} {sub}(变更类操作)。远程通道只开放只读诊断命令"
    if command in ("kubectl", "crictl", "docker", "ctr"):
        sub = next((str(a) for a in args if not str(a).startswith("-")), "")
        if sub in {"delete", "exec", "apply", "edit", "patch", "scale", "rollout", "drain", "cordon", "uncordon"}:
            return f"远程主机禁止执行 {command} {sub}(变更类操作)。请改用 k8s 技能对应工具并走审批"
    return None


def build_command_line(command: str, args: list[str]) -> str:
    return " ".join([shlex.quote(command), *[shlex.quote(str(a)) for a in args]])


def ssh_execute(
    host_name: str,
    command: str,
    args: list[str],
    timeout_ms: int = 15000,
    caller: str = "linux-skill",
) -> dict[str, Any]:
    """在注册主机上执行只读命令。返回 {success, stdout, stderr, code, error, host, durationMs, cmdLine}。"""
    started = time.time()

    def done(**kw: Any) -> dict[str, Any]:
        out = {"host": host_name, "durationMs": int((time.time() - started) * 1000)}
        out.update(kw)
        return out

    host_cfg, alias, ambiguous = resolve_host(host_name)
    if not host_cfg:
        if ambiguous:
            return done(
                success=False,
                stdout="",
                stderr="",
                code=None,
                error=(
                    f"主机别名 {host_name} 不唯一, 匹配到多个注册项: {', '.join(ambiguous)}。"
                    "请使用完整的 Host Registry 别名。"
                ),
            )
        names = ", ".join(h.get("name") or "?" for h in list_hosts()) or "(未注册任何主机)"
        return done(
            success=False,
            stdout="",
            stderr="",
            code=None,
            error=f"未知远程主机 {host_name}。Host Registry 中已注册: {names}。请在 设置 → 主机注册表 中添加。",
        )
    host_name = alias or host_name

    invalid = validate_command(command, args)
    if invalid:
        return done(success=False, stdout="", stderr="", code=None, error=invalid)

    cmd_line = build_command_line(command, args)
    try:
        client = _connect(host_cfg)
    except RemoteError as err:
        return done(success=False, stdout="", stderr="", code=None, error=f"连接 {host_name} 失败: {err}")
    except Exception as err:  # noqa: BLE001
        return done(
            success=False,
            stdout="",
            stderr="",
            code=None,
            error=f"连接 {host_name}({host_cfg.get('hostname')}:{host_cfg.get('port') or 22}) 失败: {err}",
        )

    try:
        _stdin, stdout, stderr = client.exec_command(cmd_line, timeout=timeout_ms / 1000)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
    except Exception as exc:  # noqa: BLE001
        return done(success=False, stdout="", stderr="", code=None, error=f"远程执行 {cmd_line} 失败: {exc}")
    finally:
        client.close()

    return done(
        success=True,
        stdout=redact(out),
        stderr=redact(err),
        code=code,
        cmdLine=cmd_line,
        caller=caller,
    )


STAT_FORMAT = "%n@@%F@@%s@@%Y@@%a"


def parse_stat_lines(text: str) -> dict[str, dict[str, Any]]:
    files: dict[str, dict[str, Any]] = {}
    for line in text.splitlines():
        parts = line.split("@@")
        if len(parts) != 5:
            continue
        name, ftype, size, mtime, mode = parts
        try:
            mtime_i = int(mtime)
        except ValueError:
            mtime_i = 0
        files[name] = {
            "exists": True,
            "type": ftype,
            "size": int(size) if size.isdigit() else None,
            "mtime": mtime_i or None,
            "mtimeIso": (
                _dt.datetime.fromtimestamp(mtime_i, _dt.timezone.utc).isoformat() if mtime_i else None
            ),
            "mode": mode,
        }
    return files


def parse_sha_lines(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) == 2:
            out[parts[1].strip()] = parts[0]
    return out


def fingerprint_files(
    host_name: str, paths: list[str], want_hash: bool = False, timeout_ms: int = 20000
) -> dict[str, Any]:
    """对远端主机上的指定路径取「变更面指纹」: 类型/大小/mtime/权限(+可选 sha256)。"""
    stat_res = ssh_execute(host_name, "stat", ["-c", STAT_FORMAT, *paths], timeout_ms=timeout_ms)
    if not stat_res.get("success"):
        return {"host": host_name, "files": [], "errors": [stat_res.get("error") or "stat 执行失败"]}

    files = parse_stat_lines(stat_res.get("stdout") or "")
    errors: list[str] = [
        line.strip()
        for line in (stat_res.get("stderr") or "").splitlines()
        if line.strip() and "No such file" not in line
    ]
    missing = [p for p in paths if p not in files]

    if want_hash and files:
        sha_res = ssh_execute(host_name, "sha256sum", list(files.keys()), timeout_ms=timeout_ms)
        if sha_res.get("success"):
            hashes = parse_sha_lines(sha_res.get("stdout") or "")
            for name, digest in hashes.items():
                if name in files:
                    files[name]["sha256"] = digest

    return {
        "host": host_name,
        "files": [{"path": p, **files[p]} for p in paths if p in files],
        "missing": missing,
        "errors": errors,
    }
