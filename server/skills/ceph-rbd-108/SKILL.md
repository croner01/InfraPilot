---
name: ceph-rbd-108
description: Ceph RBD 客户端报 (108) Cannot send after transport endpoint shutdown / rbd attach/mount 失败时的排查指南。触发场景：kubelet MountVolume.WaitForAttach failed、librbd OpenRequest failed、rbd/rados 命令 108 报错。
---
# Ceph RBD 108 排查指南

1. 先确认 Ceph 集群健康：`ceph -s` / `ceph health detail` / `ceph osd dump`。
2. 立即检查池级黑名单（定制 Ceph 14.2.22-14 的 pool_blacklist 特性）：`ceph osd blacklist pool ls`。
   - 命中形如 `<node-ip>:0/0`（nonce/port=0）表示整个节点的所有会话被禁。
3. 做正常/异常对照：`rbd ls -p <poolA>` 正常而 `rbd ls -p <poolB>` 报 108 → 只有被黑名单的池受影响。
4. 在 OSD 日志确认拦截：`grep -i pool_blacklist /var/log/ceph/ceph-osd*.log`。
5. 追黑名单来源时间线：写入时间通常对应心跳超时/隔离事件；检查 hostha/fence 组件审计。
6. 处理顺序：先解除平台 fence/隔离状态，再 `ceph osd blacklist pool rm <ip>`，否则可能被重新加回。

详细说明见 references/pool-blacklist.md。
