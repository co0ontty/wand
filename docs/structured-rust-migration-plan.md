# 结构化 CLI 迁往 Rust：分阶段实施计划

状态：**规划，尚未实现**。本文只规划结构化 CLI run；不把 Claude SDK、PTY 聊天投影或 HTTP/WS 业务层算作已迁移。

## 目标与现状

目标是让六个 provider 的**结构化 CLI 子进程**最终由 Rust 持有，并在行为差分通过后逐个迁移流解析。Server 继续拥有鉴权、SQLite、会话 DTO、聊天与权限投影，客户端 REST/WS 契约保持不变。

当前 `src/structured-exec-host.ts` 的 `StructuredExecHost` 是进程托管的 seam：`spawnStructured`、`attachRun`、`adoptRun`、`listRuns`、`forgetRun`。生产 adapter 是 Node `terminald`，它持有子进程与每条流最多 8 MiB 的回放日志；六个 CLI runner 仍在 Node 中解析 stdout/stderr。`claude-sdk` 直接依赖 `@anthropic-ai/claude-agent-sdk`，**不是 CLI run**，Web 重启时会中断，不能因本计划的 CLI 迁移而声称它也获得了 Rust 托管能力。

Render v1 只提供 PTY 方法；`src/server.ts` 因此把结构化 CLI 交给 `terminald`。正在运行的 legacy PTY、Render v1 PTY 和结构化 run 都不能跨 daemon 搬运进程句柄。迁移只改变**新建 run** 的 owner，已有 run 留在原 owner 直到结束。

## 固定的设计决策

1. **先迁托管，后迁解析。** 第一阶段仅替换 `StructuredExecHost` 的 adapter；Node 的 provider argv、JSONL reducer、权限与 DTO 行为不变。这样同一套 runner 测试可以跨新旧 adapter 复用。第二阶段才引入 Rust `ProviderRunner`，逐 provider 差分切换。
2. **不原位升级 Render v1。** 扩展 Rust 协议必须提升 `RENDER_PROTOCOL_VERSION`，同步 Rust 真源、TS 镜像与权威协议文档。新协议使用独立的 v2 socket/token/pid 命名空间；v1 的路径、协议和正在运行的 PTY 保持原样。每个 config 路径在过渡期最多有一个 v1 和一个 v2 Render。Node 按各 daemon 的 inventory 路由，绝不根据 DB 猜测 owner。
3. **保持小的外部 interface。** `StructuredSessionManager` 只依赖现有 `StructuredExecHost`；Rust adapter 内部隐藏帧编解码、分页回放、重连和流控。若截断后的活动流确实需要重建，只给 `StructuredExecProcess` 增加一个携带权威状态的 `onResync` 回调，不把 Rust RPC、游标或双 daemon 选择逻辑扩散到六个 provider runner。
4. **`listRuns` 只列元数据，回放按页读取。** 单次响应不得把所有 run 的日志聚合进一帧；`attachRun` 由 adapter 内部按 stdout/stderr 序号取页并组装 `StructuredRunState`。事件使用 `(runId, incarnationId, stream, seq)` 去重和补洞；先排空两条流，再报告退出。每条流的保留上限先与现有 8 MiB 契约对齐，截断必须显式标记。
5. **回滚只影响新 run。** `structured.processHost`（拟新增，值为 `legacy | rust | auto`）与 `structuredRunner=cli|sdk` 是两种不同选择。初始默认仍是 `legacy`；显式 `rust` 的协议/鉴权/二进制错误必须失败并给出诊断。`auto` 只能在发出 spawn 前、确认 Rust 二进制缺失时选择 legacy；协议/鉴权冲突或 spawn 结果不确定时绝不能在另一 owner 上重试，避免同一输入执行两次。切回 `legacy` 不终止已由 Rust 持有的 run。

以上配置名和 v2 帧字段是实施目标，**目前还不是可用配置或协议**；编码时须同步 `src/config.ts` 的默认值、合并/写回与配置文档。

## 工作包与退出条件

| 阶段 | 范围与交付物 | 退出条件 |
| --- | --- | --- |
| S0 契约与差分基线 | 固定 `StructuredExecHost` 的输入关闭、信号、双流序号、退出、截断、重连语义；录制六 provider 的真实 CLI argv/流/退出夹具，建立 Node-vs-Rust 可复用差分运行器 | 旧 `terminald` adapter 在夹具上全绿；覆盖多字节 UTF-8 跨块、早退、空输出、超长日志、resume、取消与错误 |
| S1 Rust 进程托管 | 在 Render v2 实现子进程、双流有界日志、分页 attach、幂等 spawn、信号/退出和 daemon 重连；Node 增加 Rust 与复合 `StructuredExecHost` adapter | Node reducer/DTO 不变；`structured-exec-daemon` 与 `structured-recovery` 的同一套用例在两种 adapter 下通过；Server 重启后 PID 不变、无重复输出或漏尾部输出 |
| S2 灰度与发布 | 新 run 按 `structured.processHost` 路由，旧 run 按 inventory 领养；先单 provider 内部灰度，再扩大到六个 CLI runner；v2 源码与多平台二进制按 Render/Render-bin 独立发布 | 新旧 run 并存、Server 重启/回滚不杀进程；生产真机连接码验收全部 CLI provider；错误率与 RSS/日志截断指标可见 |
| S3 provider 解析 | Rust `ProviderRunner` 按 provider 逐个接管 argv/JSONL 解析，Node 保留 per-provider 回退 adapter；先处理 Claude CLI `stream-json` 控制协议可行性，再迁其他 provider | 每个 provider 的语义事件/DTO 差分 100% 通过；权限批准/拒绝、`AskUserQuestion`、model/thinking effort、resume、图片和超长输出逐项验收；失败可按 provider 回退 |
| S4 退役 | 待 legacy `terminald` 不再持有旧 PTY 或结构化 run，才停止为新 run 启动它；删除无用 adapter 与测试，保留必要的兼容读路径 | 运行中 inventory 确认空仓；不通过 SIGTERM 杀旧 PTY；全量测试和真实服务端到端验收通过 |

S1 完成时只能说“结构化 **CLI 进程托管**迁到 Rust”，不能说 provider 解析已迁移；S3 完成且六个 provider 的切换门禁通过后，才可以说“结构化 CLI runner 已迁移”。`claude-sdk` 是否改成独立 Node worker 或替换为 CLI 控制协议是另一个决策，不阻塞 CLI run 的 S1–S4，也不应被静默删除。

## S1 的接口与恢复不变量

- `runId = structured:<sessionId>` 在一次会话内稳定；每次真正新建进程生成新的 `incarnationId`。同一 owner 内重复 spawn 不得产生第二个进程；两个 owner 同时报同一 runId 时拒绝自动领养并报警。
- `stdinData` 只写一次并关闭 stdin；stdout/stderr 分别保持严格递增的 `seq`。断线重连先取权威状态，再从两条流的已确认序号补齐；窗口不覆盖缺口时整流重建并显式通知 Node reducer，不把不连续片段伪装成完整回放。
- `listRuns` 不能把有界回放日志塞进 inventory。分页读取和事件缓冲均有上限；超过上限时重新 attach，不无限积压 Node 内存。日志已截断时保留现有 `StructuredSessionManager` 的成功/失败恢复语义。
- 为运行中 run 数量、双流日志和待发送事件设总量估值及新 run 准入门槛；达到门槛时拒绝新建，不为释放内存而杀现有 run。日志、诊断与夹具不得泄露 `env` 中的密钥、用户提示词或连接码。
- `disconnect` 只解绑 Server；明确的单 run `forgetRun`/中断只作用于已确认 owner 的 run。`drain` 不接收新 run，但让旧 run 自然结束；只有显式 `now` 才可批量终止由该 Rust daemon 持有的进程。过渡期不改 legacy daemon 协议版本。
- v2 的鉴权、socket 权限、token 轮换与协议不匹配拒绝策略不弱于 v1。Rust 崩溃后只把确实丢失的 run 标为中断，不将旧 `terminald` 中仍在运行的 run 误判为失败。

## 验证、发布和回滚门禁

开发期运行 Rust workspace 测试、`npm run check`、`npm test`、两种 adapter 的差分夹具和隔离 Render E2E。关键场景包括：Server 重启、Rust/legacy 任一侧单独断线、token 轮换、两个流乱序到达、UTF-8 跨块、超过 8 MiB 的截断、spawn 响应前退出、重复 runId、取消与恢复。发布前在 macOS 与 Linux 的 CI 原生 runner 构建并校验二进制；不得把本地 `target/release` 直接当作 `render-bin` 发布物。

最终验收按仓库约定使用本机已安装服务与私密连接码，逐 provider 检查发起、流式输出、权限/提问、重连、Web 重启和 resume，并确认客户端 REST/WS 帧与旧版一致。正在运行的旧 run/PTY 必须保持 PID 与输出连续；不使用隔离服务替代最终验收。

回滚时先停止把**新 run** 路由到 Rust，保留 v2 daemon 直到其运行中 run 自然结束；旧 `terminald` 与 v1 Render 继续各自持有原会话。只有三个 inventory 都确认无运行中会话，才考虑收敛 daemon 进程与删除兼容代码。任何协议不匹配、未通过差分、或真实服务恢复失败都阻止扩大灰度。
