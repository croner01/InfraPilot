"""P2 上下文压缩：token 估算 / LLM 摘要 / 离线兜底 / 工具消息配对护栏。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from infrapilot import compression, sessions, structured


def run(coro):
    return asyncio.run(coro)


def _cp(history):
    return SimpleNamespace(history=history)


def test_estimate_tokens_and_history_tokens():
    assert compression.estimate_tokens("") == 0
    assert compression.estimate_tokens("abcdefgh") == 2
    assert compression.estimate_tokens("中文中文") >= 2
    total = compression.history_tokens([{"role": "user", "content": "hello world"}])
    assert total > 0


def test_no_compression_when_disabled_or_under_budget(monkeypatch):
    sid = sessions.create_session("compress-disabled").id
    checkpoint = _cp([{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}])
    monkeypatch.setenv("INFRAPILOT_CONTEXT_COMPRESS", "0")
    assert run(compression.maybe_compress(sid, checkpoint)) is None
    monkeypatch.setenv("INFRAPILOT_CONTEXT_COMPRESS", "1")
    assert run(compression.maybe_compress(sid, checkpoint, max_tokens_override=10_000)) is None


def test_deterministic_fallback_keeps_system_prompt_and_recent(monkeypatch):
    sid = sessions.create_session("compress-fallback").id
    history = [{"role": "system", "content": "SYSTEM-PROMPT"}] + [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"消息 {i}：" + "证据细节" * 60} for i in range(8)
    ]
    checkpoint = _cp(history)

    async def boom(**kwargs):
        raise RuntimeError("no llm")

    monkeypatch.setattr(structured, "structured_completion", boom)
    info = run(compression.maybe_compress(sid, checkpoint, max_tokens_override=5, keep_recent=1))
    assert info["mode"] == "deterministic"
    assert info["removedMessages"] > 0
    assert info["afterTokens"] < info["beforeTokens"]
    assert checkpoint.history[0]["content"] == "SYSTEM-PROMPT"
    assert any("上下文压缩摘要" in m.get("content", "") for m in checkpoint.history)
    assert len(checkpoint.history) < len(history)


def test_llm_summary_path(monkeypatch):
    sid = sessions.create_session("compress-llm").id
    history = [{"role": "system", "content": "SYS"}] + [{"role": "user", "content": f"证据 {i}"} for i in range(10)]
    checkpoint = _cp(history)

    async def fake(**kwargs):
        assert kwargs["name"] == "context_compression"
        return {"summary": "已定位到内存限制过低", "key_facts": ["限制=512Mi"], "open_questions": ["是否需回滚"]}

    monkeypatch.setattr(structured, "structured_completion", fake)
    info = run(compression.maybe_compress(sid, checkpoint, max_tokens_override=5, keep_recent=2))
    assert info["mode"] == "llm"
    blob = "\n".join(m.get("content", "") for m in checkpoint.history)
    assert "已定位到内存限制过低" in blob and "限制=512Mi" in blob


def test_split_does_not_orphan_tool_messages(monkeypatch):
    sid = sessions.create_session("compress-tool").id
    history = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "排查"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "t1", "function": {"name": "k8s__list_pods"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "pods"},
        {"role": "user", "content": "继续"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "再查"},
        {"role": "assistant", "content": "done"},
    ]
    checkpoint = _cp(history)

    async def boom(**kwargs):
        raise RuntimeError("no llm")

    monkeypatch.setattr(structured, "structured_completion", boom)
    # 朴素切分点会落在 role=tool 上，护栏需要把 assistant(tool_calls) 一起带入最近窗口
    info = run(compression.maybe_compress(sid, checkpoint, max_tokens_override=5, keep_recent=5))
    assert info is not None
    after_summary = checkpoint.history[2:]
    assert after_summary and after_summary[0].get("role") != "tool"
    tool_msgs = [i for i, m in enumerate(checkpoint.history) if m.get("role") == "tool"]
    for index in tool_msgs:
        assert checkpoint.history[index - 1].get("tool_calls"), "tool 消息必须紧跟其 assistant tool_calls"
