# Wand 服务端整改续接文档

最后更新：2026-07-14（Asia/Shanghai）

工作区：`/Users/co0ontty/Self/vibe_coding/wand`

## 1. 重启会话后的第一条指令

建议在新会话中直接发送：

> 读取 `docs/server-refactor-handoff.md`，保留当前所有未提交改动，不要 reset、checkout 或覆盖用户改动。服务端整改 P1～P3 已全部完成；开始新任务前先确认当前 diff 与 `npm run check && npm test` 基线。

如果需要非 Fast 模型，请先在输入框下方的模型控制中选择 **Power/Smarter**，再开始新会话。当前会话内的 agent 无法替用户切换底层模型。

## 2. 当前仓库状态与重要约束

当前工作区是脏的，包含用户原有改动和本轮服务端整改改动，**绝对不要使用**：

- `git reset --hard`
- `git checkout -- <file>`
- `git clean -fd`
- 任何会整体覆盖 `server.ts`、`server-session-routes.ts` 或前端生成文件的操作

继续前先运行：

```bash
cd /Users/co0ontty/Self/vibe_coding/wand
git status --short
git diff --check
```

本轮开始前就已经存在的用户改动包括：

- `.DS_Store`
- `android` 子模块状态
- `package.json`、`package-lock.json`
- `src/models.ts`、`src/types.ts`
- `src/server.ts`、`src/server-session-routes.ts` 中的部分会话历史改动
- `src/web-ui/browser/input.ts`
- `src/web-ui/browser/message-reconciliation.ts`
- `src/web-ui/browser/session-engine.ts`
- `src/web-ui/browser/websocket.ts`
- `src/web-ui/content/scripts.js`
- `tests/message-reconciliation.test.ts`
- `tests/models-endpoints.test.ts`
- `tests/models.test.ts`
- `tests/session-history-dedupe.test.ts`

其中 `src/server.ts`、`src/server-session-routes.ts` 和生成的 Web 资源与本轮改动有重叠；后续修改必须以当前文件为基础，不能从 HEAD 重建。

## 3. 已完成的整改

以下工作已经实现并通过回归，不应重复重做。

### 3.1 输入验证与命令执行安全

- Provider resume ID 统一限制为 UUID 形状，阻断 shell 拼接注入。
- 所有外部传入的 execution mode 改为严格校验，不再把拼写错误静默降级为默认值。
- escalation resolution 只接受 `approve_once`、`approve_turn`、`deny`。
- 权限响应必须匹配当前 pending request ID，过期响应不会向 PTY 发送回车。
- 命令白名单从字符串前缀比较改为受限 shell token 比较，阻断：
  - `claude-malicious`
  - `claude; evil`
  - `claude && evil`
  - 管道、重定向、反引号和 `$()` command substitution
- 相关文件：
  - `src/resume-policy.ts`
  - `src/process-manager.ts`
  - `src/server-session-routes.ts`
  - `src/server.ts`

### 3.2 PTY / Structured 运行代际与并发

- PTY data/exit/timer 回调增加 record/child identity guard，旧进程不能污染复用后的 session ID。
- Structured runner 使用 active request generation guard；旧 close/error/finally 不能覆盖新请求或释放新句柄。
- 已发送 signal 的 child 在真正 close/error 前仍被视为 active。
- SDK query、AbortController、CLI child 都纳入 in-flight 判断和安全释放。
- stop/delete/dispose 会先失效 request generation，再终止底层 runner。
- AskUserQuestion 在 CLI/SDK 中断和提前排队回答的边界已修复。
- 每个 session 持久化自己的 runner；全局 `structuredRunner` 只作为新建/旧数据恢复时的默认值。
- Provider/runner 组合严格限制：
  - Claude：SDK 或 Claude CLI print
  - Codex：`codex-cli-exec`
  - OpenCode：`opencode-cli-run`

### 3.3 WebSocket 背压与输入上限

- 高水位时只暂停接收新的业务事件，发送泵继续排空，修复队列永久卡死。
- 队列回落到低水位后主动发送 `resync_required`。
- send callback 任一失败会丢弃该连接队列并 terminate，避免半坏连接继续积压。
- WebSocket incoming payload 限制为 256 KiB。
- 客户端历史 `blockBudget` 最大 2,000。
- 文件搜索参数有界：depth 最大 8、limit 最大 200、最多访问 20,000 个目录项，并跳过常见构建目录。
- HTTP JSON body 按路由限制：
  - 默认 1 MiB
  - prompt optimize 256 KiB
  - file write 2 MiB（业务内容仍限制为 1 MiB）

### 3.4 配置、认证和文件权限

- `config.json` 不再写入 `password` 和 `appSecret`。
- 旧 JSON secrets 会迁移到 SQLite，并重写干净配置。
- 配置目录和数据库目录修复为 `0700`。
- 配置、数据库、生成的证书和私钥修复为 `0600`。
- 修改密码会：
  - 更新 DB 密码
  - 清空内存和 DB 中全部 auth sessions
  - 断开全部 WebSocket
  - 清除所有兼容 cookie
- auth storage 切换时清空内存 token cache，避免 server A 的 token 在 server B 中误认证。
- Settings 更新先构建无副作用 candidate，再进行文件写入和 DB transaction，避免半更新。
- Settings/API 响应不再返回密码或 appSecret。

### 3.5 HTTPS 证书安全

- OpenSSL 从 shell 字符串执行改成 `execFileSync` argv。
- hostname/IP SAN 经过严格过滤。
- 临时和最终 key/cert 权限收紧。
- 生成后验证 PEM、有效期、私钥匹配和 TLS 可加载性。
- 删除无效 placeholder certificate fallback。
- OpenSSL 不可用时明确失败并清理临时文件。

### 3.6 Session 持久化正确性

- SQLite 新增 versioned `session_options`，迁移老 schema。
- 已覆盖：
  - autonomy/approval policy
  - allowed scopes
  - pending/last escalation
  - auto approve（包括 `false`）
  - approval stats
  - selected model / thinking effort
  - PTY cols/rows
  - current task title / summary
- malformed JSON 会安全降级。
- ProcessManager snapshot 已保留 worktree merge 状态、falsey auto approve、approval stats、task title 和 summary。
- Structured streaming 的全量 checkpoint 从每 200ms 降为每 1s；terminal path 仍强制最终保存。

### 3.7 Worktree 合并安全与状态一致性

- 所有 git 子进程有默认 30 秒 timeout、10 MiB maxBuffer 和非交互环境。
- merge 前记录原 branch/HEAD 和目标 branch HEAD。
- 冲突、hook 超时或 merge 失败后：
  - 检测并执行 `merge --abort`
  - 恢复目标 branch HEAD
  - 恢复原 branch 或 detached HEAD
  - 校验没有残留 `MERGE_HEAD`
- ProcessManager / StructuredSessionManager 新增 canonical merge state 更新 API。
- check、merge、失败和 cleanup 路径会同步内存、SQLite 和 WebSocket status event。

### 3.8 生命周期与异步错误处理

- ProcessManager、StructuredSessionManager、WsBroadcastManager 均有幂等 `dispose()`。
- dispose 会停止 timers、runner、PTY、SDK query、child、WS queue，并持久化终态。
- `ServerHandle.close()` 幂等，顺序为：停止接收请求 → dispose managers/WS → 关闭连接 → detach auth storage → 关闭 DB。
- listen 失败和 restart 路径复用清理逻辑。
- Express 4 async route 统一通过 `src/express-async.ts` 转发 rejection。
- `src/server.ts` 和 `src/server-session-routes.ts` 中所有 async Express handler 均已包装。
- 统一 JSON error middleware 覆盖 parser、sync middleware 和 async rejection。

### 3.9 更新助手

- 修复 macOS detached helper 再调用 BSD `nohup` 时出现 `can't detach from console`、导致新版 CLI 未启动的问题。
- helper 已处于 detached session，现直接后台拉起新 CLI，并完整重定向 stdio。

### 3.10 SessionLogger 热路径 I/O 批处理（P1-1）

- `SessionLogger` 现在按目标文件缓冲追加内容，使用 40ms `unref()` timer 批量落盘。
- 单文件缓冲上限 256 KiB、全局上限 4 MiB；达到上限立即同步 flush，避免内存无界增长。
- PTY 逻辑大小包含尚未落盘的字节，rotation 前强制 flush，保持字节顺序和边界正确。
- read/delete 会先 flush 对应 session；新增 `flushSession()`、`flushAll()` 和幂等 `dispose()`。
- `ProcessManager` 负责释放自有 logger；`server.ts` 在 structured manager 之后释放注入的 structured logger，ownership 明确。
- 新增 `tests/session-logger.test.ts`，覆盖批处理、timer/read flush、rotation、delete、dispose 和缓冲上限。

### 3.11 SQLite Session 定向 checkpoint（P1-2）

- `WandStorage` 新增 `updateSessionRuntimeMetadata()`、`checkpointSessionOutput()` 和 `checkpointSessionMessages()`，分别处理元数据、PTY output 与 structured messages。
- `ProcessManager` 和 `StructuredSessionManager` 使用 dirty state 与固定 1 秒 checkpoint window；持续输出不会把 timer 无限后移。
- model/mode/topic/queue 等元数据更新不再重写完整 messages。
- exit/stop/dispose 等 terminal path 仍进行 authoritative full flush。
- 新增 `tests/session-persistence.test.ts`；10,000 blocks 的流式场景只产生有界 message checkpoint，dispose 后 DB 与内存一致。

### 3.12 App Token principal 与 scopes（P1-3）

- 已调查 browser extension、Android、iOS、macOS 的实际 API 使用；普通 session/chat/file 与 password vault 能力和 admin 能力分离。
- `auth_sessions` 增加 `kind`/`scopes` 并带兼容迁移；旧 session 默认 `browser-admin`。
- 密码登录创建 `browser-admin`，app token 登录/cookie 与 Bearer app token 映射为受限 `connected-app`。
- connected app 可使用 sessions、files、password-vault 等声明 scope；settings、改密、更新、重启、证书、connect code 和环境变量 reveal 等敏感操作要求 admin。
- 原生客户端仍可写入有限的新会话偏好字段，其余 settings 写入返回 403。
- 密码轮换会撤销两类 session 和旧 app token；malformed、expired、跨 storage token 均拒绝。
- 相关回归集中在 `tests/security-hardening.test.ts` 和 `tests/settings-config.test.ts`。

### 3.13 文件路由拆分（P2-1）

- 新增 `src/server-file-routes.ts`，集中注册 directory、preview/raw/write、folders、quick/recent paths、validate path 和 file search。
- 模块使用显式 `{ storage, defaultCwd }` dependency object，不引入全局 service locator。
- `recordRecentPath()` 与 `streamFileWithRange()` 一并提取，后者继续供公开 APK/DMG 下载路由复用。
- 注册点仍位于 `/api` auth middleware 之后，route-specific/global parser 和最终 `jsonErrorHandler` 顺序未改变。
- 完成文件路由第一步时 `src/server.ts` 约 2,562 行；新增 `tests/server-file-routes.test.ts` 覆盖注册后的核心行为。

### 3.14 SessionRegistry façade（P2-2）

- 新增 `src/session-registry.ts`，统一 Structured → PTY → SQLite fallback 的 ownership precedence。
- list、get、model、thinking effort、mode、topic、worktree 和 delete 均通过唯一 owner 更新，旧 SQLite snapshot 不会覆盖 live manager。
- provider history 删除和 tombstone 与 session owner 删除保持在同一 façade。
- `tests/session-registry.test.ts` 覆盖 precedence、双 owner 防护、stale storage 和 provider history ownership。

### 3.15 HTTP Git 操作异步化（P2-3）

- `src/git-utils.ts` 新增 Promise 版 git runner，保留 timeout、maxBuffer、非交互环境和错误格式。
- status、quick commit、push、tag、worktree check/merge/cleanup 等 HTTP 路径已迁移到异步子进程。
- worktree rollback 继续严格串行，且不受客户端断开取消。
- 同步 runner 只保留给启动期、测试兼容和短探测。

### 3.16 desired/live config 与 AuthService（P2-4、P2-5）

- 新增 `RuntimeConfigState`；host/port/https/shell 等部署字段只更新 desired config，热偏好立即更新 active config。
- settings 响应同时返回 desired、active 和真实 `restartRequired`。
- 认证 token、storage 和 cleanup timer 已收进每个 server 自有的 `AuthService`；同一进程的两个 server 不共享 token。
- server close/listen failure 会 dispose 自有 auth service，WS 通过实例注入验证会话。

### 3.17 settings/update 路由拆分

- 新增 `src/server-settings-routes.ts` 和 `src/server-update-routes.ts`，使用显式 dependency object。
- public APK/DMG 更新与下载路由仍在 auth middleware 之前；admin settings/update 路由仍在 admin scope 之后。
- `src/server.ts` 降至约 2,093 行。
- `tests/server-update-routes.test.ts` 覆盖 metadata、channel、range 和 missing asset；settings/models/provider updater 原回归继续覆盖 admin 路由。

### 3.18 Structured provider adapters 与 history scanner（P3）

- Claude CLI/SDK、Codex、OpenCode 的参数/权限/事件转换已分别提取到独立 adapter；`StructuredSessionManager` 只保留会话生命周期和流式状态协调。
- runner/provider 默认与 thinking effort 映射集中到 `structured-provider-common.ts`。
- Claude/Codex 历史扫描从 `ProcessManager` 提取为 `ProviderHistoryScanner`。
- history index 按 `(path, mtime, size)` 复用文件摘要；同一启动恢复多个 Codex 会话只构建一次初始索引，修改/新增文件才重新读取 JSONL head。

### 3.19 Session transport DTO 与长会话性能（P3）

- 新增 `session-transport.ts`，使用显式字段白名单隔离内部 session object 与 HTTP/WS wire DTO。
- session list 不传 transcript/messages；详情和 WS init 使用消息窗口。
- output 最多传最近 200,000 字符，并附 `outputOffset`、`outputTotal`、`outputTruncated`。
- 10,000 blocks、4～5 MiB output、3 个慢 WS 客户端的定向基准已加入 `tests/long-session-transport.test.ts`。
- SQLite worker 评估见 `docs/server-performance-evaluation.md`：当前定向 checkpoint 约 0.04 ms/output update、0.5 ms/10k-block message update，本轮不引入 worker；文档记录了重新评估阈值。

## 4. 当前验证基线

在 2026-07-14 完成 P1～P3 后：

```text
npm run check  -> 通过
npm test       -> 135 passed, 0 failed
git diff --check -> 通过
```

`npm run check` 包含：

- browser bundle
- embedded web assets generation
- server TypeScript check
- browser TypeScript check

重启后不要假定仍然通过；任何新改动后都要重新运行。

## 5. 整改任务追踪

P1-1、P1-2、P1-3、P2-1～P2-5 和 P3 已全部完成；其原始设计保留在下方作为实现背景，不应重复实施。

## P1-1：SessionLogger 热路径 I/O 批处理（已完成）

完成结果见 3.10；以下为整改前问题与原始验收设计。

### 当前问题

`src/session-logger.ts` 仍在事件循环热路径中大量使用同步文件 API：

- `appendFileSync`：PTY 输出、stream events、structured stdout/stderr、spawn events、shortcut logs
- `writeFileSync`：messages、metadata、shortcut truncate
- `readFileSync`：PTY transcript、stderr tail、shortcut truncate

高频 token/PTY chunk 会频繁同步进入文件系统。即使 SQLite checkpoint 已降频，日志仍可能造成明显停顿。

### 推荐的低风险实现

第一步先做**有界批量写入**，不要直接大改成无界异步 Promise 链：

1. 在 `SessionLogger` 内按目标文件维护 buffer。
2. 追加类 API 保持同步签名，只把字符串加入 buffer。
3. 每 25～50ms flush 一批；timer 必须 `unref()`。
4. 设置单文件和全局 buffer 上限，例如单文件 256 KiB、全局 2～4 MiB；达到上限立即 flush。
5. 同一文件严格保持写入顺序。
6. PTY size cache 必须包含已缓冲但未落盘的字节。
7. 发生 rotation 前先 flush 当前 PTY buffer。
8. `readPtyOutput`、`readStructuredStderrTail`、`deleteSession` 前先 flush 对应 session。
9. 增加：
   - `flushSession(sessionId)`
   - `flushAll()`
   - 幂等 `dispose()`：清 timer 并同步 flush 剩余 buffer
10. `ProcessManager.dispose()` 调用其自有 logger 的 `dispose()`。
11. `structuredLogger` 当前由 `server.ts` 创建并注入 StructuredSessionManager；明确唯一 ownership，建议由 `server.ts` 在 structured manager dispose 后调用 logger.dispose，避免双重 ownership。

### 必须新增的测试

- 高频小 chunk 合并成少量 append，但内容和顺序完全一致。
- timer flush 后可立即读到完整内容。
- 显式 read 会先 flush 未落盘 buffer。
- rotation 边界不会漏字节或乱序。
- delete 不会被迟到 timer 重新创建目录/文件。
- dispose 幂等且不丢最后一批日志。
- buffer 达到上限会被强制清空，不会无限增长。

### 风险

- 不要让异步写在 delete 后重新创建 session 目录。
- 不要在两个 logger 实例之间共享同一文件队列。
- 不要因为批处理改变 JSONL 一行一个对象的格式。

## P1-2：降低 SQLite 全量 Session 快照写放大（已完成）

完成结果见 3.11；以下为整改前问题与原始验收设计。

### 当前问题

- `WandStorage` 使用同步 `DatabaseSync`。
- `saveSession()` 会序列化并 UPSERT 整个 messages 数组。
- Structured streaming 每 1 秒仍可能重写一个数 MiB 的 messages JSON。
- `saveSessionMetadata()` 名义上是 metadata，但仍更新完整 `output` 和 `session_options`。
- ProcessManager 在 message signature 变化时写完整 Session，否则仍写包含 output 的 metadata。

### 推荐分阶段实现

不要第一步就引入复杂 event sourcing。先拆出定向更新 statement：

1. 在 storage 中增加明确方法：
   - `updateSessionRuntimeMetadata(snapshot)`：不写 messages、不写 output
   - `checkpointSessionOutput(id, output)`
   - `checkpointSessionMessages(id, messages, structuredState?, output?)`
2. Manager 内维护 dirty flags：`metadataDirty`、`outputDirty`、`messagesDirty`。
3. PTY output 每 1 秒 checkpoint；exit/stop/dispose 强制 flush。
4. Structured messages 在每 1 秒 crash checkpoint 和 terminal event 保存；只有 model/mode/topic 变化时不重写 messages。
5. 对 `saveSessionMetadata` 的现有调用逐一分类，不要机械替换。
6. 保留 `saveSession()` 用于 create、migration、terminal authoritative snapshot。

### 后续可选方案

如果定向 UPDATE 仍不足，再考虑单独的 `session_messages` 表或 append-only turn/block 表。该方案需要 schema migration、分页读取和兼容旧数据，不应与第一步一起做。

### 必须新增的测试/测量

- 用 fake storage 统计 streaming 期间各方法调用次数。
- model/mode/topic 更新不得调用 full message checkpoint。
- crash checkpoint 最多丢失一个 throttle window。
- terminal/dispose 后 DB 与内存完整一致。
- 10,000 blocks 的序列化次数有明确上限，而不是随事件数线性增长。

## P1-3：App Token 与登录 Session 权限边界（已完成）

完成结果见 3.12；以下为整改前问题、兼容性要求与原始验收设计。

### 当前问题

- `src/auth.ts` 仍是模块级 singleton：`Map<token, expiresAt>` + 单一 storage 指针。
- SQLite `auth_sessions` 只有 token 和 expires_at，没有 principal 类型或 scopes。
- App token 是 `HMAC(appSecret, password)`，可用于 `/api/login` 换取普通全权限 cookie。
- Bearer app token 也被通用 `requireAuth` 接受。
- 因此 App token 实际接近管理员密码权限，可访问 settings、重启、更新、环境变量 reveal 等敏感操作。

### 兼容性调查（先做，不能跳过）

在改变行为前搜索以下客户端：

- `browser-extension/`
- `android/`
- `ios/`
- `macos/`
- Web UI 中 app connect code/login 调用

列出它们实际调用的 API，区分：

- 正常 session/chat/file 操作
- password vault / browser extension 操作
- settings/admin/restart/update 操作

### 推荐的兼容迁移

1. 定义认证 principal：
   - `browser-admin`
   - `connected-app`
2. 给 `auth_sessions` 增加 `kind`/`scopes` 列；老 session 默认 `browser-admin`，避免升级后踢掉浏览器登录。
3. `createSession` 接收 principal 信息。
4. 新增返回 principal 的认证方法，而不只是 boolean `validateSession`。
5. 密码直接登录创建 admin session。
6. App token 登录创建 restricted connected-app session。
7. Bearer app token直接映射为 connected-app principal。
8. 增加 `requireScope` / `requireAdmin`。
9. 至少下列路由应要求 admin：
   - 修改密码
   - settings 读写及证书上传
   - restart / update / update channel
   - environment preview 的 `reveal=1`
   - app connect code 再签发
10. 普通 session/chat/file 路由按客户端需要授予明确 scope。

### 必须新增的测试

- 旧 browser session migration 后仍可使用。
- 密码登录可访问 admin 路由。
- connected app 可访问声明的客户端路由。
- connected app 访问 admin 路由得到 403，而不是 401。
- 密码修改撤销两类 session 和旧 app token。
- malformed/expired/跨 storage token 均拒绝。

### 更大的安全迁移（需要单独设计）

当前密码、appSecret 和 password vault 数据仍以明文形式存在 SQLite 中，只靠文件权限保护。若要做真正的静态加密，需要先决定外部密钥来源（macOS Keychain、Linux Secret Service、用户主密码或部署 secret）。把加密 key 与密文一起存在同一 DB 不提供实质保护。

密码哈希也与现有 app token 派生方式耦合。建议最终改为：

- 登录密码只存 scrypt/Argon2 verifier。
- connected-app token 改为独立随机 token，只保存 hash/metadata，可单独吊销。
- appSecret 放 OS keychain 或外部 secret。

这部分不要在没有迁移/回滚设计时直接实施。

## P2-1：拆分 `server.ts` 和路由依赖（已完成）

`server-file-routes.ts`、`server-settings-routes.ts` 和 `server-update-routes.ts` 均已完成，结果见 3.13、3.17。

### 当前体积

- `src/server.ts`：约 2,093 行
- `src/server-session-routes.ts`：约 1,437 行
- `src/process-manager.ts`：约 2,626 行
- `src/structured-session-manager.ts`：约 4,508 行

### 推荐拆分顺序

先提取低耦合路由，不要先拆生命周期核心：

1. `server-file-routes.ts`（已完成）
   - directory
   - file preview/raw/write
   - folders/quick paths/recent paths/validate path/file search
2. `server-settings-routes.ts`
   - config/settings/models/env preview
   - 等 P1-3 auth scope 完成后再提取，避免重复改两次接口
3. `server-update-routes.ts`
   - APK/DMG metadata/download
   - package/provider CLI updates
4. 保留在 `server.ts`：
   - app/server 构造
   - middleware 顺序
   - auth wiring
   - HTTP/HTTPS/WSS 构造
   - manager wiring
   - lifecycle/close/restart

每个模块采用显式 dependency object，例如 config/storage/path helpers；不要引入全局 service locator。

### 注意事项

- `app.use('/api', requireAuth)` 的位置决定哪些路由公开，拆分时不能改变注册顺序。
- `jsonErrorHandler` 必须仍然最后注册。
- route-specific body parser 必须在 global parser 之前。
- `server.ts` 和 `server-session-routes.ts` 都包含用户原有改动，提取时应小步进行。

## P2-2：Session owner / Repository façade（已完成）

### 当前问题

路由层经常需要按顺序查询：

1. StructuredSessionManager
2. ProcessManager
3. SQLite fallback

worktree 状态已经通过两个 manager 的 canonical API 修复，但 model/mode/topic/delete/list 等仍存在相似 owner 判断和重复分支。

### 推荐实现

新增轻量 `SessionRegistry` 或 `SessionRepository` façade，只负责 ownership 和持久化协调，不负责运行 provider：

- `get(id)` / `getLatest(id)`
- `listSlim()`
- `ownerOf(id)`
- `updateWorktreeState(...)`
- `delete(...)`
- 可能的 `setTopic(...)`

不要立即把 ProcessManager 与 StructuredSessionManager 合成一个巨型类。runner 生命周期差异很大，先统一查询/路由层即可。

### 测试

- Structured/PTY/storage fallback precedence。
- 同一个 ID 不会被两个 owner 同时更新。
- manager 内存更新后不会被旧 SQLite snapshot 覆盖。
- delete 的 provider history ownership 保持现有行为。

## P2-3：Git 操作从同步子进程迁移到异步（已完成）

### 当前问题

`src/git-utils.ts` 和 worktree/quick commit 的部分调用仍使用 `execFileSync`。现在已有 timeout、maxBuffer 和非交互保护，但一次慢 git 操作仍会阻塞整个 Node 事件循环。

### 推荐路径

- 新增 Promise 版 `runGitAsync`，使用 `execFile`/`spawn`，保留相同 timeout、env、maxBuffer 和错误格式。
- 先迁移 HTTP 请求触发的操作：status、push、tag、merge、quick commit。
- 启动期或极短的只读探测可以暂时保留 sync。
- worktree rollback 必须保持串行，不要并发执行 checkout/reset/abort。
- 请求断开时可考虑 AbortSignal，但回滚动作不能被客户端断开中止。

## P2-4：desired config 与 live runtime config 分离（已完成）

### 当前问题

settings 更新 host/port/https/shell 后会写配置并返回 `restartRequired`，但当前 runtime config object 也会被 `Object.assign` 更新。监听 socket 仍使用旧 host/port/https，API 却可能展示新值，形成 desired/live 状态混淆。

### 推荐实现

- 部署字段写入 `desiredConfig`，不修改当前 server 的 live listener state。
- settings 响应同时返回：
  - persisted/desired value
  - active/live value
  - `restartRequired`
- 热偏好字段继续即时更新 live config。
- restart 后两者自然一致。

## P2-5：AuthService 实例化（已完成）

即使已修复 storage swap cache，`src/auth.ts` 的模块级 singleton 仍不支持同一进程同时启动两个 server。完成 P1-3 principal/scopes 后，建议将 sessions、storage 和 cleanup timer 收进 `AuthService` 实例，由 `startServer` 创建并注入 middleware/WS manager。

## P3：进一步的结构和性能工作（已完成）

以下项目均已完成，实现结果见 3.18、3.19 和 `docs/server-performance-evaluation.md`：

- Structured provider adapters 拆分为 Claude SDK、Claude CLI、Codex、OpenCode 独立模块。
- ProcessManager 中 Claude/Codex history scanning 从运行管理中拆出。
- 为 Session snapshot/message transport 建立明确 DTO，避免直接广播完整内部对象。
- 增加长会话基准：10k blocks、数 MiB output、多个慢 WebSocket 客户端。
- 对 archive/history scan 做增量索引，减少启动时同步目录扫描。
- 评估把同步 SQLite 移入 worker thread；只有定向 UPDATE 仍不足时再做。

## 6. 下一会话建议执行顺序

1. 读取本文和当前 diff，保留所有未提交用户改动。
2. P1～P3 无遗留实施项；仅在出现新的 profiling 数据或产品需求时按第 3 节结果继续演进。
3. 修改后全量运行：

```bash
npm run check
npm test
git diff --check
```

6. 更新本文的进度、验证数字和下一起点。

## 7. 当前新增/重点测试文件

第一阶段新增并应持续保留：

- `tests/cert.test.ts`
- `tests/express-async.test.ts`
- `tests/git-worktree-merge.test.ts`
- `tests/lifecycle.test.ts`
- `tests/process-manager-safety.test.ts`
- `tests/request-limits.test.ts`
- `tests/security-hardening.test.ts`
- `tests/server-file-routes.test.ts`
- `tests/session-logger.test.ts`
- `tests/session-persistence.test.ts`
- `tests/settings-config.test.ts`
- `tests/storage-session-options.test.ts`
- `tests/structured-session-concurrency.test.ts`
- `tests/worktree-merge-state.test.ts`
- `tests/ws-broadcast.test.ts`

相关已有测试也必须继续跑：

- `tests/git-quick-commit.test.ts`
- `tests/opencode-structured.test.ts`
- `tests/update-helper.test.ts`
- `tests/config-preferences.test.ts`
- `tests/models-endpoints.test.ts`
- `tests/session-history-dedupe.test.ts`

## 8. 完成标准

每一项整改至少满足：

- 不覆盖用户已有未提交修改。
- 有针对原 bug/瓶颈的测试，而不只是类型检查。
- lifecycle 路径不丢最后状态/日志。
- 失败路径不会留下 child、timer、merge state、DB transaction 或异步写队列。
- `npm run check` 通过。
- `npm test` 全部通过。
- `git diff --check` 通过。
