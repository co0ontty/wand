# 持久化、日志与生命周期

这部分解释 wand 如何把“一个会话”的状态长期保存下来，以及会话在运行、空闲、归档之间如何流转。

## 1. 三层状态：内存、SQLite、文件日志

wand 的会话状态并不只保存在一个地方，而是分成三层：

1. **内存中的 `SessionRecord`**
   - 运行时最完整
   - 包含 PTY 引用、Bridge 引用、定时器、权限阻塞状态

2. **SQLite 中的 `SessionSnapshot`**
   - 用于会话列表、重启恢复、历史查询
   - 可跨进程保留

3. **磁盘日志目录 `~/.wand/sessions/<id>/`**
   - 用于调试和追溯
   - 保存 PTY 输出、消息快照、元数据、原生事件

三者并不是互斥关系，而是互相补位。

## 2. SQLite 存了什么

`src/storage.ts` 使用 `node:sqlite` 的 `DatabaseSync`，建了三张核心表：

### 2.1 `auth_sessions`
保存登录 token 与过期时间。

### 2.2 `command_sessions`
保存会话快照字段，包括：

- `id`
- `command`
- `cwd`
- `mode`
- `status`
- `exit_code`
- `started_at`
- `ended_at`
- `output`
- `archived`
- `archived_at`
- `claude_session_id`
- `messages`
- `resumed_from_session_id`
- `resumed_to_session_id`
- `auto_recovered`

### 2.3 `app_config`
保存运行期应用配置值，典型用途有：

- password 覆盖值
- favorite paths
- recent paths
- hidden Claude session IDs

也就是说，不是所有“配置”都在 `config.json`，一部分可变偏好数据是存到数据库里的。

## 3. `saveSession()` 与 `saveSessionMetadata()` 的区别

`storage.ts` 当前提供了两种写会话的方法：

### 3.1 `saveSession(snapshot)`
这是完整写入：

- 会把 `messages` 序列化成 JSON
- 用于关键状态切换场景

### 3.2 `saveSessionMetadata(snapshot)`
这是轻量更新：

- 只更新标量字段
- 不触碰 `messages`
- 适合热路径，避免频繁序列化大消息数组

这说明项目已经把“高频更新”和“完整快照落盘”做了区分。维护持久化性能时，要优先考虑是否该走 metadata 写入。

## 4. `mapSessionRow()` 是 SQLite -> 运行时快照的边界

从数据库读出的行并不是直接拿来用，而是通过 `mapSessionRow()` 转成 `SessionSnapshot`：

- `archived` / `auto_recovered` 从整数转布尔
- `messages` 用 `parseStoredMessages()` 反序列化
- `resumed_from_session_id` / `resumed_to_session_id` 统一成可选字段

如果后续给 `command_sessions` 加字段，这个映射函数也必须同步更新，否则即使数据库里有值，应用层也读不到。

## 5. schema 迁移策略是“加列，不删列”

`ensureCommandSessionSchema()` 每次启动都会通过 `PRAGMA table_info(command_sessions)` 检查现有列，再对缺失列执行：

```sql
ALTER TABLE command_sessions ADD COLUMN ...
```

这带来两个后果：

- 升级老库相对安全
- schema 会逐渐累积，不会自动收缩

所以如果以后真的要做破坏性 schema 变更，不能只靠当前这套逻辑。

## 6. `SessionLogger` 的目录结构

`src/session-logger.ts` 负责把每个会话的文件日志写到独立目录：

```text
~/.wand/sessions/<sessionId>/
  ├─ pty-output.log
  ├─ pty-output.log.1
  ├─ pty-output.log.2
  ├─ pty-output.log.3
  ├─ stream-events.jsonl
  ├─ messages.json
  ├─ metadata.json
  └─ shortcut-interactions.jsonl
```

### 6.1 `pty-output.log`
- 追加写入 PTY 原始输出
- 达到 50 MB 后轮转
- 最多保留 3 个历史副本

### 6.2 `stream-events.jsonl`
- 追加写入 native mode 的事件

### 6.3 `messages.json`
- 覆盖写入结构化消息快照

### 6.4 `metadata.json`
- 覆盖写入额外元数据

### 6.5 `shortcut-interactions.jsonl`
- 记录快捷键交互与输入上下文
- 大小超限时截断到后半段

## 7. 为什么既要 SQLite，又要文件日志

这两者服务不同场景：

### SQLite 更适合
- 列表页查询
- 恢复逻辑
- API 返回 session snapshot
- 登录态与偏好设置

### 文件日志更适合
- 调试某次会话的真实输出
- 查看原始 PTY 片段
- 排查“消息怎么被解析错了”
- 审计快捷键/自动审批行为

如果只保留其中一个，另一个场景的排障能力会明显下降。

## 8. `SessionLifecycleManager` 如何工作

`src/session-lifecycle.ts` 内部维护一个 `Map<string, SessionLifecycle>`，为每个会话记录：

- `state`
- `stateSince`
- `lastActivityAt`
- 可选 `archivedBy`, `archiveReason`

状态机支持：

- `initializing`
- `running`
- `idle`
- `thinking`
- `waiting-input`
- `archived`

## 9. 生命周期的触发方式

### 9.1 主动触发
`ProcessManager` 在这些时机调用 lifecycle：

- 新会话注册：`register()`
- 有输入/输出活动：`touch()`
- 用户提问后 Claude 正在响应：`startThinking()` / `stopThinking()`
- 需要等待用户继续输入：`waitingInput()`
- 需要归档：`archive()`

### 9.2 定时触发
`SessionLifecycleManager` 自己启动一个 `setInterval()`，每 60 秒检查一次所有会话：

- 超过 `archiveTimeout`：归档
- 超过 `idleTimeout`：转成 `idle`

默认值：

- idle timeout = 5 分钟
- archive timeout = 30 分钟

所以状态转移不是精确到秒，而是“最多存在一分钟粒度的延迟”。

## 10. 归档和删除不是一回事

### 归档 `archive()`
- 保留会话数据
- 标记为 archived
- 仍可在历史中看到

### 删除 `deleteSession()` / `processes.delete()`
- 真正从 SQLite 移除会话
- 日志目录也可能被删

因此归档是生命周期状态，删除是数据清除动作。

## 11. 登录 session 的生命周期

登录态并不走 `SessionLifecycleManager`，而是单独由 `auth.ts` 管理：

- 内存 `Map`
- SQLite `auth_sessions`
- 每 10 分钟清理一次过期 token

这是一套与命令会话平行存在的生命周期系统。

## 12. 配置文件、数据库和日志目录的关系

默认情况下：

- 配置：`~/.wand/config.json`
- 数据库：`~/.wand/wand.db`
- 日志：`~/.wand/sessions/<sessionId>/`

如果使用 `-c /tmp/wand-test/config.json`：

- 配置变成 `/tmp/wand-test/config.json`
- 数据库变成 `/tmp/wand-test/wand.db`
- 证书与日志目录也会跟着 configDir 迁移

这就是为什么 `-c` 能隔离整套运行环境。

## 13. 当前持久化模型下的重要注意点

### 13.1 `config.json` 与 `app_config` 是两套配置来源
- 静态启动配置主要来自 `config.json`
- 运行期偏好和部分覆盖值来自 SQLite `app_config`

### 13.2 历史会话不是只靠 SQLite
Claude 历史恢复还依赖 Claude 自己在 `~/.claude/projects/...` 下的项目文件，因此数据库里有 `claude_session_id` 也不代表一定还能恢复。

### 13.3 生命周期状态和运行状态并不完全等价
一个 session snapshot 里的 `status` 可能是 `running` / `exited` / `failed` / `stopped`，而 lifecycle 里还有 `thinking` / `idle` / `archived`。这两套状态描述的是不同维度：

- `status`：进程执行结果
- lifecycle：交互活跃度与会话阶段

## 14. 排障时的读取顺序建议

### 如果问题是“会话列表里有，但点开内容不对”
先查：

1. SQLite `command_sessions`
2. `messages.json`
3. `pty-output.log`
4. `mapSessionRow()` / `parseStoredMessages()`

### 如果问题是“重启后状态不对”
先查：

1. `storage.loadSessions()`
2. ProcessManager 构造时的恢复逻辑
3. `auth.ts` token 恢复逻辑
4. Claude 历史文件是否仍存在

### 如果问题是“会话为什么自动归档”
先查：

1. `SessionLifecycleManager` timeout 配置
2. `touch()` 是否被及时调用
3. 会话是否实际还在活跃输出
4. UI 是否只是显示旧 snapshot

理解这些持久化和生命周期边界后，再去改 UI 或交互逻辑，风险会小很多。
