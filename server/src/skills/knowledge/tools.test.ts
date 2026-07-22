import { describe, it, expect, beforeEach } from "vitest";
import { executeKnowledgeTool, knowledgeTools } from "./tools.js";
import { resetKnowledgeStore } from "./store.js";
import { db } from "../../db/db.js";

function resetDbCases() {
  db.prepare("DELETE FROM incident_cases").run();
}

describe("Knowledge Skill", () => {
  beforeEach(() => {
    resetDbCases();
    resetKnowledgeStore();
  });

  it("exports three tools", () => {
    const names = knowledgeTools.map((t) => t.name);
    expect(names).toContain("search_similar_cases");
    expect(names).toContain("get_case");
    expect(names).toContain("add_case");
  });

  it("adds a case and returns its id", async () => {
    const res = await executeKnowledgeTool("add_case", {
      title: "Pod OOMKilled 案例",
      problem_type: "OOMKilled",
      severity: "p1",
      summary: "order-api pod 因内存不足反复 OOMKilled",
      root_causes: ["容器内存 limit 设置过低"],
      solutions: ["上调 memory limit", "开启 VPA"],
      service_name: "order-api",
      tags: ["k8s", "memory"],
    });

    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty("case_id");
    expect(typeof (res.data as any).case_id).toBe("string");
  });

  it("searches similar cases by semantic query", async () => {
    await executeKnowledgeTool("add_case", {
      title: "Pod OOMKilled 案例",
      problem_type: "OOMKilled",
      severity: "p1",
      summary: "order-api pod 因内存不足反复 OOMKilled",
      root_causes: ["容器内存 limit 设置过低"],
      solutions: ["上调 memory limit"],
      service_name: "order-api",
      tags: ["k8s"],
    });

    await executeKnowledgeTool("add_case", {
      title: "OpenStack NoValidHost 案例",
      problem_type: "NoValidHost",
      severity: "p1",
      summary: "创建虚机时 nova scheduler 找不到合适主机",
      root_causes: ["计算节点资源不足"],
      solutions: ["扩容计算节点"],
      service_name: "nova",
      tags: ["openstack"],
    });

    await executeKnowledgeTool("add_case", {
      title: "数据库磁盘满案例",
      problem_type: "DiskFull",
      severity: "p1",
      summary: "MySQL 数据目录磁盘使用率 100% 导致写入失败",
      root_causes: ["binlog 未清理"],
      solutions: ["清理 binlog", "扩容磁盘"],
      service_name: "mysql",
      tags: ["disk"],
    });

    const res = await executeKnowledgeTool("search_similar_cases", {
      query: "k8s pod 内存 OOMKilled crashloop order-api",
      limit: 5,
    });

    expect(res.success).toBe(true);
    const cases = res.data as Array<Record<string, unknown>>;
    expect(cases.length).toBeGreaterThan(0);

    const first = cases[0];
    expect(first.title).toContain("OOMKilled");

    const hostCase = cases.find((c) => (c.title as string).includes("NoValidHost"));
    expect(hostCase).toBeUndefined();
  });

  it("filters search by problem_type", async () => {
    await executeKnowledgeTool("add_case", {
      title: "OOM case A",
      problem_type: "OOMKilled",
      severity: "p2",
      summary: "oom",
      root_causes: ["memory"],
      solutions: ["fix"],
    });

    await executeKnowledgeTool("add_case", {
      title: "Disk case B",
      problem_type: "DiskFull",
      severity: "p2",
      summary: "disk full",
      root_causes: ["disk"],
      solutions: ["clean"],
    });

    const res = await executeKnowledgeTool("search_similar_cases", {
      query: "资源不足",
      problem_type: "DiskFull",
      limit: 5,
    });

    expect(res.success).toBe(true);
    const cases = res.data as Array<Record<string, unknown>>;
    expect(cases.every((c) => c.problem_type === "DiskFull")).toBe(true);
  });

  it("gets case by id", async () => {
    const add = await executeKnowledgeTool("add_case", {
      title: "Test case",
      problem_type: "Test",
      severity: "p3",
      summary: "summary",
      root_causes: ["rc"],
      solutions: ["sol"],
    });

    const caseId = (add.data as any).case_id;
    const get = await executeKnowledgeTool("get_case", { case_id: caseId });

    expect(get.success).toBe(true);
    expect((get.data as any).id).toBe(caseId);
  });

  it("returns error for unknown tool", async () => {
    const res = await executeKnowledgeTool("unknown_tool", {});
    expect(res.success).toBe(false);
    expect(res.error).toContain("未知 Knowledge 工具");
  });
});
