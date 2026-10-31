# tmux 执行与恢复

Wand 的 CLI 执行与前端连接是不同的生命周期。关闭网页或重启 Server 不应重新运行命令、重发提示词或停止已有持久任务。

## 新执行策略

`WAND_TMUX_MODE` 支持：

- `required`：启用 tmux，新执行缺少依赖或后端能力时明确失败，不静默切换到直连执行。生产环境默认值。
- `off`：新执行使用原执行方式；既有 tmux 执行仍由其原宿主恢复、停止和清理。

普通测试默认关闭真实 tmux 启动，专项集成测试可以显式设为 `required`。不支持其他值，也不会自动安装 tmux。最低要求 tmux 2.9+（以支持 pane 管道分流与用户元数据选项）。启动期通过 `probeTmuxSupport()` 自动检查二进制与版本，健康时在启动日志输出运行时版本与可执行路径，缺失或版本不足时明确告警并阻断新执行，不退回未受保护的裸进程执行。

`WAND_PI_NATIVE_TMUX=0` 只关闭 Pi 原生 TUI 桥；启用通用 tmux 时，Pi 的 JSON CLI 仍使用通用执行路径。

`Wand Agent`（`engine: core`）保留进程内 SDK 执行，不纳入 tmux 持久执行范围，不要求正在运行的回合或工具调用跨 Server 重启续跑，也不通过上述开关转换为 CLI。这是已确认的产品边界，不属于 tmux 链路待补能力。历史持久化与未知送达不重放的契约继续适用；计划内安装、更新和重启仍须经过 Core 排空屏障，超时或状态不明时取消重启，不强杀。

## 默认 tmux 入口

所有新 CLI 执行（Pi 原生、Claude/Codex 等结构化 CLI、PTY 与空白终端）统一使用当前用户的默认 tmux server，可直接用 `tmux ls` 查看，使用 `tmux attach -t <名称>` 连接。不会按项目或执行类型新建私有 tmux socket；遵循用户的 `TMUX_TMPDIR`，显式选择 `default` 避免从其他 tmux 会话内启动时误入其 server。

执行元数据记录实际 pane ID，兼容用户自定义窗口与 pane 起始编号。Wand 只修改自身会话的选项，停止时校验所属会话与进程，不修改全局选项、不停止共享 tmux server。旧记录的独立 socket 只用于完成迁移期间恢复和停止既有执行，新回合始终使用默认入口。

Claude 等通用结构化 CLI 继续使用原有 JSON 协议与管道输出；默认 socket 不改变执行协议，也不将其伪装成原生交互界面。实例仍按执行回合创建，历史与 native session ID 持久保存。

## 结构化协议

Pi native 使用原有 TUI 和同进程事件文件桥。其他结构化 CLI 保留原始参数、stdin、stdout/stderr 分流以及 provider 解析器，不能把 tmux 屏幕抓取结果当成 JSON 协议。

启动请求交付后发生断线、超时或未知回执时，不能自动再次发送。恢复使用既有执行身份，不重放原 prompt。

通用 structured CLI 由独立 supervisor 持有；tmux I/O worker 异常消失时，supervisor 终止并确认整个 CLI 进程组退出。每条 stdout/stderr 日志上限为 64 MiB，超限明确失败并停止执行，不静默截掉协议数据。

## PTY 与空白终端

新 PTY、provider 终端和空白 login shell 通过 tmux-aware Node terminald 连接默认 tmux server（配置目录内 `tmux-terminald.json` 对应的是 Wand 内部通信端点，不是另一个 tmux server）。旧 Render／legacy 会话仍交给原宿主，不在线迁移，也不把 tmux attach client 交给不认识 pane 所有权的旧 Render。

Server 先查询既有所有权，再选择新执行宿主；查询失败时拒绝新建，不能因为断线而重复启动。`off` 不阻止恢复既有 tmux 终端。输入继续使用现有 PTY 写入契约，文本与 `"\r"` 分两包发送。

PTY 原始输出保留最近 8 × 1 MiB 的环形日志，provider 退出标记独立保留。超过回放窗口时重置终端回放基线并显示截断提示，不因此终止长期开着的 shell。

本轮没有修改 Rust 协议或 `render-bin` 产物；新增终端后端随 Node 服务代码提供。独立 terminald 与既有 daemon 一起进入维护清单与启动屏障。tmux 后端恢复失败时，Core／历史 UI 仍可启动，未知所有权的终端操作与维护则明确阻断；不会为恢复服务而重复运行命令。

## 停止与维护

- Server 断连与用户明确停止不是同一种操作。
- 快捷终端收起只隐藏；确认删除会话则结束对应执行。
- 杀掉 tmux attach client 不等于停止 pane 中的实际进程。
- 更新检查必须核对真实执行清单；启动、停止或清理结果未知时不能判为安全空闲。
- 自动更新按组件自身执行清单进行：Render / Structured Render 无自有执行时可独立更新，不再等待无关的 tmux、Core 或消息队列。新 tmux terminald 声明 `detachTmuxOnShutdown` 能力，维护时只断开观察器和 attach client，新进程接回同一 pane；旧版本仍须先完成迁移或排空。启动屏障内复核身份和清单，未知 drain 回执不能重复提交。
- 常规组件更新由系统自动安排，无需用户挑选重启时间。Server 重启仍经过 Core 排空；CLI 在 tmux 中持续运行并由新 Server 恢复。tmux 本身与系统更新不在这项无中断保证内。管理员明确确认的强制更新仍可能中断旧宿主执行。
- 已经运行的旧 daemon 会话保留原 owner，不为启用 tmux 在线迁移或重复启动。
- tmux server／owner 元数据失踪时保留未知状态，拒绝重复启动、删除历史与维护；不会仅凭旧 PID 推测已经退出。
- PTY 原始日志 writer 异常断开时显示错误并阻止继续输入，保留真实 pane 所有权；明确停止仍可结束 pane。若底层 tmux server 或 session 确认已失踪，明确停止（kill）操作将权威收敛其状态（exitCode: 137），确保前端能够正常关闭终端并允许后续删除与 forget。
- 废弃记录与死 socket 回收：`StorageCleanup` 与 `PtyTmuxBackend.collectGarbage` 协同工作，安全回收已归档/已删除且确认退出的 pty-tmux 历史日志，并在每次回收时探测并清理 `/tmp/wand-pty-${uid}-*.sock` 下已无服务监听的死 socket，保护长期运行下的磁盘与临时目录。

## 开发验证

使用 `.nvmrc` 指定的 Node 和隔离配置，不调用真实付费模型。生命周期变更还需全量 `npm run check`、`npm run build`。Render 源码测试、随包产物能力与已安装服务验收是三个独立结果，不互相替代；验收不得强停用户已有执行。
