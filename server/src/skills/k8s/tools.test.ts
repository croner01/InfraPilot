import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  deletePod: vi.fn(),
  execPodCommand: vi.fn(),
  getDeployment: vi.fn(),
  isAbnormalPod: vi.fn(),
  listEventsForPod: vi.fn(),
  listPods: vi.fn(),
  patchDeploymentMemoryLimit: vi.fn(),
  readPod: vi.fn(),
  topPods: vi.fn(),
  topNodes: vi.fn(),
  getNode: vi.fn(),
}));

import { executeK8sTool } from "./tools.js";
import { deletePod, execPodCommand, getDeployment, getNode, isAbnormalPod, listPods, topNodes, topPods } from "./client.js";

const healthy = { name: "kafka-x", namespace: "islap", status: "Running", restartCount: 0, ready: true, startedAt: "2026-08-29T11:50:33Z" };
const errored = { name: "kafka-y", namespace: "islap", status: "Error", restartCount: 0, ready: false, startedAt: "2026-08-24T19:28:00Z" };
const restarting = { name: "kafka-z", namespace: "islap", status: "Running", restartCount: 3, ready: false, startedAt: "2026-08-30T01:00:00Z" };

describe("executeK8sTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAbnormalPod).mockImplementation((p: { status: string; restartCount: number }) => p.status !== "Running" || p.restartCount > 0);
  });

  it("list_pods returns summary with running list and abnormal samples", async () => {
    const evicted = { name: "kafka-e", namespace: "islap", status: "Evicted", reason: "Evicted", restartCount: 0, ready: false, startedAt: "2026-08-20T01:00:00Z" };
    vi.mocked(listPods).mockResolvedValue([healthy, errored, restarting, evicted] as never);
    const res = await executeK8sTool("list_pods", {});
    expect(res.success).toBe(true);
    const data = res.data as {
      summary: { total: number; running: number; abnormal: number; byReason: Record<string, number>; byNode: Record<string, { total: number; running: number; abnormal: number; restarts: number }> };
      running: Array<{ name: string }>;
      pods: Array<{ name: string }>;
    };
    expect(data.summary).toMatchObject({ total: 4, running: 1, abnormal: 3 });
    expect(data.summary.byReason).toMatchObject({ Error: 1, Evicted: 1, Running: 1 });
    expect(data.summary.byNode).toMatchObject({ 未调度: { total: 4, running: 1, abnormal: 3 } });
    expect(data.running.map((p) => p.name)).toEqual(["kafka-x"]);
    expect(data.pods).toHaveLength(3);
  });

  it("list_pods caps abnormal samples and marks truncation", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `pod-${i}`,
      namespace: "islap",
      status: "Evicted",
      reason: "Evicted",
      restartCount: 0,
      ready: false,
      startedAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T01:00:00Z`,
    }));
    vi.mocked(listPods).mockResolvedValue([healthy, ...many] as never);
    const res = await executeK8sTool("list_pods", { all: true });
    const data = res.data as { summary: { abnormal: number; byReason: Record<string, number> }; pods: unknown[]; truncated: boolean };
    expect(data.summary.abnormal).toBe(20);
    expect(data.summary.byReason).toMatchObject({ Evicted: 20 });
    expect(data.pods).toHaveLength(15);
    expect(data.truncated).toBe(true);
  });

  it("top_pods returns usage rows", async () => {
    vi.mocked(topPods).mockResolvedValue([
      { name: "kafka-x", namespace: "islap", cpuCores: 0.038, memoryBytes: 4293918720, memoryLimit: 4294967296, memoryPercent: 100 },
    ] as never);
    const res = await executeK8sTool("top_pods", { namespace: "islap" });
    expect(res.success).toBe(true);
    expect((res.data as { pods: unknown[] }).pods).toHaveLength(1);
    expect(topPods).toHaveBeenCalledWith("islap");
  });

  it("get_deployment returns sanitized deployment", async () => {
    vi.mocked(getDeployment).mockResolvedValue({
      name: "kafka",
      namespace: "islap",
      replicas: 1,
      strategy: "Recreate",
      containers: [{ name: "kafka", image: "bitnamilegacy/kafka:4.0.0", resources: { limits: { memory: "4Gi" } } }],
      volumes: [{ name: "kafka-data", type: "emptyDir" }],
    } as never);
    const res = await executeK8sTool("get_deployment", { namespace: "islap", deployment_name: "kafka" });
    expect(res.success).toBe(true);
    expect((res.data as { deployment: { volumes: Array<{ type: string }> } }).deployment.volumes[0].type).toBe("emptyDir");
  });

  it("get_pod_memory parses cgroup numbers", async () => {
    vi.mocked(execPodCommand).mockResolvedValue(
      "4292751360\n4294967296\nanon 1128050688\nfile 3003297792\nslab 154821336\nkernel_stack 1736704",
    );
    const res = await executeK8sTool("get_pod_memory", { namespace: "islap", pod_name: "kafka-x" });
    expect(res.success).toBe(true);
    const data = res.data as { currentMi: number; maxMi: number; anonBytes: number; fileBytes: number };
    expect(data.currentMi).toBe(4094);
    expect(data.maxMi).toBe(4096);
    expect(data.anonBytes).toBe(1128050688);
    expect(data.fileBytes).toBe(3003297792);
  });

  it("get_pod_processes returns process lines", async () => {
    vi.mocked(execPodCommand).mockResolvedValue("1 root java -Xmx1024m kafka.Kafka\n12 root ps -ef");
    const res = await executeK8sTool("get_pod_processes", { namespace: "islap", pod_name: "kafka-x" });
    expect(res.success).toBe(true);
    expect((res.data as { processes: string[] }).processes).toHaveLength(2);
  });

  it("top_nodes returns node usage rows", async () => {
    vi.mocked(topNodes).mockResolvedValue([{ name: "ren-logging", cpuCores: 2.1, memoryBytes: 42949672960 }] as never);
    const res = await executeK8sTool("top_nodes", {});
    expect(res.success).toBe(true);
    expect((res.data as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it("get_node returns node details", async () => {
    vi.mocked(getNode).mockResolvedValue({
      name: "ren-logging",
      allocatable: { memory: "64Gi" },
      conditions: [{ type: "MemoryPressure", status: "False" }],
      taints: [],
    } as never);
    const res = await executeK8sTool("get_node", { node_name: "ren-logging" });
    expect(res.success).toBe(true);
    expect((res.data as { node: { name: string } }).node.name).toBe("ren-logging");
    expect(getNode).toHaveBeenCalledWith("ren-logging");
  });

  it("delete_pod calls the client and reports rebuild semantics", async () => {
    vi.mocked(deletePod).mockResolvedValue(undefined as never);
    const res = await executeK8sTool("delete_pod", { namespace: "ems", pod_name: "ecp-dashboard-api-abc" });
    expect(res.success).toBe(true);
    expect(vi.mocked(deletePod)).toHaveBeenCalledWith("ems", "ecp-dashboard-api-abc");
    const data = res.data as { deleted: string; note: string };
    expect(data.deleted).toBe("ems/ecp-dashboard-api-abc");
    expect(data.note).toContain("重建");
  });
});
