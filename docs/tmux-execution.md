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

## `wand-st` 执行监视面板

通用结构化执行的 tmux 会话名以 `wand-st-` 开头。用 `tmux attach -t <名称>` 连接后，pane 显示「结构化执行监视」、执行 ID、操作说明及正在启动／运行中／正在停止／退出或失败状态；运行期间每 10 秒显示 CLI PID、已运行时长、stdout/stderr 字节数和距最近输出的时间。即使 CLI 暂时没有输出，也能确认 pane 的用途与状态。

面板实时镜像 stdout/stderr，并标注输出来源；JSON 仍按原始文本显示，终端控制字符会被过滤，UTF-8 跨块解码。监视器只投影显示内容：原始 stdout/stderr 字节继续直接写入各自的协议日志，provider 解析与恢复仍读取日志，不读取 pane。

终端显示独立使用最多 64 Ki 字符待写缓冲，每次最多刷新 16 Ki 字符，并遵守终端 backpressure。输出超过显示容量时，恢复刷新后会明确提示省略的字符数；省略只影响面板，协议日志仍按原有 64 MiB 单路上限处理。终端写入失败会关闭本次监视，不影响 CLI 执行或原始日志。

面板用于观察执行，消息、问答与权限处理仍通过 Wand 提交。`Ctrl-b d` 只分离 attach client；`Ctrl-C` 会转发给当前 CLI 进程组并显示正在停止。pane 仍随 worker 退出而关闭，完成结果保留在 Wand 中，不增加退出后常驻面板。新代码只对更新后的新执行回合生效，既有 worker 不注入、不替换、不重启。

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

## Qoder ACP 会话与回合

普通 Qoder ACP 会话由持久宿主持有独立 CLI 进程；同一会话的后续回合复用原生 session，不同会话不共享进程。`end_turn` 只结束前台回合，投影为空闲；`resident` 表示 owner 仍在，不能用 UI 空闲判断进程退出。系统内部的一次性 AI 调用仍在完成后释放进程。明确停止、删除或原生进程退出才收尾常驻 owner，Server 重启接管原 owner，不重放提示词。

`activeRequestId` 标识宿主执行；`foregroundRequestId` 标识常驻进程内的逻辑回合。运行中普通发送保留在队列，当前轮结束后再交付；只有明确插话或队列提升才立即提交原生输入（原生提问的回答除外）。插话沿用逻辑回合，空闲后的新输入建立新边界，Todo 不借用旧计划。下一轮发送前确认原生模型/模式配置；思考档位不受当前模型支持时，按用户约定采用原生确认的当前默认值（无选项则不覆盖），同步持久化会话档位以供各端选择器展示；审批只映射原生单次允许/拒绝，“本轮允许”仅在当前回合缓存，不建立永久允许规则。

Qoder CLI CN 1.1.82 的原生后台通知在 ACP 中不能可靠回传；实测补发 `session/prompt` 也可能卡在内部通知处理中。因此采用兼容等待，不伪造跨轮通知：通过官方 `--settings` 注入当前进程专属 PostToolUse Hook，使用官方 shell-prefix 包装已批准命令，按原生 taskId/toolCallId/PID 与包装进程的唯一执行 ID 关联。Hook 等待实际子进程 close 回执，向当前回合返回退出码、信号和原生输出路径，再由模型读取结果。读取到输出、PID 消失或超时均不作为成功证据；不重复执行命令，不修改用户/项目的 Qoder 配置或放宽权限。已有 shell-prefix 保留在包装链中。

该兜底有明确取舍：Bash 的原生后台请求在 ACP 中等待完成后才收尾，长期不退出的服务也会持续等待，用户可停止；它不是完整的跨轮后台对话支持。等待由持久 worker 持有，Server 重启不打断；停止取消等待并使迟到回执失效。普通回合仍可插话、排队、审批；其它客户端沿用既有 tool/result 和运行状态投影。详情及验证记录在 TASK-419。

来源：[Qoder Tools](https://docs.qoder.com/cli/tools)、[Hooks](https://docs.qoder.com/cli/hooks)、[ACP](https://docs.qoder.com/cli/acp)。这是基于官方扩展点的 Wand 兼容处理，不宣称官方已修复 ACP 后台消息投递。
