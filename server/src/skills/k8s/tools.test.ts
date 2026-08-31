import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  execPodCommand: vi.fn(),
  getDeployment: vi.fn(),
  isAbnormalPod: vi.fn(),
  listEventsForPod: vi.fn(),
  listPods: vi.fn(),
  patchDeploymentMemoryLimit: vi.fn(),
  readPod: vi.fn(),
  topPods: vi.fn(),
}));

import { executeK8sTool } from "./tools.js";
import { execPodCommand, getDeployment, isAbnormalPod, listPods, topPods } from "./client.js";

const healthy = { name: "kafka-x", namespace: "islap", status: "Running", restartCount: 0, ready: true, startedAt: "2026-08-29T11:50:33Z" };
const errored = { name: "kafka-y", namespace: "islap", status: "Error", restartCount: 0, ready: false, startedAt: "2026-08-24T19:28:00Z" };
const restarting = { name: "kafka-z", namespace: "islap", status: "Running", restartCount: 3, ready: false, startedAt: "2026-08-30T01:00:00Z" };

describe("executeK8sTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAbnormalPod).mockImplementation((p: { status: string; restartCount: number }) => p.status !== "Running" || p.restartCount > 0);
  });

  it("list_pods returns only abnormal pods by default", async () => {
    vi.mocked(listPods).mockResolvedValue([healthy, errored, restarting] as never);
    const res = await executeK8sTool("list_pods", {});
    expect(res.success).toBe(true);
    const names = (res.data as { pods: Array<{ name: string }> }).pods.map((p) => p.name);
    expect(names).toEqual(["kafka-y", "kafka-z"]);
  });

  it("list_pods with all=true includes healthy pods and age", async () => {
    vi.mocked(listPods).mockResolvedValue([healthy, errored] as never);
    const res = await executeK8sTool("list_pods", { all: true });
    expect(res.success).toBe(true);
    const pods = (res.data as { pods: Array<{ name: string; ageSeconds?: number }> }).pods;
    expect(pods).toHaveLength(2);
    expect(pods[0].name).toBe("kafka-x");
    expect(pods[0].ageSeconds).toBeGreaterThan(0);
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
});
