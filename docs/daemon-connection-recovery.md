# Daemon 连接保活与升级恢复

Web 与终端所有者通过本地 socket 通信。Web 更新只断开客户端，不结束 terminald、
PTY Render v1、structured Render v2 或其子进程。

## 保活与恢复

- 三类客户端每 15 秒执行一次只读探活，同一连接最多一个在途心跳。
  terminald 使用老版本已有的 `hello`，两个 Rust daemon 使用既有 `ping`，不改协议版本。
- 5 秒内心跳未返回即关闭这一代客户端 socket，按 500ms 起步、最大 10 秒退避重连。
  普通 RPC 不会被自动重放；尤其不会重发用户输入、spawn 或 interrupt。
- 建连有 10 秒超时；并发调用共用一个握手。旧 socket 的迟到 data/error/close
  不得改变新连接的解码状态、在途请求或定时器。显式 disconnect 停止探活和重连。
- 重连时重新读取凭据，沿用原有 inventory / incarnation / sequence 续传机制。
  terminald 原先缓存 token 的行为已修正，daemon 重启后的 token 轮换可恢复。
- 新 daemon 每秒检查自己的监听路径。路径确实不存在时，在同一进程内重新 bind，
  保留已接受的连接、进程、token 和会话身份，重建 socket 权限为 0600。
  路径被其他文件或 listener 替代时不删除、不接管。
- 每分钟刷新自己 socket 的时间戳，避免空闲 `/tmp` 清理误删。新客户端在心跳成功后
  也刷新原 socket inode 的时间戳，使尚未更新、没有服务端 watchdog 的旧 daemon 受益。
- Node TUI IPC 入口采用同样的路径恢复机制。

## 升级兼容边界

1. 新 Server 继续领养旧 daemon；不因安装了新二进制而结束旧 owner。
2. 旧 terminald 对未知 `structuredList` 返回通用结果的行为仍兼容，探活不会依赖新方法。
3. pid 仍存活但 socket 暂时丢失时等待原 owner 恢复，不抢占路径或轮换其凭据。
   Rust 的直接启动入口也拒绝抢占此类仍存活的 owner。
4. 协议版本不匹配仍报错，不静默降级或跨 owner 接管会话。
5. 新增 watchdog 只有新启动的 daemon 才有。旧 daemon 若在升级前已经丢失监听路径，
   无法仅靠重启 Web 修复；必须在原进程内恢复监听，或等会话自然结束后更新 daemon。
   不得为恢复 Web 而直接杀掉仍持有任务的 daemon。
6. 日志和检查不得输出 token / 连接码。运行中 daemon 的独立更新节奏保持不变。

回归覆盖：`tests/daemon-heartbeat.test.ts`、`tests/terminal-daemon-socket-recovery.test.ts`、
`tests/render-socket-recovery.test.ts`，以及既有重连、Render 协议和 structured contract 测试。
Rust `socket_keepalive` 单测覆盖重复重绑、既有连接保留、替代路径保护。
