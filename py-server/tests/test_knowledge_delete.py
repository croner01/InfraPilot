"""知识库删除：删库的同时必须把案例从向量索引摘掉，否则搜索结果会残留已删案例。"""

from __future__ import annotations

from infrapilot import db, knowledge


def _add(title: str, summary: str, problem_type: str = "OOMKilled") -> dict:
    return knowledge.add_knowledge_case(
        {
            "title": title,
            "problemType": problem_type,
            "severity": "p2",
            "summary": summary,
            "rootCauses": ["容器内存 limit 过低"],
            "solutions": ["上调 memory limit"],
            "tags": ["auto_persisted"],
        }
    )


def test_delete_case_removes_it_from_list_and_search():
    case = _add("Pod OOMKilled 案例", "order-api 因内存不足反复 OOMKilled")
    assert knowledge.get_knowledge_case(case["id"]) is not None
    assert any(c["id"] == case["id"] for c in knowledge.search_knowledge_cases("pod 内存 OOMKilled", limit=10))

    assert knowledge.delete_knowledge_case(case["id"]) is True
    assert knowledge.get_knowledge_case(case["id"]) is None
    assert not any(c["id"] == case["id"] for c in knowledge.list_knowledge_cases())
    # 索引未摘掉的话这里仍会命中已删案例
    assert not any(c["id"] == case["id"] for c in knowledge.search_knowledge_cases("pod 内存 OOMKilled", limit=10))


def test_delete_unknown_case_returns_false():
    assert knowledge.delete_knowledge_case("does-not-exist") is False
    assert db.delete_case("does-not-exist") is False


def test_delete_keeps_other_cases_intact():
    keep = _add("磁盘写满案例", "MySQL 数据目录磁盘写满", problem_type="DiskFull")
    drop = _add("网络丢包案例", "节点间 UDP 丢包", problem_type="NetworkLoss")

    assert knowledge.delete_knowledge_case(drop["id"]) is True
    remaining = [c["id"] for c in knowledge.list_knowledge_cases()]
    assert keep["id"] in remaining and drop["id"] not in remaining
