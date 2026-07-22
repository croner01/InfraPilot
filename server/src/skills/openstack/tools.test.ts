import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  showServer: vi.fn(),
  listServerEvents: vi.fn(),
  listHypervisors: vi.fn(),
  listAllocationCandidates: vi.fn(),
  listNeutronAgents: vi.fn(),
  listNovaServices: vi.fn(),
  rebootServer: vi.fn(),
  resetAuthCache: vi.fn(),
}));

import {
  showServer,
  listServerEvents,
  listHypervisors,
  listAllocationCandidates,
  listNeutronAgents,
  listNovaServices,
  rebootServer,
} from "./client.js";
import { executeOpenStackTool, openstackTools } from "./tools.js";
import type { ToolExecutionResult } from "../../types.js";

describe("executeOpenStackTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches server_show", async () => {
    (showServer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { id: "srv-1" },
      durationMs: 10,
    });
    const res = await executeOpenStackTool("server_show", { server_id: "srv-1" });
    expect(showServer).toHaveBeenCalledWith("srv-1");
    expect(res.success).toBe(true);
  });

  it("dispatches server_list_events", async () => {
    (listServerEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [],
      durationMs: 10,
    });
    await executeOpenStackTool("server_list_events", { server_id: "srv-1" });
    expect(listServerEvents).toHaveBeenCalledWith("srv-1");
  });

  it("dispatches hypervisor_list", async () => {
    (listHypervisors as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [],
      durationMs: 10,
    });
    await executeOpenStackTool("hypervisor_list", {});
    expect(listHypervisors).toHaveBeenCalled();
  });

  it("dispatches allocation_candidate_list", async () => {
    (listAllocationCandidates as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {},
      durationMs: 10,
    });
    await executeOpenStackTool("allocation_candidate_list", {
      resources: "VCPU=1,MEMORY_MB=2048",
    });
    expect(listAllocationCandidates).toHaveBeenCalledWith("VCPU=1,MEMORY_MB=2048");
  });

  it("dispatches neutron_agent_list", async () => {
    (listNeutronAgents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [],
      durationMs: 10,
    });
    await executeOpenStackTool("neutron_agent_list", {});
    expect(listNeutronAgents).toHaveBeenCalled();
  });

  it("dispatches nova_service_list", async () => {
    (listNovaServices as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: [],
      durationMs: 10,
    });
    await executeOpenStackTool("nova_service_list", {});
    expect(listNovaServices).toHaveBeenCalled();
  });

  it("dispatches server_reboot", async () => {
    (rebootServer as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { message: "ok" },
      durationMs: 10,
    });
    await executeOpenStackTool("server_reboot", {
      server_id: "srv-1",
      reboot_type: "HARD",
    });
    expect(rebootServer).toHaveBeenCalledWith("srv-1", "HARD");
  });

  it("returns error for unknown tool", async () => {
    const res = (await executeOpenStackTool("unknown_tool", {})) as ToolExecutionResult;
    expect(res.success).toBe(false);
    expect(res.error).toContain("未知 OpenStack 工具");
  });
});

describe("openstackTools", () => {
  it("includes expected tools", () => {
    const names = openstackTools.map((t) => t.name);
    expect(names).toEqual([
      "server_show",
      "server_list_events",
      "hypervisor_list",
      "allocation_candidate_list",
      "neutron_agent_list",
      "nova_service_list",
      "server_reboot",
    ]);
  });

  it("marks server_reboot as high risk", () => {
    const reboot = openstackTools.find((t) => t.name === "server_reboot");
    expect(reboot?.risk).toBe("high");
  });
});
