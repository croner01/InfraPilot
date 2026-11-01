"""沙箱代码执行（P2）—— SRE 日志分析脚本的安全运行环境。

对应差距分析 §3 #11「沙箱代码执行（interpreter）」。Node 版无此能力。

隔离手段（进程级沙箱，非容器级安全边界，已在文档中明确）：
1. 独立子进程 `python3 -I`（isolated：忽略 PYTHON* 环境变量、不加载 user site）；
2. 每次执行独立工作目录 `data/sandbox/<id>`，输入/输出文件都在其中；
3. 子进程内自设 rlimit：CPU 时间、地址空间、文件大小、打开文件数；
4. `sys.addaudithook` 拦截网络（socket/urllib）、进程派生（subprocess/os.exec/pty）、
   ctypes 动态加载，以及沙箱目录之外的写文件；
5. 环境变量最小化（不继承 API Key 等敏感变量）；
6. 父进程硬超时 + 输出截断。

风险等级 `medium`：通过 Command Gateway 执行时需要人工审批。
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from typing import Any, Optional

from .settings import DATA_DIR
from .util import kill_quietly, new_id

SANDBOX_ROOT = (DATA_DIR / "sandbox").resolve()
MAX_OUTPUT_CHARS = 20_000

RUNNER_SOURCE = r'''
import os, sys, traceback

SANDBOX = os.path.realpath(sys.argv[1])
CODE = os.path.realpath(sys.argv[2])
cpu_seconds = int(sys.argv[3])
memory_mb = int(sys.argv[4])
max_file_mb = int(sys.argv[5])

try:
    import resource

    def _limit(kind, value):
        try:
            resource.setrlimit(kind, (value, value))
        except (ValueError, OSError):
            pass

    _limit(resource.RLIMIT_CPU, cpu_seconds)
    _limit(resource.RLIMIT_AS, memory_mb * 1024 * 1024)
    _limit(resource.RLIMIT_FSIZE, max_file_mb * 1024 * 1024)
    _limit(resource.RLIMIT_NOFILE, 64)
except Exception:
    pass

BLOCKED_MODULES = {"socket", "subprocess", "ctypes", "multiprocessing", "pty"}
BLOCKED_PREFIXES = ("socket.", "subprocess.", "ctypes.", "pty.")


def _audit(event, args):
    if event in ("os.system", "os.fork", "os.forkpty", "os.exec", "os.posix_spawn", "os.spawn"):
        raise PermissionError("[sandbox] 禁止派生进程: " + event)
    if event.startswith(BLOCKED_PREFIXES):
        raise PermissionError("[sandbox] 禁止的操作: " + event)
    if event == "import":
        name = str(args[0]).split(".")[0]
        if name in BLOCKED_MODULES:
            raise PermissionError("[sandbox] 禁止导入模块: " + name)
    if event == "open":
        path, mode = args[0], (args[1] or "")
        if isinstance(mode, str) and any(flag in mode for flag in ("w", "a", "x", "+")):
            real = os.path.realpath(str(path))
            if real != SANDBOX and not real.startswith(SANDBOX + os.sep):
                raise PermissionError("[sandbox] 仅允许写入沙箱目录: " + str(path))


sys.addaudithook(_audit)

with open(CODE, "r", encoding="utf-8") as fh:
    source = fh.read()

namespace = {"__name__": "__main__", "__file__": CODE}
try:
    exec(compile(source, CODE, "exec"), namespace)
except SystemExit as exc:
    sys.exit(int(exc.code) if isinstance(exc.code, int) else (0 if exc.code is None else 1))
except BaseException:
    traceback.print_exc()
    sys.exit(1)
'''


def _truncate(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text, False
    return text[:MAX_OUTPUT_CHARS] + f"\n...[已截断，共 {len(text)} 字符]", True


async def run_python(
    code: str,
    *,
    timeout_seconds: float = 15,
    memory_mb: int = 512,
    cpu_seconds: Optional[int] = None,
    max_file_mb: int = 32,
    files: Optional[dict[str, str]] = None,
    keep: bool = True,
) -> dict[str, Any]:
    """在沙箱子进程中执行 Python 代码，返回 stdout/stderr/退出码/产物文件。"""
    start = time.time()
    sandbox_id = new_id()
    workdir = SANDBOX_ROOT / sandbox_id
    workdir.mkdir(parents=True, exist_ok=True)

    for name, content in (files or {}).items():
        target = (workdir / name).resolve()
        if not str(target).startswith(str(workdir)):
            return {"ok": False, "sandboxId": sandbox_id, "error": f"非法输入文件名: {name}"}
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content), encoding="utf-8")

    (workdir / "main.py").write_text(code or "", encoding="utf-8")
    (workdir / "_runner.py").write_text(RUNNER_SOURCE, encoding="utf-8")

    cpu_limit = int(cpu_seconds if cpu_seconds is not None else max(1, int(timeout_seconds)))
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(workdir),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-I",
        str(workdir / "_runner.py"),
        str(workdir),
        str(workdir / "main.py"),
        str(cpu_limit),
        str(memory_mb),
        str(max_file_mb),
        cwd=str(workdir),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timed_out = False
    try:
        raw_out, raw_err = await asyncio.wait_for(proc.communicate(), max(1.0, float(timeout_seconds)))
    except asyncio.TimeoutError:
        timed_out = True
        kill_quietly(proc)
        try:
            raw_out, raw_err = await proc.communicate()
        except Exception:  # noqa: BLE001
            raw_out, raw_err = b"", b""
    except BaseException:
        # 会话被中断：终止沙箱进程并清理工作目录，避免代码在后台继续执行
        kill_quietly(proc)
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)
        raise
    stdout, out_truncated = _truncate(raw_out.decode("utf-8", "replace"))
    stderr, err_truncated = _truncate(raw_err.decode("utf-8", "replace"))
    produced = sorted(p.name for p in workdir.iterdir() if p.is_file() and p.name not in ("main.py", "_runner.py"))
    result: dict[str, Any] = {
        "ok": (not timed_out) and proc.returncode == 0,
        "sandboxId": sandbox_id,
        "workdir": str(workdir),
        "exitCode": proc.returncode,
        "timedOut": timed_out,
        "stdout": stdout,
        "stderr": stderr,
        "truncated": out_truncated or err_truncated,
        "durationMs": int((time.time() - start) * 1000),
        "files": produced,
    }
    if timed_out:
        result["error"] = f"执行超时（>{timeout_seconds}s），已终止沙箱进程"
    if not keep:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)
        result.pop("workdir", None)
    return result
