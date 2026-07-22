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
  {
    name: "run_command",
    skill: "linux",
    risk: "readonly",
    description:
      "在目标主机执行白名单内的 Linux/K8s 诊断命令。支持 cat/less/head/tail/ls/ps/ss/ip/df/free/dmesg/journalctl/systemctl/kubectl/crictl/docker 等。禁止执行变更类子命令（如 systemctl restart 必须走 restart_service 工具）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名，如 'local' 或 'node-1'" },
        command: { type: "string", description: "命令名，如 'cat'、'kubectl'" },
        args: { type: "array", items: { type: "string" }, description: "命令参数数组" },
        timeout_ms: { type: "number", description: "超时毫秒数，默认 10000" },
      },
      required: ["host", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    skill: "linux",
    risk: "readonly",
    description: "读取远程或本地文件内容（cat 的封装）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名" },
        path: { type: "string", description: "文件路径" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "tail_file",
    skill: "linux",
    risk: "readonly",
    description: "读取文件尾部 N 行（tail 的封装）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名" },
        path: { type: "string", description: "文件路径" },
        lines: { type: "number", description: "行数，默认 20" },
      },
      required: ["host", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    skill: "linux",
    risk: "readonly",
    description: "列出目录内容（ls -la 的封装）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "目标主机名" },
        path: { type: "string", description: "目录路径，默认当前目录" },
      },
      required: ["host"],
      additionalProperties: false,
    },
  },
  {
    name: "check_service_status",
    skill: "linux",
    risk: "readonly",
    description: "查看系统服务状态（systemctl status 的封装）。",
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
    name: "get_kubernetes_resource",
    skill: "linux",
    risk: "readonly",
    description: "获取 K8s 资源（kubectl get 的封装）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "运行 kubectl 的目标节点 Agent" },
        resource: { type: "string", description: "资源类型，如 pods/deployments/services" },
        namespace: { type: "string", description: "命名空间，默认 default" },
        all_namespaces: { type: "boolean", description: "是否跨命名空间查询" },
        name: { type: "string", description: "资源名（可选）" },
        output: { type: "string", description: "输出格式：wide/yaml/json" },
      },
      required: ["host", "resource"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_kubernetes_resource",
    skill: "linux",
    risk: "readonly",
    description: "描述 K8s 资源详情（kubectl describe 的封装）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "运行 kubectl 的目标节点 Agent" },
        resource: { type: "string", description: "资源类型" },
        namespace: { type: "string", description: "命名空间" },
        name: { type: "string", description: "资源名" },
      },
      required: ["host", "resource", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pod_logs",
    skill: "linux",
    risk: "readonly",
    description: "获取 Pod 日志（kubectl logs 的封装）。",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "运行 kubectl 的目标节点 Agent" },
        namespace: { type: "string", description: "命名空间" },
        pod_name: { type: "string", description: "Pod 名称" },
        container: { type: "string", description: "容器名（多容器 Pod 必填）" },
        tail_lines: { type: "number", description: "返回最近 N 行，默认 100" },
        previous: { type: "boolean", description: "是否查看上一次容器实例日志" },
        since: { type: "string", description: "例如 '5m' / '1h'" },
      },
      required: ["host", "pod_name"],
      additionalProperties: false,
    },
  },
];
