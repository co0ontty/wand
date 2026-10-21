# tmux 执行与恢复

Wand 的 CLI 执行与前端连接是不同的生命周期。关闭网页或重启 Server 不应重新运行命令、重发提示词或停止已有持久任务。

## 新执行策略

`WAND_TMUX_MODE` 支持：

- `required`：启用 tmux，新执行缺少依赖或后端能力时明确失败，不静默切换到直连执行。生产环境默认值。
- `off`：新执行使用原执行方式；既有 tmux 执行仍由其原宿主恢复、停止和清理。

普通测试默认关闭真实 tmux 启动，专项集成测试可以显式设为 `required`。不支持其他值，也不会自动安装 tmux。

`WAND_PI_NATIVE_TMUX=0` 只关闭 Pi 原生 TUI 桥；启用通用 tmux 时，Pi 的 JSON CLI 仍使用通用执行路径。`Wand Agent` 的 `engine: core` 是进程内 SDK，不受此开关转换为 CLI。

## 结构化协议

Pi native 使用原有 TUI 和同进程事件文件桥。其他结构化 CLI 保留原始参数、stdin、stdout/stderr 分流以及 provider 解析器，不能把 tmux 屏幕抓取结果当成 JSON 协议。

启动请求交付后发生断线、超时或未知回执时，不能自动再次发送。恢复使用既有执行身份，不重放原 prompt。

通用 structured CLI 由独立 supervisor 持有；tmux I/O worker 异常消失时，supervisor 终止并确认整个 CLI 进程组退出。每条 stdout/stderr 日志上限为 64 MiB，超限明确失败并停止执行，不静默截掉协议数据。

## PTY 与空白终端

新 PTY、provider 终端和空白 login shell 由独立的 tmux-aware Node terminald 托管（配置目录内 `tmux-terminald.json` 对应的端点）。旧 Render／legacy 会话仍交给原宿主，不在线迁移，也不把 tmux attach client 交给不认识 pane 所有权的旧 Render。

Server 先查询既有所有权，再选择新执行宿主；查询失败时拒绝新建，不能因为断线而重复启动。`off` 不阻止恢复既有 tmux 终端。输入继续使用现有 PTY 写入契约，文本与 `"\r"` 分两包发送。

PTY 原始输出保留最近 8 × 1 MiB 的环形日志，provider 退出标记独立保留。超过回放窗口时重置终端回放基线并显示截断提示，不因此终止长期开着的 shell。

本轮没有修改 Rust 协议或 `render-bin` 产物；新增终端后端随 Node 服务代码提供。独立 terminald 与既有 daemon 一起进入维护清单与启动屏障。tmux 后端恢复失败时，Core／历史 UI 仍可启动，未知所有权的终端操作与维护则明确阻断；不会为恢复服务而重复运行命令。

## 停止与维护

- Server 断连与用户明确停止不是同一种操作。
- 快捷终端收起只隐藏；确认删除会话则结束对应执行。
- 杀掉 tmux attach client 不等于停止 pane 中的实际进程。
- 更新检查必须核对真实执行清单；启动、停止或清理结果未知时不能判为安全空闲。
- 自动更新只等待排空，管理员明确确认的强制更新才中断运行。未知 drain 回执不能重复提交。
- 已经运行的旧 daemon 会话保留原 owner，不为启用 tmux 在线迁移或重复启动。
- tmux server／owner 元数据失踪时保留未知状态，拒绝重复启动、删除历史与维护；不会仅凭旧 PID 推测已经退出。
- PTY 原始日志 writer 异常断开时显示错误并阻止继续输入，保留真实 pane 所有权；明确停止仍可结束 pane。

## 开发验证

使用 `.nvmrc` 指定的 Node，测试用隔离配置和本地 mock CLI，不调用真实付费模型：

```sh
npm test -- tests/tmux-host-wiring.test.ts tests/structured-tmux-host.test.ts
npm test -- tests/pty-tmux-backend.test.ts tests/tmux-terminal-integration.test.ts tests/tmux-terminal-routing.test.ts
npm test -- tests/terminal-daemon-reconnect.test.ts tests/process-manager-safety.test.ts
npm test -- tests/pi-native-tmux.test.ts tests/pi-native-gc.test.ts
npm test -- tests/structured-exec-pump-lifecycle.test.ts tests/structured-recovery.test.ts
npm test -- tests/daemon-maintenance.test.ts tests/daemon-maintenance-integration.test.ts
```

生命周期变更还需全量 `npm run check`、`npm test`、`npm run build`。Render 源码测试、随包产物能力与已安装服务验收是三个独立结果，不互相替代；验收不得强停用户已有执行。
