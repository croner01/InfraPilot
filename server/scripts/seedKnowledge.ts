// ============================================================================
// Knowledge Base Seed — 初始化常用知识/流程类案例
//
// 用法: npx tsx scripts/seedKnowledge.ts
// ============================================================================

import { addKnowledgeCase, initKnowledgeStore, listKnowledgeCases } from "../src/skills/knowledge/store.js";

async function main() {
  await initKnowledgeStore();

  const existing = listKnowledgeCases().find((c) => c.title === "OpenStack 虚拟机创建流程");
  if (existing) {
    console.log("OpenStack 虚拟机创建流程 已存在，跳过。");
    return;
  }

  await addKnowledgeCase({
    title: "OpenStack 虚拟机创建流程",
    problemType: "process",
    severity: "p3",
    summary: "用户请求创建虚拟机后，OpenStack 各服务协同完成资源申请、调度、网络分配、镜像启动的完整流程。",
    rootCauses: [
      "1. Nova API 接收 create-server 请求，进行参数校验、配额检查、镜像/规格/网络可用性校验",
      "2. Nova Conductor 将请求持久化到 Nova 数据库，生成 build 任务并发送 RPC 给 Scheduler",
      "3. Nova Scheduler 通过 Placement API 过滤满足资源需求(VCPU/MEMORY_MB/DISK_GB)的计算节点，按权重选出最佳节点",
      "4. Nova Compute 在选定 hypervisor 上创建 domain，分配 vCPU、内存、磁盘(ephemeral/卷)",
      "5. Neutron 分配端口(port)，绑定安全组、固定 IP，必要时分配浮动 IP",
      "6. Glance 提供镜像，Cinder 提供块存储；启动 guest OS 并完成 cloud-init 初始化",
      "7. Nova Compute 周期性上报状态，虚拟机进入 ACTIVE，用户可通过 console/SSH 访问",
    ],
    solutions: [
      "检查 nova-api 日志确认请求是否被接收和校验通过",
      "检查 nova-scheduler 日志确认是否有 NoValidHost 错误",
      "检查 Placement API 资源余量是否充足",
      "检查 nova-compute 日志确认 hypervisor 侧创建失败原因",
      "检查 neutron-server/neutron-agent 日志确认网络分配问题",
      "检查 glance 镜像可用性和 cinder 卷状态",
    ],
    serviceName: "openstack",
    tags: ["vm", "creation", "process", "nova", "neutron", "openstack"],
  });

  console.log("Knowledge base seeded.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
