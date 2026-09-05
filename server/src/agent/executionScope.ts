/** 启动时探测运行形态，生成注入 system prompt 的作用域说明，避免 Agent 把 server 容器视角当宿主机视角 */
export function isInCluster(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

export function getExecutionScopeNote(): string {
  if (isInCluster()) {
    return [
      "⚠️ 执行作用域警告: 当前 InfraPilot Server 部署在 Kubernetes Pod 内,",
      "linux 工具的 host=local 作用域是 **InfraPilot Server 容器自身**, 不是宿主机, 也不是目标业务 Pod。",
      "诊断业务 Pod 时必须优先使用 k8s.top_pods / k8s.get_pod_memory / k8s.get_pod_processes / k8s.get_deployment / k8s.list_pods,",
      "不得用 linux.get_memory_info / get_process_info / tail_recent_dmesg_or_syslog 推断业务 Pod 或宿主机状态。",
    ].join("\n");
  }
  return "当前 InfraPilot Server 运行在宿主机上, linux 工具 host=local 可直接读取宿主机内存/进程/dmesg。";
}
