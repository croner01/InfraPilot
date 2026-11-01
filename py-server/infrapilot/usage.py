"""Token 用量 / 成本统计（P0）—— 对应设计文档差距分析 §4。

Node 版尚未捕获 `response.usage`；Python 版在 runner 的每次 LLM 调用后落库
`llm_calls`，并提供 `GET /api/usage/summary` 供前端用量页直接替换 MOCK 数据。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import config_store, db
from .util import new_id, now_iso

# 默认模型单价（¥ / 1M tokens），与前端 UsagePage 的 MODEL_PRICES 对齐
DEFAULT_MODEL_PRICES: list[dict[str, Any]] = [
    {"model": "deepseek-v4-flash", "inputPerM": 1.0, "outputPerM": 4.0},
    {"model": "deepseek-v4-pro", "inputPerM": 4.0, "outputPerM": 16.0},
    {"model": "glm-5.3", "inputPerM": 2.0, "outputPerM": 8.0},
    {"model": "qwen3-max", "inputPerM": 1.6, "outputPerM": 6.4},
    {"model": "gpt-4o", "inputPerM": 18.0, "outputPerM": 72.0},
]


def get_model_prices() -> list[dict[str, Any]]:
    runtime = config_store.get_list("modelPrices")
    return runtime if runtime else [dict(p) for p in DEFAULT_MODEL_PRICES]


def set_model_prices(prices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def _mutate(cfg: dict[str, Any]) -> None:
        cfg["modelPrices"] = prices

    config_store.update_raw(_mutate)
    return get_model_prices()


def price_for(model: str) -> dict[str, Any]:
    prices = get_model_prices()
    return next((p for p in prices if p.get("model") == model), None) or prices[0]


def cost_of(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    price = price_for(model)
    return round(
        (prompt_tokens / 1_000_000) * float(price.get("inputPerM") or 0)
        + (completion_tokens / 1_000_000) * float(price.get("outputPerM") or 0),
        6,
    )


def current_provider_id() -> Optional[str]:
    provider = config_store.get_default_llm_provider()
    return provider.get("id") if provider else None


def record_llm_call(
    *,
    session_id: Optional[str],
    model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    latency_ms: int = 0,
    call_type: str = "agent",
    provider_id: Optional[str] = None,
) -> dict[str, Any]:
    row = {
        "id": new_id(),
        "session_id": session_id,
        "provider_id": provider_id if provider_id is not None else current_provider_id(),
        "model": model,
        "call_type": call_type,
        "prompt_tokens": int(prompt_tokens or 0),
        "completion_tokens": int(completion_tokens or 0),
        "total_tokens": int(prompt_tokens or 0) + int(completion_tokens or 0),
        "latency_ms": int(latency_ms or 0),
        "cost": cost_of(model, int(prompt_tokens or 0), int(completion_tokens or 0)),
        "created_at": now_iso(),
    }
    db.insert_llm_call(row)
    return row


def _day_key(iso: str) -> str:
    return iso[:10]


def _percentile(values: list[int], pct: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((pct / 100) * (len(ordered) - 1)))))
    return int(ordered[index])


def summarize(days: int = 14, session_limit: int = 20) -> dict[str, Any]:
    """聚合最近 N 天的用量；返回结构与前端 UsagePage 的 MOCK 变量同构。"""
    calls = db.list_llm_calls(limit=5000)
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=max(days, 1) - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    recent = [c for c in calls if c["created_at"] >= cutoff.strftime("%Y-%m-%dT%H:%M:%S")]

    # 按天序列
    buckets: dict[str, dict[str, int]] = {}
    for offset in range(max(days, 1)):
        day = (cutoff + timedelta(days=offset)).strftime("%m-%d")
        buckets[day] = {"prompt": 0, "completion": 0}
    for call in recent:
        day = _day_key(call["created_at"])[5:]
        if day in buckets:
            buckets[day]["prompt"] += int(call["prompt_tokens"])
            buckets[day]["completion"] += int(call["completion_tokens"])
    series = [{"date": day, "prompt": v["prompt"], "completion": v["completion"]} for day, v in buckets.items()]

    # 按模型分布
    model_map: dict[str, dict[str, Any]] = {}
    for call in calls:
        entry = model_map.setdefault(call["model"], {"model": call["model"], "tokens": 0, "calls": 0})
        entry["tokens"] += int(call["total_tokens"])
        entry["calls"] += 1
    models = sorted(model_map.values(), key=lambda m: m["tokens"], reverse=True)

    # 按会话聚合
    session_map: dict[str, dict[str, Any]] = {}
    latencies: dict[str, list[int]] = {}
    for call in calls:
        sid = call.get("session_id")
        if not sid:
            continue
        entry = session_map.setdefault(
            sid,
            {"id": sid, "title": "", "model": call["model"], "calls": 0, "promptTokens": 0, "completionTokens": 0},
        )
        entry["model"] = call["model"]
        entry["calls"] += 1
        entry["promptTokens"] += int(call["prompt_tokens"])
        entry["completionTokens"] += int(call["completion_tokens"])
        latencies.setdefault(sid, []).append(int(call["latency_ms"]))
    for sid, entry in session_map.items():
        row = db.query_one("SELECT title FROM sessions WHERE id = ?", (sid,))
        entry["title"] = row["title"] if row else sid
        entry["latencyP50"] = _percentile(latencies.get(sid, []), 50)
    sessions = sorted(session_map.values(), key=lambda s: s["promptTokens"] + s["completionTokens"], reverse=True)[
        :session_limit
    ]

    prompt_total = sum(int(c["prompt_tokens"]) for c in calls)
    completion_total = sum(int(c["completion_tokens"]) for c in calls)
    cost_total = round(sum(float(c["cost"]) for c in calls), 4)
    call_count = len(calls)
    weighted_latency = sum(int(c["latency_ms"]) for c in calls)
    totals = {
        "prompt": prompt_total,
        "completion": completion_total,
        "total": prompt_total + completion_total,
        "calls": call_count,
        "cost": cost_total,
        "avgLatency": int(weighted_latency / call_count) if call_count else 0,
    }

    return {
        "totals": totals,
        "series": series,
        "sessions": sessions,
        "models": models,
        "prices": get_model_prices(),
        "range": {"days": days},
    }
