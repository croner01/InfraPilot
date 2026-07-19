// ============================================================================
// Linux Skill — Phase 2 MCP Agent 扩展工具定义
// 这些工具会通过 MCP Client Router 路由到 linux-mcp-server 或 SSH fallback。
// ============================================================================

import type { ToolDef } from "../../types.js";

export const linuxAgentTools: ToolDef[] = [
  {
    name: "get_network_stats",
    skill: "linux",
    risk: "readonly",
    description: "获取主机网络统计信息：连接数分布、TCP状态、接口收发/错误计数。支持远程主机。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名，如 'local' 或 'node-1'" },
        iface: { type: "string", description: "可选，指定网卡名；不指定返回所有非 lo 接口" },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "restart_service",
    skill: "linux",
    risk: "high",
    description: "重启指定的系统服务。仅允许白名单中的服务（如 nginx/docker/kubelet/sshd/cron/containerd）。需要审批。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名" },
        service_name: { type: "string", description: "服务名，如 'nginx'" },
      },
      required: ["host", "service_name"],
      additionalProperties: false,
    },
  },
  {
    name: "kill_process",
    skill: "linux",
    risk: "high",
    description: "向指定 PID 发送信号。仅允许 SIGTERM/SIGHUP/SIGUSR1/SIGUSR2。需要审批。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名" },
        pid: { type: "number", description: "进程 PID" },
        signal: { type: "string", description: "信号名，默认 SIGTERM" },
      },
      required: ["host", "pid"],
      additionalProperties: false,
    },
  },
];
