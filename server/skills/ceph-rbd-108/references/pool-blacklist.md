# Ceph 池级黑名单（pool_blacklist）

- 定制 Ceph 14.2.22-14 的 osdmap 特性，osdmap flag 启用 `pool_blacklist` 后可用：
  - `ceph osd blacklist pool ls` 查看
  - `ceph osd blacklist pool add <ip>` / `ceph osd blacklist pool rm <ip>` 管理
- 条目 `<ip>:0/0` 中 nonce/port 为 0，表示匹配该 IP 发起的所有客户端会话。
- 症状：集群 HEALTH_OK、PG active+clean，但被禁节点访问特定池全部失败，
  报 (108) Cannot send after transport endpoint shutdown；OSD 日志出现
  `do_op ... is pool_blacklisted`。
- 常见来源：HA/fence 组件（如 hostha）在节点隔离时写入，隔离解除后未清理。
