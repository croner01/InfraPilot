import { describe, it, expect } from "vitest";
import { extractPlan, extractRemediation, extractHypotheses, extractRca } from "./plan.js";

describe("extractPlan", () => {
  it("returns empty when no plan marker", () => {
    expect(extractPlan("直接回答")).toEqual([]);
  });

  it("extracts numbered steps from plan block", () => {
    const text = "【诊断计划】\n1. 查看 Pod 状态\n2. 检索错误日志\n然后开始排查";
    expect(extractPlan(text)).toEqual(["查看 Pod 状态", "检索错误日志"]);
  });

  it("extracts bullet steps and stops at next marker", () => {
    const text = "【诊断计划】\n- 查看 Pod\n- 检索日志\n【根因分析结论】内存不足";
    expect(extractPlan(text)).toEqual(["查看 Pod", "检索日志"]);
  });

  it("deduplicates repeated steps", () => {
    expect(extractPlan("【诊断计划】\n1. 查看 Pod\n1. 查看 Pod")).toEqual(["查看 Pod"]);
  });
});

describe("extractRemediation", () => {
  it("returns null without marker", () => {
    expect(extractRemediation("无方案")).toBeNull();
  });

  it("parses steps with tool name", () => {
    const text =
      "【修复方案】\n1. 调整内存 limit: k8s.patch_resource_limits(namespace=order-service, deployment_name=order-api, container_name=order-api, memory_limit_mi=512)";
    const r = extractRemediation(text);
    expect(r?.steps).toHaveLength(1);
    expect(r?.steps[0].skill).toBe("k8s");
    expect(r?.steps[0].tool).toBe("patch_resource_limits");
  });

  it("parses plain steps without tool", () => {
    const r = extractRemediation("【修复方案】\n1. 重启服务");
    expect(r?.steps[0].skill).toBeUndefined();
    expect(r?.steps[0].tool).toBeUndefined();
  });

  it("returns null when block has no steps", () => {
    expect(extractRemediation("【修复方案】\n摘要: 无")).toBeNull();
  });
});

describe("extractHypotheses", () => {
  it("parses hypothesis list with statuses", () => {
    const text = [
      "【假设列表】",
      "- [active] 内存 limit 不足导致 OOM",
      "- [ruled_out] 节点资源不足",
    ].join("\n");
    expect(extractHypotheses(text)).toEqual([
      { statement: "内存 limit 不足导致 OOM", status: "active" },
      { statement: "节点资源不足", status: "ruled_out" },
    ]);
  });

  it("returns empty when no marker", () => {
    expect(extractHypotheses("无假设")).toEqual([]);
  });

  it("stops at the next marker", () => {
    const text = "【假设列表】\n- [active] A\n【根因分析结论】\nxxx";
    expect(extractHypotheses(text)).toEqual([{ statement: "A", status: "active" }]);
  });
});

describe("extractRca", () => {
  it("extracts conclusion until the next structured marker", () => {
    const text = [
      "【根因分析结论】",
      "**根因摘要**：内存 limit 过小",
      "- 置信度 0.9",
      "【修复方案】",
      "1. 调整 limit",
    ].join("\n");
    expect(extractRca(text)).toBe("**根因摘要**：内存 limit 过小\n- 置信度 0.9");
  });

  it("returns empty when no marker", () => {
    expect(extractRca("无结论")).toBe("");
  });
});
