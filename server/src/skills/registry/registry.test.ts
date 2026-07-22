import { describe, it, expect, beforeEach } from "vitest";
import { buildRegistry, recallTools, getAllRegisteredTools } from "./skillRegistry.js";
import { ALL_TOOLS } from "../../gateway/policy.js";

describe("Skill Registry RAG routing", () => {
  beforeEach(async () => {
    await buildRegistry(ALL_TOOLS);
  });

  it("builds registry with all registered tools", () => {
    const tools = getAllRegisteredTools();
    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map((t) => `${t.skill}.${t.name}`);
    expect(names).toContain("k8s.list_pods");
    expect(names).toContain("openstack.server_show");
  });

  it("recalls K8s tools for Kubernetes OOM query", async () => {
    const results = await recallTools("Pod OOMKilled CrashLoopBackOff 内存不足", { topK: 16 });
    const names = results.map((r) => `${r.tool.skill}.${r.tool.name}`);

    expect(names).toContain("k8s.describe_pod");
    expect(names).toContain("k8s.list_pods");
    expect(names).toContain("linux.get_memory_info");
    expect(names).toContain("elk.search_logs");

    // OpenStack 工具不应出现在 K8s 问题中
    expect(names).not.toContain("openstack.server_show");
    expect(names).not.toContain("openstack.hypervisor_list");
  });

  it("recalls OpenStack tools for Nova scheduling query", async () => {
    const results = await recallTools("OpenStack 虚机创建失败 NoValidHost nova scheduler", { topK: 16 });
    const names = results.map((r) => `${r.tool.skill}.${r.tool.name}`);

    expect(names).toContain("openstack.server_show");
    expect(names).toContain("openstack.hypervisor_list");
    expect(names).toContain("openstack.allocation_candidate_list");
    expect(names).toContain("openstack.nova_service_list");

    // K8s 变更工具不应出现在 OpenStack 问题中
    expect(names).not.toContain("k8s.patch_resource_limits");
  });

  it("recalls log tools for error timeline query", async () => {
    const results = await recallTools("order-api 最近报错时间线 错误日志", { topK: 16 });
    const names = results.map((r) => `${r.tool.skill}.${r.tool.name}`);

    expect(names).toContain("elk.search_logs");
    expect(names).toContain("elk.get_error_timeline");
    expect(names).toContain("clickhouse.search_logs");
  });

  it("always includes discovery tools", async () => {
    const results = await recallTools("随便看看", { topK: 5 });
    const names = results.map((r) => `${r.tool.skill}.${r.tool.name}`);

    expect(names).toContain("k8s.list_pods");
    expect(names).toContain("linux.get_cpu_usage");
  });

  it("returns scores between 0 and 1 for TF-IDF cosine", async () => {
    const results = await recallTools("k8s pod status", { topK: 5 });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
