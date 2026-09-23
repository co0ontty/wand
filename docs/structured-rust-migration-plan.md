# 结构化 CLI 迁往 Rust：分阶段实施计划

状态：**S0 限定基线及 S1 独立 v2 托管门禁已通过；S2 分发/灰度未完成，S3 Rust provider 语义解析尚未实现**。本文只规划结构化 CLI run；不把 Claude SDK、PTY 聊天投影或 HTTP/WS 业务层算作已迁移。

## 目标与现状

目标是让六个 provider 的**结构化 CLI 子进程**最终由 Rust 持有，并在行为差分通过后逐个迁移流解析。Server 继续拥有鉴权、SQLite、会话 DTO、聊天与权限投影，客户端 REST/WS 契约保持不变。

当前 `src/structured-exec-host.ts` 的 `StructuredExecHost` 是进程托管的 seam：`spawnStructured`、`attachRun`、`adoptRun`、`listRuns`、`forgetRun`。生产 adapter 是 Node `terminald`，它持有子进程与每条流最多 8 MiB 的回放日志；六个 CLI runner 仍在 Node 中解析 stdout/stderr。`claude-sdk` 直接依赖 `@anthropic-ai/claude-agent-sdk`，**不是 CLI run**，Web 重启时会中断，不能因本计划的 CLI 迁移而声称它也获得了 Rust 托管能力。

Render v1 只提供 PTY 方法；`src/server.ts` 因此把结构化 CLI 交给 `terminald`。正在运行的 legacy PTY、Render v1 PTY 和结构化 run 都不能跨 daemon 搬运进程句柄。迁移只改变**新建 run** 的 owner，已有 run 留在原 owner 直到结束。

## 固定的设计决策

1. **先迁托管，后迁解析。** 第一阶段仅替换 `StructuredExecHost` 的 adapter；Node 的 provider argv、JSONL reducer、权限与 DTO 行为不变。这样同一套 runner 测试可以跨新旧 adapter 复用。第二阶段才引入 Rust `ProviderRunner`，逐 provider 差分切换。
2. **不原位升级 Render v1。** 新增独立的 `STRUCTURED_PROTOCOL_VERSION=2`（TS 镜像为 `STRUCTURED_RENDER_PROTOCOL_VERSION=2`）及权威文档 `render/docs/structured-protocol-v2.md`，不改 PTY v1 的 `RENDER_PROTOCOL_VERSION=1`。v2 使用独立 socket/token/pid；旧 PTY 与 run 仍由原 daemon 持有。Node 按两个 inventory 路由，绝不根据 DB 猜 owner。
3. **保持小的外部 interface。** `StructuredSessionManager` 只依赖现有 `StructuredExecHost`；Rust adapter 内部隐藏帧编解码、分页回放、重连和流控。若截断后的活动流确实需要重建，只给 `StructuredExecProcess` 增加一个携带权威状态的 `onResync` 回调，不把 Rust RPC、游标或双 daemon 选择逻辑扩散到六个 provider runner。
4. **`listRuns` 只列元数据，回放按页读取。** 单次响应不得把所有 run 的日志聚合进一帧；`attachRun` 由 adapter 内部按 stdout/stderr 序号取页并组装 `StructuredRunState`。事件使用 `(runId, incarnationId, stream, seq)` 去重和补洞；先排空两条流，再报告退出。每条流的保留上限先与现有 8 MiB 契约对齐，截断必须显式标记。
5. **回滚只影响新 run。** `structured.processHost` 已增加部署值 `legacy | rust`，默认 `legacy`；与 `structuredRunner=cli|sdk` 不同。显式 `rust` 的协议/鉴权/二进制错误必须失败并给出诊断，不存在隐式 `auto` 跨 owner 回退。同一个 runId 若同时存在于两端 inventory，拒绝领养。切回 `legacy` 不终止 Rust 旧 run。**配置已存在不等于已发布/已在本机服务启用**。

## 工作包与退出条件

| 阶段 | 范围与交付物 | 退出条件 |
| --- | --- | --- |
| S0 契约与差分基线 | 固定 `StructuredExecHost` 的输入关闭、信号、双流序号、退出、截断、重连语义；录制 Codex/OpenCode/Pi/Qoder 的脱敏真实 normal 流，Claude/Grok 静态审查并建立显式 mock；建立可复用差分断言 | 旧 `terminald` adapter 在合成契约夹具上全绿；四家真实 normal 回放与两家 mock 回放通过；UTF-8、早退、空输出、恢复、取消与错误在进程 seam 覆盖。四家真实 resume/异常与 8 MiB 双 adapter 差分仍是后续门禁 |
| S1 Rust 进程托管 | 在 Render v2 实现子进程、双流有界日志、分页 attach、幂等 spawn、信号/退出和 daemon 重连；Node 增加 Rust 与复合 `StructuredExecHost` adapter | Node reducer/DTO 不变；`structured-exec-daemon` 与 `structured-recovery` 的同一套用例在两种 adapter 下通过；Server 重启后 PID 不变、无重复输出或漏尾部输出 |
| S2 灰度与发布 | 新 run 按 `structured.processHost` 路由，旧 run 按 inventory 领养；逐 provider 灰度；v2 源码与多平台二进制独立发布 | 新旧 run 并存、重启/回滚不杀进程；本机服务连接码验收可用的四家 CLI；Claude/Grok 依用户本轮授权只做静态检查与 mock，明确标记真实验收未做；错误率与 RSS/日志截断指标可见 |
| S3 provider 解析 | Rust `ProviderRunner` 逐 provider 接管 argv/JSONL 解析，Node 保留 per-provider 回退 adapter；先处理 Claude CLI `stream-json` 控制协议可行性，再迁其他 provider | Codex/OpenCode/Pi/Qoder 的真实夹具及 Claude/Grok 的**合成 mock** 上语义事件/DTO 差分通过；权限、提问、model/thinking、resume、图片、超长输出逐项核对；未做的 Claude/Grok 真实 CLI 验收不得宣称通过 |
| S4 保留兼容层（待后续删除指令） | 旧 `terminald` / Render v1 / Node provider 回退路径保留并标注迁移期用途；不删除 adapter、测试或兼容读路径，不因新 Rust 路径上线而停止旧 owner | 运行中 inventory 确认旧会话不被迁移误杀；全量测试和真实服务端到端验收通过。实际删除留待用户后续单独提出 |

S1 完成时只能说“结构化 **CLI 进程托管**迁到 Rust”，不能说 provider 解析已迁移；S3 完成且六个 provider 的切换门禁通过后，才可以说“结构化 CLI runner 已迁移”。`claude-sdk` 是否改成独立 Node worker 或替换为 CLI 控制协议是另一个决策，不阻塞 CLI run 的 S1–S4，也不应被静默删除。

## 执行顺序与当前门禁

按 S0 → S1 → S2 → S3 → S4 串行放行，阶段内部可拆分小提交；任何未通过的门禁不允许通过改默认值或直接切生产绕过。S0 的限定基线已完成；`tests/helpers/structured-exec-contract.ts` 同时验证 legacy 和 v2 adapter。S1 已通过共享 adapter 契约、实际隔离 Web 重启 PID/DTO 连续性、socket 重连和 8 MiB 截断/分页故障注入；S2 的多平台产物、四家异常流及已安装服务验收，S3 的 Rust 语义解析均未完成。

1. **S0a（本轮）**：冻结 seam 的可观测语义，建立同一套 fake CLI 契约用例与差分断言；在 legacy `terminald` 跑通。测试数据只用无密钥的合成输入；比较归一化的 stdout/stderr、退出、日志与状态，不比较 PID、UUID、调度造成的 chunk 切分。
2. **S0b（已获用户调整）**：在隔离测试目录采集 Codex/OpenCode/Pi/Qoder 的真实 normal 流并人工脱敏；Claude/Grok 只做静态代码审查、合成 mock 和单测，不要求当下真实运行。resume/取消/错误在共享进程契约与 provider argv/reducer mock 中覆盖；四家真实 provider 的这些异常场景在 S2/S3 切换前补充。差分断言须以故意篡改语义字段的负例自证能报差异。
3. **S1a**：在 `render/` 内先定义 v2 契约与独立路径（含鉴权、额度、分页游标、流 seq 与截断标记），同步 TS 镜像与权威文档并提升新协议两侧版本；运行中的 v1 client/常量、二进制及其 socket/token/pid 保持原样，不原位升级 v1。
4. **S1b**：Rust 实现结构化进程托管、回放和资源准入；Node 实现 Rust adapter，再用 S0 契约和重启/断连/截断恢复用例跑两边。Rust wire-level 的 `listRuns` 只含元数据，但当前 `recoverDetachedRunsOnce()` 直接读取 `listRuns()` 中的 stdout 日志；必须先按 inventory 定位 owner、再为每个待恢复 run 调用权威 `attachRun()` 取分页组装的完整状态，不能把空日志交给 reducer。遇到活动流回放缺口必须可检测并重建，不能只丢尾部。每个 runId 的重复 spawn 与跨 owner 冲突必须经故障注入验证。
5. **S2**：先以默认 `legacy` 加入可控的 `structured.processHost`，隔离验证后再发布并使用本机服务连接码按单 provider 灰度。每次切换验证旧 run/PTY PID、输出及两个 inventory；回滚只调整新 run 的选路。Claude/Grok 仅完成静态与 mock 验证时不能自动扩大到这两家生产灰度。
6. **S3/S4**：逐 provider 迁解析并做 DTO/权限/图片/提问差分，保留回退；旧 inventory 自然清空后仍保留带 `MIGRATION-COMPAT` 标记的 legacy adapter/测试。用户后续要求删除时才另做纯删除提交并跑全量验证。

**S0a 已落地的契约切片**：`tests/helpers/structured-exec-contract.ts` 通过同一 `connect()` 工厂驱动 host，`tests/structured-exec-contract.test.ts` 在 legacy `terminald` 上断言 stdin 一次写入并关闭、resume 参数、运行中/已退出重复 spawn 幂等、双流有序 seq / UTF-8 跨块、快退/空输出/找不到命令、恢复后 PID 与日志、显式取消；差分断言有故意篡改退出码的负例。v2 adapter 已接入**同一个** `captureStructuredExecContract`（`tests/render-structured-client.test.ts`），未复制用例。旧 client 的回放修正为先重放 spawn 快照、再按已观测的序号排除队列中重复事件，且不吞掉「list 快照与 attach 之间」的新增事件；旧 daemon 的已退出 run 在 `forgetRun` 前也不再重复启动。进程 seam 的双 adapter 合成基线及 v2 超过 8 MiB 的分页/截断验证已通过；追加了 CLI 提前关闭 stdin（EPIPE）不能伪报成功的跨 owner 门禁。Render 源码预备版本已提升到 0.1.2；双二进制本机打包、离线 sync、stage/sha256/协议校验仅在 darwin-arm64 及合成其他平台产物上通过；当前锁定的 render-bin v0.1.1 仍只有 PTY v1，尚无四平台 v2 Release，也未做已安装服务验收。这仍不等于六家 CLI 真实流的 Rust 解析差分或发布门禁通过。

**S0b 真实与 mock 的边界**：`scripts/capture-structured-cli-fixtures.ts --record` 在临时空目录调用真实 CLI，只把字段和值都脱敏后的事件写入 `tests/fixtures/structured-cli-recordings/`，不保存原始 stdout、stderr、环境变量或提示词。Codex、OpenCode、Pi 与用户指定的 **Qoder Qwen3.8-Flash** 已取得真实 normal 流，Node reducer 均能回放；Claude/Grok 是手写的 `*-mock.json`，显式标记 `synthetic-mock`，只核对生产 argv 构造、JSONL reducer 与权限/提问/resume 语义，**绝非实测**。本机 Claude CLI 原自定义端点连续 `api_retry`，另一个本机兼容端点短探针 200 但完整 CLI 403；Grok 默认模型超时且备用模型未授权，用户本轮明确允许先不做两家的真实 CLI 测试。四家真实 provider 的 resume/取消/错误在 S2/S3 扩大灰度前仍需补齐；未获许可不得把合成测试写成真实验收。录制命令示例：`node --import tsx scripts/capture-structured-cli-fixtures.ts --record --only=qoder --qoder-model=Qwen3.8-Flash`；只用无工具固定提示，谨慎消耗真实 provider 配额。

**Claude/Grok 静态审查结论及边界**：`src/structured-claude-adapter.ts` 用 `buildClaudeCliArgs` 拼 `-p --verbose --output-format stream-json`、model/effort/`--resume`，提示词通过 `stdinData` 写一次并关闭；权限策略来自 `derivePermissionPolicy`，`ClaudeCliProtocolReducer` 检测 `AskUserQuestion` 后 CLI runner 请求中断并返回 `stopReason`。`src/structured-grok-adapter.ts` 用 `buildGrokArgs` 拼 `--output-format streaming-json`、model/effort/`--resume`，在允许的模式才加 `--always-approve`；`applyGrokEvent` 将 text/thought/tool_call/tool_call_update/end 转成 turn state 并记录 sessionId/usage。合成夹具只证明这些分支在 Node 中自洽，不能证明 Rust 实现已迁移，也不能替代服务端真实权限/提问与网络行为验收。

**用户要求保留的历史兼容层**：`src/render-host.ts` 的旧 PTY 路由及 `src/terminal-daemon-{client,server}.ts` 的 legacy structured adapter 已标记 `MIGRATION-COMPAT`；后续新增 Rust provider parser 时，同样为保留的 Node provider 回退路径加此标记。即使 Rust 迁移完成，本轮也不删除 Render v1、旧 adapter 或测试，不停掉仍持有 run 的旧进程；以后由用户另行要求删除时做独立纯删除提交。

**已知的 S1 设计债（不得误称 S0 已解决）**：legacy `structuredList` 仍内联双流日志，`RemoteStructuredProcess` 断线补齐使用字符长度而非带窗口的 seq，头截断时跳过补齐；v2 需要独立的元数据 inventory / 分页回放 / 可报告的 resync 路径。`claude-sdk` 仍由 Node 持有。S0 测试不得把 legacy 的不完备重连语义包装成 Rust 的目标契约。

## S1 的接口与恢复不变量

- `runId = structured:<sessionId>` 在一次会话内稳定；每次真正新建进程生成新的 `incarnationId`。同一 owner 内重复 spawn 不得产生第二个进程；两个 owner 同时报同一 runId 时拒绝自动领养并报警。
- `stdinData` 只写一次并关闭 stdin；stdout/stderr 分别保持严格递增的 `seq`。断线重连先取权威状态，再从两条流的已确认序号补齐；窗口不覆盖缺口时整流重建并显式通知 Node reducer，不把不连续片段伪装成完整回放。
- `listRuns` 不能把有界回放日志塞进 inventory。分页读取和事件缓冲均有上限；超过上限时重新 attach，不无限积压 Node 内存。日志已截断时保留现有 `StructuredSessionManager` 的成功/失败恢复语义。
- 为运行中 run 数量、双流日志和待发送事件设总量估值及新 run 准入门槛；达到门槛时拒绝新建，不为释放内存而杀现有 run。日志、诊断与夹具不得泄露 `env` 中的密钥、用户提示词或连接码。
- `disconnect` 只解绑 Server；明确的单 run `forgetRun`/中断只作用于已确认 owner 的 run。`drain` 不接收新 run，但让旧 run 自然结束；只有显式 `now` 才可批量终止由该 Rust daemon 持有的进程。过渡期不改 legacy daemon 协议版本。
- v2 的鉴权、socket 权限、token 轮换与协议不匹配拒绝策略不弱于 v1。Rust 崩溃后只把确实丢失的 run 标为中断，不将旧 `terminald` 中仍在运行的 run 误判为失败。

## 验证、发布和回滚门禁

开发期运行 Rust workspace 测试、`npm run check`、`npm test`、两种 adapter 的差分夹具和隔离 Render E2E。关键场景包括：Server 重启、Rust/legacy 任一侧单独断线、token 轮换、两个流乱序到达、UTF-8 跨块、超过 8 MiB 的截断、spawn 响应前退出、重复 runId、取消与恢复。发布前在 macOS 与 Linux 的 CI 原生 runner 构建并校验二进制；不得把本地 `target/release` 直接当作 `render-bin` 发布物。

最终验收按仓库约定使用本机已安装服务与私密连接码，对可用的 Codex/OpenCode/Pi/Qoder 逐家检查发起、流式输出、权限/提问、重连、Web 重启和 resume，并确认客户端 REST/WS 帧与旧版一致；Claude/Grok 本轮经用户许可只做静态分析与 mock，必须在结论中明确标注真实 CLI 路径尚未验收，不能将其纳入生产灰度。正在运行的旧 run/PTY 必须保持 PID 与输出连续；隔离服务只能用于开发期，不能替代上述最终验收。

回滚时先停止把**新 run** 路由到 Rust，保留 v2 daemon 直到其运行中 run 自然结束；旧 `terminald` 与 v1 Render 继续各自持有原会话。即使三个 inventory 都确认无运行中会话，本轮也不删除兼容代码；待用户另行要求时再评估收敛。任何协议不匹配、未通过差分、或真实服务恢复失败都阻止扩大灰度。
