"""P2 结构化输出：schema 校验 / JSON 抽取 / 调用降级链（LLM 打桩）。"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from infrapilot import llm, structured


def run(coro):
    return asyncio.run(coro)


def _text(content: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class _Completions:
    def __init__(self, results):
        self._results = results
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        result = self._results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class _Client:
    def __init__(self, results):
        self.chat = SimpleNamespace(completions=_Completions(results))


# -------------------- 校验器 / 抽取 --------------------


def test_validate_schema_subset():
    schema = structured.JUDGE_SCHEMA
    valid = {"score": 0.8, "verdict": "pass", "rationale": "ok"}
    assert structured.validate(valid, schema) == []
    assert structured.validate({"score": 1.5, "verdict": "pass", "rationale": ""}, schema)
    assert structured.validate({"score": 0.8, "verdict": "maybe", "rationale": ""}, schema)
    assert structured.validate({"score": 0.8, "verdict": "pass"}, schema)
    assert structured.validate({"score": 0.8, "verdict": "pass", "rationale": "", "x": 1}, schema)


def test_extract_json_handles_fences_and_prose():
    assert structured.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert structured.extract_json('结论如下：{"a": {"b": [1, 2]}} 完毕') == {"a": {"b": [1, 2]}}
    assert structured.extract_json("前缀 [{}, {}] 后缀") == [{}, {}]
    assert structured.extract_json('{"text": "含 } 右括号"}') == {"text": "含 } 右括号"}
    assert structured.extract_json("没有 JSON") is None


def test_parse_conclusion_requires_valid_schema():
    good = json.dumps({"summary": "根因X", "confidence": 0.8, "evidence_points": [], "remediation": ""})
    assert structured.parse_conclusion(good)["summary"] == "根因X"
    bad = json.dumps({"summary": "根因X"})
    assert structured.parse_conclusion(bad) is None
    assert structured.parse_conclusion("【根因分析结论】自由文本") is None


def test_build_response_format():
    fmt = structured.build_response_format("root_cause", structured.RCA_SCHEMA)
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["name"] == "root_cause"


# -------------------- 调用与降级 --------------------


def test_structured_completion_prefers_json_schema(monkeypatch):
    payload = {"score": 0.7, "verdict": "pass", "rationale": "fine"}
    client = _Client([_text(json.dumps(payload))])
    monkeypatch.setattr(llm, "get_client", lambda: client)
    result = run(structured.structured_completion(name="judge", schema=structured.JUDGE_SCHEMA, user="x"))
    assert result == payload
    assert len(client.chat.completions.calls) == 1
    assert client.chat.completions.calls[0]["response_format"]["type"] == "json_schema"


def test_structured_completion_degrades_then_succeeds(monkeypatch):
    payload = {"score": 0.5, "verdict": "fail", "rationale": "weak"}
    client = _Client([RuntimeError("json_schema unsupported"), RuntimeError("json_object unsupported"), _text(f"```json\n{json.dumps(payload)}\n```")])
    monkeypatch.setattr(llm, "get_client", lambda: client)
    result = run(structured.structured_completion(name="judge", schema=structured.JUDGE_SCHEMA, user="x"))
    assert result == payload
    calls = client.chat.completions.calls
    assert len(calls) == 3
    assert "response_format" not in calls[2]


def test_structured_completion_retries_on_schema_violation(monkeypatch):
    bad = {"score": 2.0, "verdict": "pass", "rationale": "x"}
    good = {"score": 0.9, "verdict": "pass", "rationale": "y"}
    client = _Client([_text(json.dumps(bad)), _text(json.dumps(good))])
    monkeypatch.setattr(llm, "get_client", lambda: client)
    assert run(structured.structured_completion(name="judge", schema=structured.JUDGE_SCHEMA, user="x")) == good
    assert len(client.chat.completions.calls) == 2


def test_structured_completion_raises_after_all_attempts(monkeypatch):
    client = _Client([RuntimeError("a"), _text("no json here"), _text("still nothing")])
    monkeypatch.setattr(llm, "get_client", lambda: client)
    with pytest.raises(structured.StructuredOutputError):
        run(structured.structured_completion(name="judge", schema=structured.JUDGE_SCHEMA, user="x"))


# -------------------- runner 集成 --------------------


def test_runner_applies_structured_conclusion(monkeypatch):
    from infrapilot import runner, sessions
    from infrapilot.models import AgentCheckpoint

    payload = json.dumps(
        {
            "summary": "容器内存限制过低导致 OOMKilled",
            "confidence": 0.88,
            "evidence_points": ["pod OOMKilled x5"],
            "alternative_hypotheses": ["节点内存不足"],
            "remediation": "把 limit 调到 1Gi",
        }
    )
    client = _Client([_text(payload)])
    monkeypatch.setattr(llm, "get_client", lambda: client)
    monkeypatch.setenv("INFRAPILOT_STRUCTURED_RCA", "1")

    session = sessions.create_session("结构化结论集成")
    checkpoint = AgentCheckpoint(sessionId=session.id, history=[{"role": "user", "content": "排查"}])
    run(runner._conclude_from_existing_evidence(session.id, session, checkpoint))

    updated = sessions.get_session(session.id)
    assert updated.status == "concluded"
    assert updated.rootCause.confidence == 0.88
    assert "OOMKilled" in updated.rootCause.summary
    assert updated.rootCause.alternativeHypotheses == ["节点内存不足"]
    assert updated.remediation.summary == "把 limit 调到 1Gi"


def test_runner_falls_back_to_text_conclusion(monkeypatch):
    from infrapilot import runner, sessions
    from infrapilot.models import AgentCheckpoint

    client = _Client([_text("【根因分析结论】\n磁盘写满，置信度 0.7")])
    monkeypatch.setattr(llm, "get_client", lambda: client)
    monkeypatch.setenv("INFRAPILOT_STRUCTURED_RCA", "1")

    session = sessions.create_session("文本结论回退")
    checkpoint = AgentCheckpoint(sessionId=session.id, history=[{"role": "user", "content": "排查"}])
    run(runner._conclude_from_existing_evidence(session.id, session, checkpoint))

    updated = sessions.get_session(session.id)
    assert updated.status == "concluded"
    assert "磁盘写满" in updated.rootCause.summary
