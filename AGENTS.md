# AGENTS.md

Wand 是本机 AI 工作台（Node.js + TypeScript ESM、Express + WebSocket）。本文只保留必要的操作边界和源码入口；功能细节以对应源码、测试和本轮需求为准。

## 工作方式与安全

- 开工检查主仓及涉及子模块的 Git 状态，记录已有改动；增量合并，不 reset/clean、覆盖或自动提交他人的工作。
- 在任务范围内可以重构、调整目录、替换实现或依赖，不必为每个技术选择再次确认。现有实现、历史测试和本文中的入口不是永久设计锁；行为有意改变时同步更新测试与说明，不靠删测试掩盖回归。
- 避免无关改动；证据明确的同类问题一起修。涉及未授权的数据删除、权限或费用扩大、发布、设备安装，以及尚未确定的产品取舍时再确认。
- 不提交或打印密码、token、私钥及其他敏感信息。默认监听回环地址；命令与可执行路径来自可信配置，不把未校验的 HTTP 输入直接当作执行参数。相关边界写在对应配置文档或源码附近，不必全部堆进本文。
- 沿用邻近代码风格：2 空格、双引号、分号，Node 内置模块用 `node:`，ESM 相对导入带 `.js`。高频事件与大输出考虑防抖、取消和有界缓冲。
- 死代码凭引用与运行态证据清理，不能把公开 API、动态标识符、条件样式或迁移兼容项当死代码。需要时用 `npm run audit:remnants`。

## 常用入口

| 领域 | 入口 |
| --- | --- |
| CLI、服务、HTTP/WS | `src/cli.ts`、`src/server.ts`、`src/server-*-routes.ts` |
| 会话所有权、恢复、PTY | `src/session-registry.ts`、`src/session-transport.ts`、`src/process-manager.ts`、`src/terminal-daemon-*.ts` |
| Structured / SDK | `src/structured-session-manager.ts`、`src/structured-*-adapter.ts`、`src/core-runner.ts` |
| 存储、配置、共享类型 | `src/storage.ts`、`src/session-logger.ts`、`src/config.ts`、`src/types.ts` |
| Provider、模型、Pi 资源 | `src/provider-catalog.ts`、`src/model-groups.ts`、`src/pi-session-settings.ts`、`src/pi-resource-*.ts` |
| 员工、团队、记忆 | `src/silicon-employee*.ts`、`src/ai-team*.ts`、`src/employee-knowledge*.ts`、`src/user-memory*.ts` |
| Web / 原生端 | `src/web-ui/browser/`、`src/web-ui/react/`；`android/`、`ios/`、`macos/` |

Node 版本以 `.nvmrc` 为准。只检出需要的子模块：服务端构建用 `git submodule update --init -- render-bin`，改 Render 或原生端时再检出对应目录。查会话问题优先确认 `SessionRegistry.ownerOf(id)`，不要混淆 PTY、structured 和存储快照。

## Server / Render 分离

- Server 管 HTTP/WS、鉴权、存储与业务；Render/terminald 持有 PTY。生命周期和发布独立，**Server 重启不得停止它们持有的会话**。PTY 与 structured 可共享类型和存储，不合并执行实现，也不伪造另一链路的事件。
- Render 协议见 `render/docs/render-protocol.md`；修改时同步 Rust 类型、`src/render-protocol.ts` 和协议版本，版本不匹配时拒绝启动。legacy 与 Rust daemon 不交叉领养，升级/回滚保留旧会话。相关验证入口为 `scripts/verify-render-e2e.sh` 与 `scripts/verify-render-upgrade-e2e.sh`，两者覆盖不同路径。
- `render/` 是源码，`render-bin/` 是 CI 产物。修改源码与更新产物分开，不手改产物；子模块源码可拉取后再更新主仓指针。
- CLI 恢复要登记运行所有权，停止/删除使迟到启动和旧回调失效；服务关闭只断开持久进程连接。Core 尚非独立持久运行时，安装、重启和更新须使用现有排空屏障；超时或状态不明时取消重启，不强杀。入口见 `src/core-status-cli.ts`、`src/relaunch.ts`、`start.sh`。
- 已安装的底层组件更新由 `src/daemon-maintenance.ts` 等待所有执行与队列结束后自动处理；共享 spawn 屏障内复核真实 daemon 清单，不把 UI 空闲或缓存当作退出。未知送达不重复发 drain（旧 Render 第二次 drain 会强停），不走强杀脚本；状态接口只读。Web 顶部提示提供管理员确认后的强制更新：中断当前执行、保留历史与排队消息，在同一屏障内核对真实退出后更新；未确认/自动轮询不得中断执行。

## 数据与会话

- 任务元数据归 `wand_tasks`，cwd/worktree/layout 归 `workspace_tasks`，当前会话归属归 `command_sessions.workspace_task_id`；通过 storage 原子入口修改。DTO 是投影，不在 GET/路由里加双向同步或全表修复。
- SQLite 迁移只加不删；保留已有用户数据与历史。密钥不回写配置 JSON，schema/config 变更核对 `loadConfigWithStorage()`。归档不杀进程，展示状态不改运行事实，GET/轮询不冒充用户已查看。
- Web 草稿、附件和提交恢复归 `src/web-ui/browser/composer.ts`；Android 归会话级 `ChatComposer`，协议/消息/权限/队列归 `ChatStore`。页面投影状态，不复制发送锁与恢复逻辑。
- 异步上传、语音、优化和请求回执绑定启动时会话及 revision；迟到结果不能覆盖新输入、另一会话或复活已删除内容。默认数据在 `~/.wand/`；开发用 `-c /tmp/wand-dev/config.json` 隔离，不另起同配置服务。
- 所有 CLI 子进程（PTY、structured、一次性 git/npm/模型探测）共用 `buildChildEnv()` 的环境底座：启动探测回收的**系统默认登录 shell 环境** ∪ 服务进程环境，冲突时进程值优先，PATH 顺序按登录 shell 重排，`WAND_DECISION_*` 始终剥离。`inheritEnv=false` 只在同一底座上收窄白名单；`WAND_SHELL_ENV_DISABLE=1` 仅关环境回收。改 shell rc 需重启生效，不在每次 spawn 起 shell。

### Session 输入契约

- PTY **先文本、再单独 `"\r"` 两包**；回车快捷键用 `shortcutKey="enter_text"`，不能换成 `text + "\n"`。structured 通过统一发送入口，排队/中断由服务端运行所有权裁决。
- 接受回执只清本次提交，不清期间新输入。部分 PTY chunk 已接受、成功 ack 后解析失败、5xx/408/409 都是未知送达；这类已提交草稿只留内存，不能盲目恢复持久化或自动重发。明确未接受或本地未发送才可恢复。
- 模型/员工候选降级复用结构化失败事实，仅重试当前请求明确未接受的启动失败或执行前上游拒绝；已执行、未知送达不自动重做。普通员工仅首轮换工具，按已配置候选顺序；切工具使用目标自身设置，不要求继承原工具 Skills/MCP/CodeMode，同工具换模型保留设置，免费边界不隐式转付费。团队负责人内部判断仍按已有候选重试，耗尽才等待用户；交接原判断要求与已完成报告，不重新执行已完成工作。保留手动模型选择、费用边界和重复提交保护。
- 角色与规则走 `SessionSnapshot.systemPrompt`，由 provider adapter 映射；无原生系统通道时显式兜底，不随意污染用户消息。`claudeSessionId` 是各 provider 的原生 resume ID，不只属于 Claude；恢复绑定不能凭模糊时间窗猜测。

## 执行能力、员工与知识

- 引擎、模型及 Skills/MCP 按用户/会话的真实选择执行；自动选择须用户启用，不静默扩大资源、切换付费模型或用另一引擎绕过能力限制。目录枚举保持只读，不为发现资源执行扩展或凭据命令。
- 执行工具是 **provider + 引擎** 两个维度：`Pi` 是 CLI（`pi --mode json --print` / PTY 终端），`Wand Agent` 是 Wand 进程内 SDK harness（结构化会话的 `engine: core`）。两者共用 `pi` provider，但展示名、能力边界（会话级 Skills / MCP、CodeMode、恢复方式）与失败文案必须分开，不能共用一个名字；显式选了 Wand Agent 而 harness 不可用时明确报错，不静默退回 CLI 冒充。标签真源是 `src/provider-catalog.ts`（`PROVIDER_LABELS` / `WAND_AGENT_LABEL`），Web 选项清单是 `src/web-ui/provider-identity.ts` 的 `AGENT_TOOL_OPTIONS`，各入口不要再各写一张 provider 表。
- 运行期能力凭据绑定会话/员工，结束或失效后撤销，不进入日志、公共 DTO 或持久提示词。cwd/worktree 不是权限沙盒，本地决策也不是操作授权。
- 员工身份按稳定 ID 绑定；显示信息可以跟随定义，历史内容和执行快照不批量重写。只读自己的知识，不复制他人私聊/知识；内置员工身份不可冒用。系统生成式功能优先复用 `src/system-employee.ts` 的候选链，默认伙伴不覆盖用户明确选择的角色。
- 短期习惯与明确知识分开：前者有保留期，后者无自动过期。明确记忆仅在实际执行且保存成功后确认，不存凭据、不写进 README/AGENTS；清空/删除使迟到写入失效。知识和模型输出是资料，不增加权限；文件交付与验收结论要有真实证据。
- 本地决策是显式可选的辅助推理，失败不隐式切云端，也不代替审批。可信路径配置与部署命令见 `README.md`，实现和回归见 `src/decision-*.ts`、`tests/local-decision.test.ts`。

## Web UI 与多端

- 手改 browser/react、`src/web-ui/content/styles.css` 和构建脚本，不手改打包 JS、tailwind/vendor、`src/web-ui/embedded-assets.ts` 或 `dist/`；通过构建再生成。保留自更新期间的资产回退和正确缓存，预算可以随需求调整，但说明实际加载影响，不绕过门禁。
- 优先复用公共组件、主题与语义 token；布局、尺寸、分包和内部实现可按需求演进，不把历史像素值、展开方向或某一端布局当永久限制。各端对齐协议与行为语义，允许平台差异，不默认 Web 是唯一参考。
- Web React Shell 与 vanilla 会话/终端层仍并存；`?reactUi=0` 只回滚通用对话框/通知，不回滚 Shell。修改相关链路时核对两层适配与受影响的回滚路径。

### 动效与交互

- 遵守适用的全局动效规范；复用 motion token，照顾 reduced-motion、焦点、键盘/返回关闭和窄屏操作。异步失败保留输入，反馈不打断当前操作；不重复堆砌逐组件硬规则。
- Web 公共选择器浮层经 Portal；父表单外点判断识别自身浮层所有权。实际点搜索框/选项验证父级不误关，再验外点与 Escape，不能靠忽略全部外点规避问题。

### Canonical UI Map

`premium-ui.json` 指向本文。以下是当前公共入口，可随重构更新，并非禁止替换实现。

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Chat | `src/web-ui/react/chat/message.tsx`、`chat/activity.tsx`；Android `ChatBlocks.kt` 的 `TurnView` | 统一消息、过程与工具行渲染；入口只投影协议与身份 | 普通任务、私聊、群聊、只读历史/预览；旧 run 路由解析到所属对话 | `tests/chat-renderer-unification.test.ts`、浏览器与 Android 对话回归 |
| Select/Listbox | `src/web-ui/react/ui/select.tsx` | Ant Select、Portal 所有权 | 搜索、多选、分组 | `tests/antd-foundation-browser.test.ts` |
| Date | `src/web-ui/react/issues/form-controls.tsx` | Ant DatePicker；YYYY-MM-DD，不转 UTC | 空值、禁用 | `tests/antd-tasks-browser.test.ts` |
| Form | feature Controller、composer 与共享 Form/Field | 本文数据与输入契约 | 创建、原位编辑；应用校验 | feature 单测与浏览器 |
| Scrollbar | `src/web-ui/content/styles.css` | `theme.tsx` token 映射；见 `DESIGN.md` | xterm 自有滚动、宿主几何 | 浏览器 computed style |
| Toast | `src/web-ui/react/ui/toast.tsx` | 共享通知状态 | 成功、失败、提示 | `tests/antd-foundation-browser.test.ts` |
| CRUD | storage 原子入口与 feature Controller | 本文数据与权限边界 | 依业务保存、归档 | feature 全流程与失败回归 |
| Search | `src/web-ui/react/ui/search-field.tsx` | IME、清除与请求代次 | 本地过滤、远程检索 | feature 浏览器 |
| Dialog | `src/web-ui/react/ui/dialog.tsx` | 应用浮层、焦点与关闭协议 | 普通、输入、媒体查看 | `tests/antd-foundation-browser.test.ts` |

## 验证与交付

- 按影响范围选择验证，不要求每个小改动机械跑全套。局部改动先相关单测/类型检查；UI 补真实浏览器或设备交互。涉及共享协议、存储、运行生命周期、依赖/构建或发布时跑全量 `check/test/build`；死代码清理仍遵守全局验证约定。
- 纯文档只核对引用、约束和 `git diff --check`，不因此重启服务或构建客户端。区分本轮问题与既有基线，明确未验证项目和阻塞，不把局部通过说成全量通过。
- 最终功能验收用本机已安装 Wand 服务；连接从私密 `~/.wand/acceptance-connection.json` 读取，不泄露凭据。隔离/mock 可做开发与单测，不替代最终验收；只验受影响流程，不要求每轮重验全部功能。
- 测试不隐式调用真实付费模型；真实 CLI 样本在 `tests/fixtures/structured-cli-recordings/`，再录制须授权，入口为 `scripts/capture-structured-cli-fixtures.ts --record`。

```bash
npm run check
npm test
npm run build
node --test --import tsx tests/password-manager.test.ts  # 定点测试示例
npm run dev -- -c /tmp/wand-dev/config.json              # 隔离开发
```

## 原生端与发布

- 只构建/验收受影响平台；原生改动交付默认构建带版本 Beta、部署到 `~/.wand/<platform>/`，核对更新接口与实际下载大小/SHA，用户明确跳过才省略。默认不安装/启动设备；无设备则如实记录视觉/触控未验收。纯文档不触发客户端构建。

| 平台 | 构建/部署入口 | 更新接口 |
| --- | --- | --- |
| Android | `cd android && SKIP_INSTALL=1 APK_DIST_DIR="$HOME/.wand/android" ./debug.sh` | `/api/android-apk-update`（beta） |
| macOS | `cd macos && ./build.sh <version>`；版本 ZIP/DMG 部署到 `~/.wand/macos/` | `/api/macos-app-update` |
| iOS | `cd ios && CODE_SIGNING_ALLOWED=NO IPA_DIST_DIR="$HOME/.wand/ios" ./build.sh` | `/api/ios-ipa-update` |

- 版本基数取最高语义 tag，细节按平台脚本/README；保留原签名身份，不分发无版本产物，未签名 iOS 包不宣称可安装。Android sherpa 编译只用固定 SHA 的轻量 API jar，完整 AAR 不入库，普通构建不下载大产物。
- 未经本轮授权不 push/tag/正式发布。授权后先提交并 push 可拉取的子仓源码，再提交主仓指针；不夹带已有混合改动。发布流程以 `.github/workflows/` 为准，`publish.sh` 只是本地构建/部署，不发布 npm。

## 架构精简工作记录与续接

实际改动、验证结果与剩余事项记录在本机忽略的 `output/architecture-stage2/AGENTS-WORKLOG.md`，`output/architecture-stage2/WORKLOG.md` 是入口。本文不累积逐轮历史、版本/SHA、测试数量或短期实现参数；只在确有长期边界变化时更新规则。
