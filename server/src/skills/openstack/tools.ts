// ============================================================================
// OpenStack Skill — Tools
//
// 提供 Nova/Neutron/Placement 等 OpenStack 核心服务的诊断与变更能力。
// 所有工具返回统一 ToolExecutionResult，由 Command Gateway 统一路由。
// ============================================================================

import type { ToolDef, ToolExecutionResult } from "../../types.js";
import {
  showServer,
  listServerEvents,
  listHypervisors,
  listAllocationCandidates,
  listNeutronAgents,
  listNovaServices,
  rebootServer,
} from "./client.js";

export const openstackTools: ToolDef[] = [
  {
    name: "server_show",
    skill: "openstack",
    risk: "readonly",
    description:
      "获取 Nova 虚机详情，包含 status、fault 信息、hypervisor_hostname、flavor、image、addresses 等。用于诊断虚机异常状态或创建失败后的资源分配情况。",
    parameters: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "Nova 虚机 UUID" },
      },
      required: ["server_id"],
      additionalProperties: false,
    },
  },
  {
    name: "server_list_events",
    skill: "openstack",
    risk: "readonly",
    description:
      "获取指定虚机的 instance action / event 列表，用于排查创建失败、迁移、重启等生命周期事件。",
    parameters: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "Nova 虚机 UUID" },
      },
      required: ["server_id"],
      additionalProperties: false,
    },
  },
  {
    name: "hypervisor_list",
    skill: "openstack",
    risk: "readonly",
    description:
      "获取 Nova 计算节点资源余量（vcpus、memory_mb、running_vms 等），用于定位 NoValidHost 类调度失败。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "allocation_candidate_list",
    skill: "openstack",
    risk: "readonly",
    description:
      "通过 Placement API 查询满足指定资源需求的 allocation candidate，用于定位 NoValidHost。",
    parameters: {
      type: "object",
      properties: {
        resources: {
          type: "string",
          description:
            "Placement resources 查询串，例如 VCPU=1,MEMORY_MB=2048,DISK_GB=20",
        },
      },
      required: ["resources"],
      additionalProperties: false,
    },
  },
  {
    name: "neutron_agent_list",
    skill: "openstack",
    risk: "readonly",
    description:
      "获取 Neutron agent（DHCP、L3、Open vSwitch 等）状态，用于诊断网络相关故障。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "nova_service_list",
    skill: "openstack",
    risk: "readonly",
    description:
      "获取 Nova 服务（nova-api、nova-scheduler、nova-compute 等）状态，用于诊断控制面服务异常。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "server_reboot",
    skill: "openstack",
    risk: "high",
    description:
      "重启指定 Nova 虚机（SOFT=优雅重启，HARD=强制重启）。属于变更操作，需人工审批。",
    parameters: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "Nova 虚机 UUID" },
        reboot_type: {
          type: "string",
          enum: ["SOFT", "HARD"],
          description: "SOFT=优雅重启，HARD=强制重启",
        },
      },
      required: ["server_id", "reboot_type"],
      additionalProperties: false,
    },
  },
];

export async function executeOpenStackTool(
  tool: string,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  switch (tool) {
    case "server_show":
      return showServer(String(args.server_id));
    case "server_list_events":
      return listServerEvents(String(args.server_id));
    case "hypervisor_list":
      return listHypervisors();
    case "allocation_candidate_list":
      return listAllocationCandidates(String(args.resources));
    case "neutron_agent_list":
      return listNeutronAgents();
    case "nova_service_list":
      return listNovaServices();
    case "server_reboot":
      return rebootServer(String(args.server_id), args.reboot_type as "SOFT" | "HARD");
    default:
      return {
        success: false,
        error: `未知 OpenStack 工具: ${tool}`,
        durationMs: 0,
      };
  }
}
