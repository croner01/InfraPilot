"""Interpreter Skill（P2）—— 在沙箱子进程中运行 Python 做日志/指标分析。

工具名：`interpreter__run_python`。风险级别 medium（任意代码执行，需审批）。
"""

from __future__ import annotations

import time
from typing import Any

from ..interpreter import run_python
from ..models import ToolDef, ToolExecutionResult
from ..redact import redact

TOOLS: list[ToolDef] = [
    ToolDef(
        name="run_python",
        skill="interpreter",
        risk="medium",
        description=(
            "在受限沙箱中执行一段 Python 脚本（适合日志聚合、JSON/CSV 解析、指标计算）。"
            "沙箱禁网、禁子进程、禁 ctypes，只能写入自己的沙箱工作目录；有 CPU/内存/超时限制。"
            "可用 files 传入输入文件；执行后可读取返回的 files 列表（产物在 workdir 下）。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "要执行的 Python 源码"},
                "timeout_ms": {"type": "number", "description": "超时毫秒数，默认 15000，最大 120000"},
                "memory_mb": {"type": "number", "description": "内存上限 MB，默认 512"},
                "files": {
                    "type": "object",
                    "description": "可选，{文件名: 文本内容}，写入沙箱工作目录后再执行",
                    "additionalProperties": {"type": "string"},
                },
            },
            "required": ["code"],
            "additionalProperties": False,
        },
    ),
]


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    start = time.time()
    if tool != "run_python":
        return ToolExecutionResult(success=False, error=f"未知的interpreter工具: {tool}", durationMs=0)
    code = str(args.get("code") or "")
    if not code.strip():
        return ToolExecutionResult(success=False, error="code 不能为空", durationMs=0)
    timeout_s = min(max(float(args.get("timeout_ms") or 15000) / 1000.0, 0.5), 120.0)
    memory_mb = max(64, min(int(args.get("memory_mb") or 512), 4096))
    try:
        result = await run_python(code, timeout_seconds=timeout_s, memory_mb=memory_mb, files=args.get("files") or None)
    except Exception as err:  # noqa: BLE001 - 沙箱启动失败要如实返回
        return ToolExecutionResult(success=False, error=f"沙箱执行失败: {err}", durationMs=int((time.time() - start) * 1000))

    data = dict(result)
    data["stdout"] = redact(result.get("stdout") or "")
    data["stderr"] = redact(result.get("stderr") or "")
    return ToolExecutionResult(
        success=bool(result.get("ok")),
        data=data,
        stdout=data["stdout"],
        stderr=data["stderr"],
        error=result.get("error") if not result.get("ok") else None,
        durationMs=int((time.time() - start) * 1000),
    )
