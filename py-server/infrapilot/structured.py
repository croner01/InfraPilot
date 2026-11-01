"""结构化输出（P2）—— JSON Schema 约束的 LLM 调用。

对应差距分析 §3 #12「结构化输出（JSON Schema 约束）」。Node 版依赖自由文本 + 正则解析；
Python 版提供：
- `structured_completion()`：优先用 OpenAI `response_format=json_schema`（strict），
  失败时降级到 `json_object` + prompt 内嵌 schema，再失败则纯文本 + JSON 抽取；
- 轻量 JSON Schema 校验器（type/required/properties/items/enum/min/max/array），
  不引入 `jsonschema` 依赖；
- 供 judge / 上下文压缩 / 评测 / 结论抽取复用的 schema。

设计原则：**任何降级都不能中断主链路**，最坏情况下返回 `None` 并由调用方走原有正则路径。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from . import llm


class StructuredOutputError(RuntimeError):
    """结构化输出在三次尝试后仍不可用。"""


# -------------------- JSON Schema 定义 --------------------

RCA_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "confidence", "evidence_points", "remediation"],
    "properties": {
        "summary": {"type": "string", "description": "一句话根因摘要（中文）"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidence_points": {"type": "array", "items": {"type": "string"}},
        "alternative_hypotheses": {"type": "array", "items": {"type": "string"}},
        "remediation": {"type": "string"},
    },
}

COMPRESSION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "key_facts"],
    "properties": {
        "summary": {"type": "string", "description": "被压缩历史的中文摘要，保留故障现象/关键证据/已排除假设/当前进展"},
        "key_facts": {"type": "array", "items": {"type": "string"}},
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
}

JUDGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["score", "verdict", "rationale"],
    "properties": {
        "score": {"type": "number", "minimum": 0, "maximum": 1},
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "rationale": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "weaknesses": {"type": "array", "items": {"type": "string"}},
        "hallucination_risk": {"type": "number", "minimum": 0, "maximum": 1},
    },
}

EVAL_CASE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "message", "checks"],
    "properties": {
        "id": {"type": "string"},
        "message": {"type": "string"},
        "checks": {"type": "array", "items": {"type": "object"}},
    },
}


# -------------------- 轻量校验器 --------------------


def _type_ok(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def validate(instance: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """返回错误列表（空列表表示通过）。仅覆盖本项目用到的 schema 子集。"""
    errors: list[str] = []
    expected = schema.get("type")
    if expected:
        allowed = expected if isinstance(expected, list) else [expected]
        if not any(_type_ok(instance, t) for t in allowed):
            return [f"{path}: 期望 {allowed}，实际 {type(instance).__name__}"]
    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}.{key}: 缺少必填字段")
        properties = schema.get("properties") or {}
        for key, value in instance.items():
            if key in properties:
                errors.extend(validate(value, properties[key], f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{key}: 不允许的额外字段")
        if schema.get("additionalProperties") is True and not properties:
            return errors
    elif isinstance(instance, list):
        items = schema.get("items")
        if isinstance(items, dict):
            for index, item in enumerate(instance):
                errors.extend(validate(item, items, f"{path}[{index}]"))
    elif isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: 小于最小值 {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: 大于最大值 {schema['maximum']}")
    elif isinstance(instance, str):
        if "enum" in schema and instance not in schema["enum"]:
            errors.append(f"{path}: 不在枚举 {schema['enum']} 中")
    return errors


def is_valid(instance: Any, schema: dict[str, Any]) -> bool:
    return not validate(instance, schema)


# -------------------- JSON 抽取 --------------------


def extract_json(text: str) -> Optional[Any]:
    """从自由文本中抽取第一个平衡的 JSON 对象/数组（容忍 ```json 代码块与前后说明）。"""
    if not text:
        return None
    candidates: list[str] = []
    fenced = re.findall(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    candidates.extend(block.strip() for block in fenced)
    candidates.append(text.strip())
    for candidate in candidates:
        direct = _try_load(candidate)
        if direct is not None:
            return direct
        starts = sorted(i for i in (candidate.find("{"), candidate.find("[")) if i >= 0)
        for start in starts:
            snippet = _balanced(candidate, start)
            if snippet is None:
                continue
            parsed = _try_load(snippet)
            if parsed is not None:
                return parsed
    return None


def _try_load(text: str) -> Optional[Any]:
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _balanced(text: str, start: int) -> Optional[str]:
    opener = text[start]
    closer = "}" if opener == "{" else "]"
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


# -------------------- 调用 --------------------


def build_response_format(name: str, schema: dict[str, Any], *, strict: bool = True) -> dict[str, Any]:
    return {"type": "json_schema", "json_schema": {"name": name, "schema": schema, "strict": strict}}


async def structured_completion(
    *,
    name: str,
    schema: dict[str, Any],
    system: Optional[str] = None,
    user: Optional[str] = None,
    messages: Optional[list[dict[str, Any]]] = None,
    model: Optional[str] = None,
    temperature: float = 0.0,
    call_type: str = "structured",
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    """返回通过 schema 校验的 dict；全部降级失败时抛 StructuredOutputError。"""
    history: list[dict[str, Any]] = list(messages or [])
    if system:
        history.insert(0, {"role": "system", "content": system})
    if user:
        history.append({"role": "user", "content": user})
    if not history:
        raise StructuredOutputError("structured_completion 需要 messages/system+user")

    _model = model or llm.fast_model()
    client = llm.get_client()
    attempts: list[dict[str, Any]] = [
        {"response_format": build_response_format(name, schema)},
        {
            "response_format": {"type": "json_object"},
            "messages": history
            + [
                {
                    "role": "system",
                    "content": "只输出 JSON，且必须满足以下 JSON Schema：\n" + json.dumps(schema, ensure_ascii=False),
                }
            ],
        },
        {"messages": history},
    ]
    last_error: Optional[str] = None
    for index, extra in enumerate(attempts):
        payload = dict(extra)
        call_messages = payload.pop("messages", history)
        try:
            completion = await client.chat.completions.create(
                model=_model,
                messages=call_messages,
                temperature=temperature,
                **payload,
            )
        except Exception as err:  # noqa: BLE001 - 逐级降级，不能中断主链路
            last_error = f"attempt{index + 1}: {err}"
            continue
        content = _content_of(completion)
        parsed = extract_json(content or "")
        if parsed is None:
            last_error = f"attempt{index + 1}: 响应不是合法 JSON"
            continue
        errors = validate(parsed, schema)
        if errors:
            last_error = f"attempt{index + 1}: schema 校验失败 {errors[:3]}"
            continue
        _record(session_id, _model, completion, call_type)
        return parsed

    raise StructuredOutputError(last_error or "结构化输出失败")


def _content_of(completion: Any) -> Optional[str]:
    choices = getattr(completion, "choices", None) or []
    if not choices:
        return None
    return getattr(getattr(choices[0], "message", None), "content", None)


def _record(session_id: Optional[str], model: str, completion: Any, call_type: str) -> None:
    if not session_id:
        return
    try:
        from . import usage

        u = getattr(completion, "usage", None)
        usage.record_llm_call(
            session_id=session_id,
            model=model,
            prompt_tokens=int(getattr(u, "prompt_tokens", 0) or 0) if u else 0,
            completion_tokens=int(getattr(u, "completion_tokens", 0) or 0) if u else 0,
            latency_ms=0,
            call_type=call_type,
        )
    except Exception:  # noqa: BLE001 - 统计失败不得影响结果
        pass


# -------------------- 结论抽取（供 runner 复用） --------------------


def parse_conclusion(content: str) -> Optional[dict[str, Any]]:
    """从模型输出中解析符合 RCA_SCHEMA 的结论 JSON（纯函数，无需 LLM）。"""
    parsed = extract_json(content or "")
    if isinstance(parsed, dict) and is_valid(parsed, RCA_SCHEMA):
        return parsed
    return None


_CONCLUSION_SYSTEM = """你是 SRE 根因分析结构化抽取器。把给定的诊断文本提炼为 JSON：
- summary: 一句话根因摘要；
- confidence: 0~1 的数字；
- evidence_points: 支撑该结论的证据要点（字符串数组，可为空）；
- alternative_hypotheses: 已排除或未排除的替代解释（字符串数组，可为空）；
- remediation: 修复建议（无则空字符串）。
不要编造文本中不存在的证据。"""


async def refine_root_cause(text: str, *, session_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    """用 JSON Schema 约束把自由文本结论抽取为结构化根因（失败返回 None）。"""
    if not (text or "").strip():
        return None
    try:
        return await structured_completion(
            name="root_cause",
            schema=RCA_SCHEMA,
            system=_CONCLUSION_SYSTEM,
            user=text,
            session_id=session_id,
            call_type="conclusion_structured",
        )
    except Exception:  # noqa: BLE001 - 结构化失败时由调用方回退到正则解析
        return None
