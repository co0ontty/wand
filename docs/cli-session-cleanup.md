# 删除会话时清理 CLI 文件

Wand 删除自己管理的会话时，按已绑定的 provider 原生 session ID 清理对应的本地文件。手动删除、批量删除、会话所属容器的删除、保留期清理走同一个 `SessionRegistry.delete()` 入口；归档、停止、解除任务绑定不触发磁盘清理。

## 清理范围

| CLI | 精确归属的清理对象 |
| --- | --- |
| Claude | 项目中的 `<id>.jsonl`、`<id>/` 子代理目录；`session-env/<id>`、`tasks/<id>`、`todos/<id>`、`todos/<id>.json`、`file-history/<id>`、`debug/<id>.txt` |
| Codex | `sessions/` 与 `archived_sessions/` 中元数据 ID 匹配的 rollout；`shell_snapshots/<id>.sh`、`<id>.<数字>.sh` |
| OpenCode | 已有 session 数据库清理及该 ID 的 event sequence；不删除整个数据库、不强制 VACUUM |
| Qoder / Qoder CN | 两个配置根中的 `<id>.jsonl`、项目内 `<id>/`；`tasks/<id>`、`session-env/<id>`、`file-history/<id>` |
| Pi | 默认 CLI 根及 `harness.agentDir` 下、文件名精确以原生 ID 结尾的 session JSONL |
| Grok | 项目下以原生 ID 命名的会话目录 |

Claude/Codex/OpenCode 的配置根跟随 CLI 的有效子进程环境；Pi 的结构化执行同时支持 `harness.agentDir`。不会按 cwd、时间窗口或模糊文件名猜测归属。

## 安全与失败行为

- 其他 Wand 会话仍引用同一 provider/session ID 时保留文件。多个已删除会话仍在退出时，也要等其全部退出。
- 先删除 Wand 会话、撤销回调并发出已有停止信号，再等待 CLI 的退出确认。协议错误、传输观察失败不等于进程退出；超时（30 秒）保留文件并写 `[SessionCleanup]` 日志，不强杀其他执行。
- 不遍历符号链接删除链接目标，不接受路径穿越 session ID。重复删除、文件已经不存在可安全忽略。
- 不清理账号、凭据、插件、模型、共享缓存、项目源码、全局 history 或无法证明属于该 session 的随机命名文件。
- 没有原生 ID 的旧会话不猜测清理目标；不自动追溯扫描已经删除的旧会话。只保留内存中的退出等待，服务重启、磁盘权限错误或退出状态不确定时可能留下文件；本功能不是全局磁盘清理器，也不承诺失败后跨重启重试。

## 客户端与验证

删除接口与响应未改变。Web、macOS、Android、iOS 原有 `DELETE /api/sessions/:id` / `POST /api/sessions/batch-delete` 统一获得此服务端行为，无需客户端额外清理本机文件。
