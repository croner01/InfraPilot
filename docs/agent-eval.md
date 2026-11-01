# Agent 离线评测（agent-eval）

把真实故障会话固化为回归 case，每次改动 skill/prompt/工具后跑一遍，量化"结论方向是否正确、判别证据是否触达"。

## 运行

```bash
# 需要一个可访问且配置了 LLM key 的实例（本地 8787 或集群 NodePort）
cd py-server
python3 -m infrapilot.eval_run http://localhost:8787
python3 -m infrapilot.eval_run http://192.168.111.209:30080
```

全过 exit 0，任一失败 exit 1。每个 case 会新建会话并真实调用 Agent（消耗 LLM）。

## case schema

```json
{
  "id": "kafka-evicted-oom",
  "message": "分析 islap 命名空间下 kafka 无法启动的原因",
  "checks": [
    { "type": "hasTool", "skill": "k8s", "tool": "list_pods" },
    { "type": "rootCauseMatches", "regex": "Evicted|驱逐|OOM|内存|emptyDir|4Gi|页缓存" },
    { "type": "hypothesisStatus", "statementRegex": "emptyDir", "status": "confirmed" }
  ]
}
```

check 类型：
- `hasTool`: 会话内是否调用过某 skill.tool
- `rootCauseMatches`: 根因摘要是否命中正则
- `hypothesisStatus`: 是否存在某条假设（statement 命中正则）且状态为给定值

## 如何固化一次真实会话为 case

1. 在实例上完成一次诊断（或复现某次失败的会话），拿到会话 id。
2. 用人工/事后分析确定"金标准结论方向"与"必须触达的判别证据"。
3. 将 message + checks 写入 `py-server/infrapilot/eval_cases/<id>.json`（或用
   `INFRAPILOT_EVAL_CASES_DIR` 指向自有目录；也可用 `POST /api/eval/promote` 从真实会话一键回流）。
4. 先跑一次确认通过，再作为回归基线长期维护。

## 建议

- CI/每日回归：在测试环境起 server + mock LLM 后跑 `python3 -m infrapilot.eval_run`，技能改动自动触发。
- 新增"反向金标准"（如不允许断言"启动即失败"而忽略健康副本），可在 `py-server/infrapilot/eval.py`
  扩展 check 类型；`judgeScore` 类型的 LLM 评分见 `py-server/infrapilot/judge.py`。
