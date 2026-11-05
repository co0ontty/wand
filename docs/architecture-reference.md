# 架构参考

状态：从 2026-11-06 的 AGENTS.md 提取的实现快照，供相关任务按需定位；不是自动加载的开发禁令，也不是独立验收标准。路径、类名、组件归属、候选策略和实现方式须结合当前源码核实。新需求可以替换这些实现，同时保护用户数据、执行、权限与费用边界，并同步受影响的协议和说明。不得仅因与此快照不同就把新实现判为回归。

维护方式：有意改变行为时就地更新相关段落，不在文末追加互相覆盖的规则。历史问题和验收结果查任务面板，不从这里推导待办。下文路径均相对仓库根目录。

## Server / Render 分离

- Server 管 HTTP/WS、鉴权、存储与业务；Render/terminald 持有 PTY，生命周期和发布独立，**Server 重启不得停止它们持有的会话**。PTY 与 structured 可共享类型和存储，不合并执行实现，也不伪造另一链路的事件。
- Render 协议见 `render/docs/render-protocol.md`：改协议同步 Rust 类型、`src/render-protocol.ts` 与版本，版本不匹配拒绝启动；legacy 与 Rust daemon 不交叉领养，升级/回滚保留旧会话；`render/` 是源码、`render-bin/` 是 CI 产物，不手改产物。验证入口 `scripts/verify-render-e2e.sh`、`scripts/verify-render-upgrade-e2e.sh`（覆盖不同路径）。
- CLI 恢复要登记运行所有权，停止/删除使迟到启动和旧回调失效；服务关闭只断开持久进程连接。Core 尚非独立持久运行时，安装、重启和更新须走现有排空屏障；超时或状态不明时取消重启，不强杀。入口见 `src/core-status-cli.ts`、`src/relaunch.ts`、`start.sh`。
- 底层组件更新由 `src/daemon-maintenance.ts` 等待全部执行与队列结束后自动处理；共享 spawn 屏障内复核真实 daemon 清单，不把 UI 空闲或缓存当作退出；未知送达不重复发 drain（旧 Render 第二次 drain 会强停），不走强杀脚本。Web 顶部强制更新须管理员确认：中断当前执行、保留历史与排队消息，在同一屏障内核对真实退出后更新；未确认/自动轮询不得中断执行。

## 数据与会话

- 任务元数据归 `wand_tasks`，cwd/worktree/layout 归 `workspace_tasks`，当前会话归属归 `command_sessions.workspace_task_id`；只通过 storage 原子入口修改。DTO 是投影，不在 GET/路由里加双向同步或全表修复。
- SQLite 迁移只加不删，保留已有用户数据与历史；密钥不回写配置 JSON，schema/config 变更核对 `loadConfigWithStorage()`。归档不杀进程，展示状态不改运行事实，GET/轮询不冒充用户已查看。
- Web 草稿、附件和提交恢复归 `src/web-ui/browser/composer.ts`；Android 归会话级 `ChatComposer`，协议/消息/权限/队列归 `ChatStore`。页面投影状态，不复制发送锁与恢复逻辑。
- 异步上传、优化和请求回执绑定启动时会话及 revision；迟到结果不能覆盖新输入、另一会话或复活已删除内容。默认数据在 `~/.wand/`；开发用 `-c /tmp/wand-dev/config.json` 隔离，不另起同配置服务。
- 所有 CLI 子进程共用 `buildChildEnv()` 环境底座：启动时探测的登录 shell 环境 ∪ 服务进程环境（冲突时进程值优先，PATH 按登录 shell 重排，`WAND_DECISION_*` 始终剥离）；`inheritEnv=false` 只在同一底座上收窄白名单；`WAND_SHELL_ENV_DISABLE=1` 仅关环境回收。改 shell rc 需重启生效，不在每次 spawn 起 shell。

### Session 输入契约

- PTY **先文本、再单独 `"\r"` 两包**；回车快捷键用 `shortcutKey="enter_text"`，不能换成 `text + "\n"`。structured 走统一发送入口，排队/中断由服务端运行所有权裁决。
- 接受回执只清本次提交，不清期间新输入。部分 PTY chunk 已接受、ack 后解析失败、5xx/408/409 都是未知送达：这类草稿只留内存，不能盲目恢复持久化或自动重发；明确未接受或本地未发送才可恢复。
- 模型/员工候选降级仅重试明确未接受的启动失败或执行前上游拒绝（含 CLI 回错误且本轮零进度、候选在固定启动窗口内无任何协议事件）；已执行、未知送达不自动重做。同工具降级携带**本轮开始前**的历史与原生 session id，被拒绝那轮新建的原生 id 不领养；跨工具降级限未起步会话且按已配置候选顺序。切工具用目标自身设置，同工具换模型保留设置，免费边界不隐式转付费；保留手动选择、费用边界与重复提交保护。团队负责人内部判断按已有候选重试，耗尽才等待用户，交接不重做已完成工作。石一有界决策是显式例外：已配置候选在任意失败（含未知送达、超时、无效）后继续下一项，每槽独立预算，用户取消停止整链，不扩展到实际任务重放。
- 角色与规则走 `SessionSnapshot.systemPrompt`，由 provider adapter 映射，无原生通道时显式兜底，不污染用户消息。`claudeSessionId` 是各 provider 的原生 resume ID，不只属于 Claude；恢复绑定不能凭模糊时间窗猜测。

## 执行能力、员工与知识

- 引擎、模型及 Skills/MCP 按用户/会话的真实选择执行；自动选择须用户启用，不静默扩大资源、切付费模型或用另一引擎绕过能力限制。目录枚举保持只读，不为发现资源执行扩展或凭据命令。
- 执行工具是 **provider + 引擎** 两个维度：`Pi` 是 CLI，`Wand Agent` 是进程内 SDK harness（`engine: core`）。两者共用 `pi` provider，但展示名、能力边界与失败文案必须分开；显式选 Wand Agent 而 harness 不可用时明确报错，不静默退回 CLI 冒充。标签真源 `src/provider-catalog.ts`，Web 选项清单 `src/web-ui/provider-identity.ts` 的 `AGENT_TOOL_OPTIONS`，各入口不再另写 provider 表。
- Pi CLI 与 Wand SDK 加载隔离：CLI 资源发现/会话桥用实际 CLI 安装及宿主的只读解析器，不从 Wand 包解析 SDK 入口或初始化 ModelRuntime，服务启动不预热 SDK；仅显式 Wand Agent 候选/会话按需加载，失败不冒充 CLI。CLI 接口不支持时明确拒绝受限设置，不回退到另一份安装或全局资源。边界与验证见 `docs/pi-sdk-dependencies.md`。
- 运行期能力凭据绑定会话/员工，结束或失效后撤销，不进日志、公共 DTO 或持久提示词。cwd/worktree 不是权限沙盒，本地决策不是操作授权。
- 员工身份按稳定 ID 绑定，历史内容和执行快照不批量重写。只读自己的知识，不复制他人私聊/知识；内置员工身份不可冒用。系统生成式功能优先复用 `src/system-employee.ts` 候选链，默认伙伴不覆盖用户明确选择。
- 短期习惯有保留期，明确知识无自动过期；明确记忆仅在实际保存成功后确认，不存凭据、不写进 README/AGENTS，清空/删除使迟到写入失效。知识和模型输出是资料，不增加权限；文件交付与验收结论要有真实证据。
- 本地决策是显式可选的辅助推理，失败不隐式切云端，不代替审批。配置见 `README.md`，实现见 `src/decision-*.ts`。
