"""只读命令白名单 —— 对应 `server/src/mcp/server/allowlist.ts`。"""

from __future__ import annotations

import os
import re

ALLOWED_SERVICES = {"nginx", "docker", "containerd", "kubelet", "sshd", "cron"}
ALLOWED_SIGNALS = {"SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2"}

DEFAULT_ALLOWED_COMMANDS = {
    "cat", "head", "tail", "less", "more", "ls", "stat", "file", "find", "grep", "awk", "sed",
    "jq", "sort", "uniq", "wc",
    "ps", "top", "ss", "netstat", "ip", "ifconfig", "lsof", "df", "du", "free", "vmstat",
    "iostat", "pidstat", "uptime", "uname", "lscpu", "lsblk", "fdisk", "dmesg", "journalctl",
    "systemctl",
    "ping", "traceroute", "nslookup", "dig", "curl", "wget", "nc",
    "kubectl", "crictl", "docker",
}

COMMAND_SUBCOMMAND_ALLOWLIST: dict[str, set[str] | None] = {
    "systemctl": {"status", "is-active", "is-enabled", "is-failed", "show", "list-units", "list-unit-files"},
    "journalctl": None,
    "kubectl": {"get", "describe", "logs", "top", "version", "auth", "api-resources", "api-versions", "explain"},
    "crictl": {"ps", "pods", "logs", "inspect", "stat", "info", "version"},
    "docker": {"ps", "images", "stats", "inspect", "logs", "info", "version"},
}


def is_service_allowed(service_name: str) -> bool:
    return service_name in ALLOWED_SERVICES


def is_signal_allowed(signal: str) -> bool:
    return signal in ALLOWED_SIGNALS


def sanitize_pattern(pattern: str) -> str:
    """只允许字母数字下划线点横线，防止 shell 注入。"""
    return re.sub(r"[^a-zA-Z0-9_.\-]", "", pattern)


def get_allowed_commands() -> set[str]:
    extra = os.environ.get("MCP_COMMAND_ALLOWLIST", "")
    extensions = {c.strip() for c in extra.split(",") if c.strip()}
    return DEFAULT_ALLOWED_COMMANDS | extensions


def is_command_allowed(command: str, args: list[str] | None = None) -> tuple[bool, str | None]:
    args = args or []
    if "/" in command or "\\" in command or command.startswith("."):
        return False, "command 只能是 PATH 中的命令名，不能包含路径"
    if command not in get_allowed_commands():
        return False, f"命令 {command} 不在白名单中。可通过 MCP_COMMAND_ALLOWLIST 扩展"

    sub_allowlist = COMMAND_SUBCOMMAND_ALLOWLIST.get(command)
    if sub_allowlist and args:
        idx = 0
        while idx < len(args) and args[idx].startswith("-"):
            idx += 1
        sub = args[idx] if idx < len(args) else None
        if sub and sub not in sub_allowlist:
            return False, f"命令 {command} {sub} 不在允许子命令列表中"
    return True, None
