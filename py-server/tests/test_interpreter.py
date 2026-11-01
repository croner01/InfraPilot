"""P2 沙箱代码执行：功能 + 隔离护栏（纯离线，仅派生本地子进程）。"""

from __future__ import annotations

import asyncio

from infrapilot import interpreter
from infrapilot.skills import interpreter as skill


def run(coro):
    return asyncio.run(coro)


def test_tool_def_requires_approval():
    assert [t.name for t in skill.TOOLS] == ["run_python"]
    assert skill.TOOLS[0].skill == "interpreter"
    assert skill.TOOLS[0].risk == "medium"


def test_run_python_happy_path_and_artifacts():
    result = run(interpreter.run_python("print('sum', sum([1,2,3]))\nopen('out.txt','w').write('hi')\n"))
    assert result["ok"] is True
    assert "sum 6" in result["stdout"]
    assert "out.txt" in result["files"]
    assert result["exitCode"] == 0


def test_run_python_reads_input_files():
    result = run(interpreter.run_python("print(open('in.txt').read())\n", files={"in.txt": "hello-sandbox"}))
    assert result["ok"] is True
    assert "hello-sandbox" in result["stdout"]


def test_run_python_blocks_network():
    result = run(interpreter.run_python("import socket\nsocket.socket()\n"))
    assert result["ok"] is False
    assert "socket" in result["stderr"]


def test_run_python_blocks_subprocess_and_outside_writes():
    spawned = run(interpreter.run_python("import subprocess\nsubprocess.run(['ls'])\n"))
    assert spawned["ok"] is False and "subprocess" in spawned["stderr"]
    outside = run(interpreter.run_python("open('/tmp/infrapilot-escape.txt','w').write('x')\n"))
    assert outside["ok"] is False and "沙箱" in outside["stderr"]


def test_run_python_timeout():
    result = run(interpreter.run_python("while True:\n    pass\n", timeout_seconds=2))
    assert result["ok"] is False
    assert result["timedOut"] is True
    assert "超时" in result["error"]


def test_skill_execute_validates_and_redacts():
    assert run(skill.execute("run_python", {})).success is False
    assert run(skill.execute("nope", {"code": "print(1)"})).success is False
    result = run(skill.execute("run_python", {"code": "print('password: hunter2')"}))
    assert result.success is True
    assert "hunter2" not in result.stdout
    assert "***REDACTED***" in result.stdout
