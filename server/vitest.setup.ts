// 测试隔离：所有测试共享同一个临时数据目录，
// 避免 runner 测试的 resetDb() 误删 server/data 下的开发数据。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.INFRAPILOT_DATA_DIR = path.join(os.tmpdir(), "infrapilot-test-data");

// 每个 vitest worker 进程使用独立技能目录，避免并行 worker 竞争同一目录
const skillsFixture = path.join(os.tmpdir(), `infrapilot-test-skills-${process.pid}`);
fs.rmSync(skillsFixture, { recursive: true, force: true });
fs.mkdirSync(path.join(skillsFixture, "sre-systematic-debugging"), { recursive: true });
fs.writeFileSync(
  path.join(skillsFixture, "sre-systematic-debugging", "SKILL.md"),
  [
    "---",
    "name: sre-systematic-debugging",
    "description: 基础设施故障诊断方法论，诊断类任务开始时必须激活：界定影响范围、查最近变更、收集证据、形成并验证假设、时间线对齐后再下结论。",
    "---",
    "# 系统性诊断协议",
    "1. 界定范围：什么坏了、什么正常",
    "2. 最近变更",
    "3. 判别性证据",
  ].join("\n")
);
fs.mkdirSync(path.join(skillsFixture, "ceph-rbd-108"), { recursive: true });
fs.writeFileSync(
  path.join(skillsFixture, "ceph-rbd-108", "SKILL.md"),
  [
    "---",
    "name: ceph-rbd-108",
    "description: Ceph RBD 客户端 (108) Cannot send after transport endpoint shutdown / attach 失败排查。先查 ceph osd blacklist pool ls，再做正常/异常池对照。",
    "---",
    "# Ceph RBD 108 排查",
    "1. ceph -s 确认集群健康",
    "2. ceph osd blacklist pool ls 查池级黑名单",
    "3. rbd ls -p 对照正常/异常池",
    "参考: references/pool-blacklist.md",
  ].join("\n")
);
fs.mkdirSync(path.join(skillsFixture, "ceph-rbd-108", "references"), { recursive: true });
fs.writeFileSync(
  path.join(skillsFixture, "ceph-rbd-108", "references", "pool-blacklist.md"),
  "pool_blacklist 是定制 Ceph 14.2.22-14 特性；`<ip>:0/0` 表示整节点所有会话被禁。"
);
process.env.INFRAPILOT_SKILLS_DIR = skillsFixture;
