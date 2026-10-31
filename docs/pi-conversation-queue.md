# Pi 对话排队与安全边界插话

本次工作对应会话 `cd187f57-6745-419f-840d-dc660c6a9e75`。用户确认实施后，已在原生 TUI/tmux 路径接通安全边界插话，并通过已安装服务验收。下文先保留改造前的链路分析，再说明本次实际实现。

## 结论

运行中的手工输入现在可以在当前模型回复及其整批工具调用结束后，进入下一次模型请求，无需等待整项任务完成。Pi 的这一语义称为 steering；Wand 原生 TUI 接入已把持久队列连接到这一边界。

已安装服务只读核验：本会话为 `provider=pi`、`engine=cli`、`runner=pi-cli-json`；实际执行所有者位于 Pi native 宿主，`ready.mode=tui`、`hasUI=true`。`pi-cli-json` 是现有 runner 标识，不能据此推断进程仍运行 JSON/print 模式。

## 改造前的链路

1. 客户端经 `POST /api/structured-sessions/:id/messages` 发送，普通发送不带 `interrupt`，服务端将来源标为 `user`。
2. `StructuredSessionManager.resolveInFlightSend()` 核对实际 runner 所有权；运行中且未要求中断时调用 `enqueueInput()`。
3. `queuedMessages` 与 `queuedInputScheduling` 持久化，队列最多 10 条，带重复输入保护，并通过快照广播给客户端。编辑、取回、删除与重排基于预期文本或队列快照核对。
4. Pi CLI 主要路径启动真正的 Pi TUI，运行于 tmux；同进程扩展把结构化事件写到私有事件文件。当前事件桥只输出事件，没有消费 Wand 待发送消息的通道。
5. 扩展在 `agent_settled` 请求退出；Pi 进程退出后，Wand 结算这一轮并调用 `flushNextQueuedMessage()`。该函数在 `inFlight` 时直接返回。因此 CLI 新消息要等整轮结束，之后再启动/续接下一轮 CLI。
6. 队列的“立即发送”走 promote：先移除该项，再中断当前 runner，等退出后发送，保留剩余队列。这是显式中断，与安全边界插话不同。

自动任务还受员工并发与优先级调度控制。不能把“同一会话运行中追加输入”与“另一个任务等待员工空闲”混为同一种队列。

源码入口：

- `src/server-session-input-routes.ts`：消息和队列 HTTP 入口。
- `src/structured-session-manager.ts`：`resolveInFlightSend`、`enqueueInput`、`flushNextQueuedMessage`、`runStructuredStreaming`。
- `src/pi-native-event-bridge.ts`、`src/pi-tmux-host.ts`：原生 TUI、事件桥与持久执行所有权。
- `src/structured-pi-adapter.ts`：CLI 参数、协议事件投影与退出结果。
- `src/employee-input-scheduling.ts`：用户/任务来源和优先级元数据。

## Pi 原生语义

核对安装的 Pi 1.4.0 文档及实现：

| 输入方式 | 生效时机 |
| --- | --- |
| `steer` | 当前 assistant turn 及该 turn 的工具调用全部完成后、下一次模型请求之前 |
| `followUp` | 当前 agent run 的工具与 steering 已处理完、原本准备结束时 |
| `abort` | 取消当前运行；不是普通插话 |

原生 TUI 中，执行时 Enter 对应 steering，Alt+Enter 对应 follow-up。默认 steering 为 `one-at-a-time`。

“一个 turn”是一轮模型请求及其工具调用，不是整个用户任务，也不是单个工具结束事件。并行工具必须全部结算；CodeMode 内部完成一个子工具，不等于外层调用已经结束。长命令、长推理或等待中的工具仍会影响插话延迟，无法保证立即响应。

`agent_end` 不是可靠的最终空闲信号：重试、压缩和后续工作仍可继续。现有桥在 `agent_settled` 退出符合 Pi 的生命周期要求，不能通过提前把 `agent_end` 当结束来伪造插话。

参考安装目录中的 `docs/usage.md`、`docs/sdk.md`、`docs/extensions.md`、`docs/rpc.md`，以及 `dist/core/agent-session.js` 和 `pi-agent-core/dist/agent-loop.js`。

## Wand Agent 已有能力

`engine=core` 的进程内 SDK 路径已经实现安全边界插话：

- `core-runner.ts` 在可等待的 `finishTurn` 完成后调用 `context.takeSteering()`。
- 会话管理器同步保存上一段 assistant、移除待发送项并追加 user turn，再交给 `agent.steer()`。
- 一次消费一条；优先用户输入，没有用户输入时才取其他队列项。
- 清空下一段流式累积，避免后续回复覆盖上一段。
- 已取消、失败、请求失效或 Core 排空时不领取消息。

这是单进程同步持久化边界，不能直接照搬成跨进程的“取出后调用一次 API”。用户明确选择 Pi CLI 时，也不能为了插话静默改成 Wand Agent。

## CLI 接入约束

此外，当前 `pi-event-projection.ts` 与 `pi-protocol-reader.ts` 将 user 事件正文压缩为角色标记，适配器只累计 assistant 输出。即使把消息送进 Pi，还必须补齐输入身份、消费回执与 transcript 分段，否则多条输入可能丢失、重复发送或把多段回复混到一起。

本次保持原生 TUI/tmux 所有权，由原生事件桥在安全边界领取服务端队列项。使用 Pi 官方可等待的 `turn_end` boundary drafts，追加 `custom_message` 并请求继续；Pi 将这种消息映射为模型的 user 输入。没有调用缺少接收回执的 `sendUserMessage()`。

实现应具备以下契约：

1. 每条输入有稳定身份，并绑定会话、当前 request 和实际执行 incarnation；文本或数组下标只能校验展示快照，不能单独承担跨进程去重。
2. 区分待发送、正在交接、已进入原生上下文，以及交接结果未知。两侧持久记录可核对；未知不自动重发。
3. 已领取项不能继续作为普通可重排、可取回项；所有操作仍由服务端原子校验。退出与最后一条输入竞争时，只能由一个执行所有者处理。
4. 真实消费时持久化 user turn，保留前一段 assistant 及完整工具结果；随后的流式回复追加到新输入之后。
5. Server 重启后沿原生执行身份重连，对账未完成交接；保留 CLI 跨 Server 重启执行能力。旧桥或不支持的 CLI 继续采用整轮后发送，并如实投影能力。
6. 保持 Pi CLI 与 Wand SDK 加载隔离；不修改全局 Pi 安装，也不把现有 TUI 静默替换为 RPC。

## 推荐的产品行为

- 普通发送：支持的 Pi 运行中输入默认在下一安全边界插入，每个边界取一条；空闲时直接执行。
- 消息含义：补充与纠正影响当前任务；是否替换目标由输入本身决定。插入消息不自动清空先前任务。
- 显式立即发送：继续保留强制中断语义，供不能等待当前工具结束的场景使用。
- 自动任务派发、不同任务的员工并发队列：保留各自调度契约，不因本次普通对话插话改成并发执行。
- 时机使用真实生命周期，不做关键词分类，也不额外调用模型判断是否适合插话。
- Web/macOS/iOS/Android 根据服务端实际能力与交接状态显示文案，不能只用 `provider === pi` 推断。现有 Web、macOS、iOS 的 steering 提示只对 `engine=core` 生效，Android 也需核对输入和队列状态的对应表现。

示例：A 正在检查文件，用户补充 B“先不要改数据库”；当前模型发出的整批读取工具结束后，下一次请求同时看到工具结果和 B，于是后续行动按新约束继续。无需等 A 整项任务完成。

## 实施前的验证

梳理阶段执行：

```sh
```

结果：29 passed，0 failed，0 skipped。使用实际安装 CLI 的扩展门面和本地 fixture；没有调用真实付费模型。梳理阶段命令环境 Node v26.10.0，构建基线为 v24.21.0；后续实施验证见下节。

设计时制定的验收目标：

- 当前工具未结束前不会插入；工具全部结束后，下一次真实本地 fixture 模型请求可见新输入，且无需启动第二个 CLI。
- 连续两条输入按规则分别消费，原生记录与 Wand 消息顺序一致；编辑/取回与领取竞争不会覆盖新内容。
- 最后一个 turn、`agent_settled` 与新输入同时发生时，不丢失、不双发。
- 不经异步 input 管线盲目发起插话；使用官方 boundary drafts 提交已被 Wand 接受的原文，回执以原生记录为准，不把扩展门面返回当消费确认。
- 交接前后 Server 退出并恢复、CLI 异常退出、事件文件异常、取消与重复请求，均保留可核对状态；未知送达不重放。
- Web/macOS/Android/iOS 的队列、已追加输入、强制中断与未知状态一致。
- 共享存储/生命周期改动跑完整 check/test/build；原生端按项目约定构建与交付；最终使用已安装服务验收。

## 本次实现与实际验收

- `pi-native-input.ts`：每次边界一个私有文件邮箱，request/response/claimed/committed/closed 标记区分阶段。输入身份绑定真实 incarnation，队列预留先落 SQLite，再发布 response；Pi 原子领取后才追加原生上下文。
- `pi-native-event-bridge.ts`：当前 assistant 及整批工具结束后发出边界请求；每次最多领取一条手工输入。自动任务仍按整轮后派发。官方 boundary commit 后，通过原生 branch 中的精确 inputId 确认，回报 `wand_input_committed`。
- 管理器在 commit 时原子保存前一段回复、追加 user turn 并移除对应预留项；流式回复按独立 messageId 定位，恢复回放不会覆盖其他段。交接中拒绝编辑/取回/重排；未知送达保留原文 notice，不自动重放。确认未领取的项保留队列。显式停止、已确认运行丢失也按未知状态处理。
- 出现 commit 后事件丢失时，只在确认进程退出后按精确 inputId 查询该执行的原生会话记录；无法证明时仍为 unknown。
- `DaemonAdmission` 透传新控制接口，并修复恢复 checkpoint 参数透传。Web/macOS/iOS/Android 读取 `structuredState.inputMode`；旧原生桥或旧 CLI 不报插话能力时，继续显示整轮后发送。
- 旧进程已经加载旧桥，保持原行为；新启动的 Pi 原生回合使用新桥。无需重启 Render、terminald 或已有 Pi 会话。

本机已通过 `~/start.sh --no-build` 安装本次构建并重启 Server，保留 Render/terminald。`scripts/verify-pi-steering-delivery.mjs` 经已安装服务真实 HTTP 输入接口，使用临时本地零费用 fixture provider 验收：三次模型请求、同一 Pi PID、两次安全边界插话、队列归零、六条用户/助手消息严格交替。临时 provider 已移除；没有真实付费模型调用、设备安装或源码 push。

最终验收会话 `5f3273f4-4fad-4077-8141-c116ab6df0a1`；此前一次通过会话 `1f94fe23-0fc2-45ac-983a-6bae40de2ee6` 保留历史；结果 `output/pi-steering/installed-acceptance.json`。独立集成测试还覆盖中途 dispose 并重建 Server 管理器后续跑。故障用例覆盖未领取超时、已领取未确认、事件丢失对账、重复回执、取回编辑竞争及停止。

Web 的专用 Chrome 验收在桌面、390px、320px、native-shell、reactUi=0、reduce-motion 六种模式通过，能力提示正确、Portal 和关闭路径正常、发送按钮不位移；结果 `output/pi-steering/browser-focused.json`。广域旧面板脚本另有超时，不将专用通过冒充广域全绿。

本轮 `check`、服务端 `build` 与预算门禁通过。默认全量：4110 项，3994 passed、114 skipped、2 failed；两项为日志回放时间门限和 150ms 子进程 stdout 时序，独立重跑 11/11 通过。受控并发全量：4112 项，3996 passed、115 skipped、1 failed（独立钉钉浏览器用例 35s 超时），该用例单独重跑通过。不能把这些结果写成全量一次全绿。原生构建与分发进度、最终证据在 `output/pi-steering/REPORT.md` 和对应任务面板记录。
