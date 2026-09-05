# Agent 工具输出规范

工具结果会原样作为文本回喂 LLM 上下文，因此输出必须为模型设计，而不是为人类展示设计。

## 硬性规则

1. **汇总计数放最前**：任何列表类工具返回对象的第一组字段应是 summary（total/running/abnormal…或 countBy 聚合）。
2. **大列表必须截断并声明**：样本超限时只给代表性样本（默认 ≤15），并带 `truncated: true`；绝不原样倾倒。
3. **判别字段显式化**：Evicted / Error / OOMKilled / CrashLoopBackOff / ContainerStatusUnknown 必须用不同字段或状态值区分，禁止归并为 "Failed"。
4. **"查不到"必须说查不到**：索引缺失、日志不可取、exec 超时、metrics 不可达——返回 `success:false + error` 或 `success:true + note:"不可用原因"`，禁止空成功让模型误读为"没有数据"。
5. **输出只给模型需要消费的字段**，能聚合不逐条、能省略不保留；敏感值（env/secret）绝不返回。

## 已知静默空点清单（逐一核对后移除或标注）

- elk search_logs / aggregate / timeline：索引不存在 → 必须带 note（Task 2 修复）
- k8s terminated 容器日志（docker 运行时）：kubectl logs 不可取 → 显式 error
- k8s exec：超时/被拒 → success:false
- metrics API 不可达：top_pods/top_nodes → success:false
- clickhouse 空窗口：返回空数组即可，但须与"查询失败"区分（失败必须 error）

## 自查清单（写工具时过一遍）

- [ ] summary 在最前？
- [ ] 截断带 truncated？
- [ ] 空结果带原因 note/error？
- [ ] 判别状态不混并？
- [ ] 无敏感字段泄漏？
