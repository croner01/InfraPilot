"""LLM 客户端与流式响应收集 —— 对应 `server/src/llm/client.ts` + `stream.ts`。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from openai import AsyncOpenAI

from . import config_store
from .settings import LlmEnv


def _effective_config() -> tuple[str, str]:
    provider = config_store.get_default_llm_provider()
    if provider:
        api_key = (
            provider.get("apiKey")
            or __import__("os").environ.get(provider.get("apiKeyEnv") or "", "")
            or LlmEnv.api_key()
        )
        base_url = __import__("os").environ.get("OPENAI_BASE_URL") or provider.get("baseURL") or LlmEnv.base_url()
        return api_key, base_url
    return LlmEnv.api_key(), LlmEnv.base_url()


def get_client() -> AsyncOpenAI:
    """每次调用时按当前默认 Provider 构造客户端，支持 runtime 配置热更新。"""
    api_key, base_url = _effective_config()
    return AsyncOpenAI(api_key=api_key, base_url=base_url)


def reasoning_model() -> str:
    provider = config_store.get_default_llm_provider()
    if provider and provider.get("recommendedModel"):
        return provider["recommendedModel"]
    return LlmEnv.reasoning_model()


def fast_model() -> str:
    provider = config_store.get_default_llm_provider()
    if provider and provider.get("recommendedModel"):
        return provider["recommendedModel"]
    return LlmEnv.fast_model()


@dataclass
class CollectedCompletion:
    content: str = ""
    toolCalls: list[dict[str, Any]] = field(default_factory=list)
    streamed: bool = False
    promptTokens: int = 0
    completionTokens: int = 0
    totalTokens: int = 0


async def collect_streamed_completion(
    completion: Any,
    on_delta: Optional[Callable[[str], None]] = None,
) -> CollectedCompletion:
    """把 OpenAI 兼容的 stream:true 响应聚合为完整 content 与 tool_calls。

    兼容非流式响应（测试/降级场景）直接透传。
    """
    if completion is None or not hasattr(completion, "__aiter__"):
        choices = getattr(completion, "choices", None) or []
        message = getattr(choices[0], "message", None) if choices else None
        usage = getattr(completion, "usage", None)
        return CollectedCompletion(
            content=(getattr(message, "content", None) or "") if message else "",
            toolCalls=[_dump_tool_call(tc) for tc in (getattr(message, "tool_calls", None) or [])] if message else [],
            streamed=False,
            promptTokens=int(getattr(usage, "prompt_tokens", 0) or 0) if usage else 0,
            completionTokens=int(getattr(usage, "completion_tokens", 0) or 0) if usage else 0,
            totalTokens=int(getattr(usage, "total_tokens", 0) or 0) if usage else 0,
        )

    content = ""
    acc: dict[int, dict[str, str]] = {}
    usage: Any = None
    async for chunk in completion:
        # 开启 stream_options.include_usage 后，最后一个 chunk 携带 usage 且 choices 为空
        if getattr(chunk, "usage", None):
            usage = chunk.usage
        choices = getattr(chunk, "choices", None) or []
        if not choices:
            continue
        delta = getattr(choices[0], "delta", None)
        if delta is None:
            continue
        piece = getattr(delta, "content", None)
        if piece:
            content += piece
            if on_delta:
                on_delta(piece)
        for tc in getattr(delta, "tool_calls", None) or []:
            index = getattr(tc, "index", 0) or 0
            entry = acc.setdefault(index, {"id": "", "name": "", "args": ""})
            if getattr(tc, "id", None):
                entry["id"] = tc.id
            fn = getattr(tc, "function", None)
            if fn is not None:
                if getattr(fn, "name", None):
                    entry["name"] = fn.name
                if getattr(fn, "arguments", None):
                    entry["args"] += fn.arguments

    tool_calls = [
        {"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": t["args"]}}
        for _, t in sorted(acc.items())
    ]
    return CollectedCompletion(
        content=content,
        toolCalls=tool_calls,
        streamed=True,
        promptTokens=int(getattr(usage, "prompt_tokens", 0) or 0) if usage else 0,
        completionTokens=int(getattr(usage, "completion_tokens", 0) or 0) if usage else 0,
        totalTokens=int(getattr(usage, "total_tokens", 0) or 0) if usage else 0,
    )


def _dump_tool_call(tc: Any) -> dict[str, Any]:
    fn = getattr(tc, "function", None)
    return {
        "id": getattr(tc, "id", ""),
        "type": "function",
        "function": {
            "name": getattr(fn, "name", "") if fn else "",
            "arguments": getattr(fn, "arguments", "") if fn else "",
        },
    }
