"""Knowledge Skill —— 对应 `server/src/skills/knowledge/tools.ts`。

历史案例库 / SOP 检索与沉淀：search_similar_cases / get_case / add_case。
存储层复用 `infrapilot.knowledge`（对应 `skills/knowledge/store.ts`）。
"""

from __future__ import annotations

import time
from typing import Any

from .. import knowledge as store
from ..models import ToolDef, ToolExecutionResult

TOOLS: list[ToolDef] = [
    ToolDef(
        name="search_similar_cases",
        skill="knowledge",
        risk="readonly",
        description="根据故障描述语义检索历史相似 incident 案例，返回案例的标题、根因、解决方案和相似度分数。用于在诊断前或诊断中参考历史经验。",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "故障描述、日志片段或用户问题，用于语义检索"},
                "problem_type": {"type": "string", "description": "可选，按问题类型过滤，例如 OOMKilled / NoValidHost / 网络不通"},
                "service_name": {"type": "string", "description": "可选，按关联服务/组件过滤"},
                "limit": {"type": "number", "description": "返回案例数量，默认 5"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    ),
    ToolDef(
        name="get_case",
        skill="knowledge",
        risk="readonly",
        description="根据 case_id 获取知识库中某个历史案例的完整信息。",
        parameters={
            "type": "object",
            "properties": {"case_id": {"type": "string", "description": "知识库案例 UUID"}},
            "required": ["case_id"],
            "additionalProperties": False,
        },
    ),
    ToolDef(
        name="add_case",
        skill="knowledge",
        risk="medium",
        description="将当前故障及其根因、解决方案沉淀到知识库，供未来相似故障检索参考。写入操作，影响可控。",
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "案例标题"},
                "problem_type": {"type": "string", "description": "问题类型，例如 OOMKilled / NoValidHost"},
                "severity": {"type": "string", "enum": ["p0", "p1", "p2", "p3"], "description": "严重级别"},
                "summary": {"type": "string", "description": "问题现象摘要"},
                "root_causes": {"type": "array", "items": {"type": "string"}, "description": "根因列表"},
                "solutions": {"type": "array", "items": {"type": "string"}, "description": "解决方案/SOP 步骤列表"},
                "service_name": {"type": "string", "description": "关联服务/组件"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"},
            },
            "required": ["title", "problem_type", "severity", "summary", "root_causes", "solutions"],
            "additionalProperties": False,
        },
    ),
]


async def execute(tool: str, args: dict[str, Any]) -> ToolExecutionResult:
    started = time.time()
    try:
        if tool == "search_similar_cases":
            results = store.search_knowledge_cases(
                str(args.get("query") or ""),
                problem_type=str(args["problem_type"]) if args.get("problem_type") else None,
                service_name=str(args["service_name"]) if args.get("service_name") else None,
                limit=args["limit"] if isinstance(args.get("limit"), int) else 5,
            )
            data = [
                {
                    "case_id": r["id"],
                    "title": r["title"],
                    "problem_type": r.get("problemType"),
                    "severity": r.get("severity"),
                    "summary": r.get("summary"),
                    "root_causes": r.get("rootCauses"),
                    "solutions": r.get("solutions"),
                    "service_name": r.get("serviceName"),
                    "tags": r.get("tags"),
                    "similarity": r.get("score"),
                }
                for r in results
            ]
            return ToolExecutionResult(success=True, data=data, durationMs=_ms(started))

        if tool == "get_case":
            case = store.get_knowledge_case(str(args.get("case_id") or ""))
            if not case:
                return ToolExecutionResult(success=False, error=f"未找到案例: {args.get('case_id')}", durationMs=_ms(started))
            return ToolExecutionResult(success=True, data=case, durationMs=_ms(started))

        if tool == "add_case":
            payload = {
                "title": str(args.get("title") or ""),
                "problemType": str(args.get("problem_type") or ""),
                "severity": args.get("severity"),
                "summary": str(args.get("summary") or ""),
                "rootCauses": [str(x) for x in args["root_causes"]] if isinstance(args.get("root_causes"), list) else [],
                "solutions": [str(x) for x in args["solutions"]] if isinstance(args.get("solutions"), list) else [],
                "serviceName": str(args["service_name"]) if args.get("service_name") else None,
                "tags": [str(x) for x in args["tags"]] if isinstance(args.get("tags"), list) else None,
            }
            case = store.add_knowledge_case(payload)
            return ToolExecutionResult(
                success=True,
                data={"case_id": case["id"], "title": case["title"], "created_at": case["createdAt"]},
                durationMs=_ms(started),
            )

        return ToolExecutionResult(success=False, error=f"未知 Knowledge 工具: {tool}", durationMs=0)
    except Exception as err:  # noqa: BLE001
        return ToolExecutionResult(success=False, error=str(err), durationMs=_ms(started))


def _ms(started: float) -> int:
    return int((time.time() - started) * 1000)
