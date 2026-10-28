# AGENTS.md

Wand 是本机 AI 工作台（Node.js + TypeScript ESM、Express + WebSocket）。本文只保留必要的操作边界和源码入口；功能细节以对应源码、测试和本轮需求为准。

## 工作方式与安全

- 行为准则参考 [andrej-karpathy-skills CLAUDE.md](https://raw.githubusercontent.com/forrestchang/andrej-karpathy-skills/main/CLAUDE.md)（思考先行、最简实现、外科手术式改动、目标驱动验证），以下是结合本仓的落地约定；谨慎优先，琐碎任务自行判断，不必机械套全套流程。
- **先想清楚再动手**：关键前提、多种合理解读、更简单的替代方案在实现前先讲出来；与用户或源码事实矛盾、信息不足时停下来点名疑点，不带着困惑硬写。
- **目标驱动执行**：动手前把任务写成可验证目标（"修这个 bug"→"先有复现测试，再让它通过"）；多步任务给出每步的验证方式，验证结果与目标不符时停下重新定位，不用"看起来能用"交差。
- 开工检查主仓及涉及子模块的 Git 状态，记录已有改动；增量合并，不 reset/clean、覆盖或自动提交他人的工作。
- 在任务范围内可以重构、调整目录、替换实现或依赖，不必为每个技术选择再次确认。现有实现、历史测试和本文入口不是永久设计锁；行为有意改变时同步更新测试与说明，不靠删测试掩盖回归。
- 避免过度设计：最简实现、复用现有能力，不为假设中的未来需求预建抽象层、配置项或通用框架；新增复杂度须有明确的当前收益，不以精简为由削弱必要的安全、正确性和兼容性。
- 避免无关改动：每一处改动都应能直接追溯到本轮请求，不顺手"改善"相邻代码、注释或格式，不重构没坏的东西；发现无关问题记录或提出，不扩大范围去修，证据明确的同类问题一起修。涉及未授权的数据删除、权限或费用扩大、发布、设备安装，以及尚未确定的产品取舍时再确认。
- 不提交或打印密码、token、私钥及其他敏感信息。默认监听回环地址；命令与可执行路径来自可信配置，不把未校验的 HTTP 输入当作执行参数。高频事件与大输出考虑防抖、取消和有界缓冲。
- 沿用邻近代码风格：2 空格、双引号、分号，Node 内置模块用 `node:`，ESM 相对导入带 `.js`。
- 死代码凭引用与运行态证据清理，不能把公开 API、动态标识符、条件样式或迁移兼容项当死代码；需要时用 `npm run audit:remnants`。
- 全仓文本搜索必须排除构建产物与缓存目录（`output/`、`node_modules/`、`build/`、`dist/`、`.git/`、`DerivedData/`）：`output/` 里有 24GB 级稀疏缓存文件，`grep -r` 命中会逐字节读完、数小时不返回。仓库根搜索用 `rg`（自动读 `.gitignore`）或给 `grep` 带 `--exclude-dir`。

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
| 文档索引、待办与问题跟踪 | `docs/README.md`；任务面板 `wand_tasks` |

Node 版本以 `.nvmrc` 为准。只检出需要的子模块：服务端构建用 `git submodule update --init -- render-bin`，改 Render 或原生端时再检出对应目录。查会话问题先确认 `SessionRegistry.ownerOf(id)`，不要混淆 PTY、structured 和存储快照。

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
- 本地决策是显式可选的辅助推理，失败不隐式切云端，不代替审批。配置见 `README.md`，实现与回归见 `src/decision-*.ts`、`tests/local-decision.test.ts`。

## 验证与交付

- 按影响范围选择验证：局部改动先相关单测/类型检查，UI 补真实浏览器或设备交互；涉及共享协议、存储、运行生命周期、依赖/构建或发布时跑全量 `check/test/build`。
- 纯文档只核对引用、约束和 `git diff --check`，不因此重启服务或构建客户端。区分本轮问题与既有基线，明确未验证项和阻塞，不把局部通过说成全量通过。
- 工作中发现的其它问题和优化机会一律当场建任务面板条目（`POST /api/wand-tasks`，workspace 归属真实项目），区分已修复、待处理、待验证；描述写清现象、证据路径、影响、复现入口和建议优先级，不把推测写成已确认缺陷，也不把已明确授权的同类修复仅留为建议。同一问题先查板再建，不重复立卡。
- 最终功能验收用本机已安装 Wand 服务，连接从私密 `~/.wand/acceptance-connection.json` 读取，不泄露凭据；隔离/mock 不替代最终验收，只验受影响流程。
- 测试不隐式调用真实付费模型；真实 CLI 样本在 `tests/fixtures/structured-cli-recordings/`，再录制须授权（`scripts/capture-structured-cli-fixtures.ts --record`）。

```bash
npm run check
npm test
npm run build
npm run typecheck                                        # 只做三套 tsc，不生成资产
npm test -- tests/password-manager.test.ts               # 定点测试（走 run-tests.js，含 TMPDIR 隔离）
npm run dev -- -c /tmp/wand-dev/config.json              # 隔离开发
```

## 多端与构建约定

- 多端一致性：所有功能、界面与交互修改，Mac 与 Web 保持一致、Android 与 iOS 保持一致，涉及任一端时同步检查修改同组另一端；允许平台原生实现差异，构建、验证、交付分端执行，一端通过不等于双端通过。改 `ios/`、`macos/` 前先读对应子模块 `AGENTS.md` 与 apple-design 技能（真源在 iOS），以平台原生方式实现；Web 界面、组件与设计以源码、测试和 `DESIGN.md` 为准。
- 只手改 Web 源码（browser/react、`src/web-ui/content/styles.css`、构建脚本），打包 JS、tailwind/vendor、`embedded-assets.ts`、`dist/` 一律由构建再生成。bundle 预算分硬上限与基线棘轮：功能级增长用 `npm run budget:accept` 刷新基线并在提交说明加载影响，改硬上限才需要产品取舍，不绕过门禁。

## 原生端与发布

- 只构建/验收受影响平台；原生改动默认构建带版本 Beta、部署到 `~/.wand/<platform>/`，核对更新接口与实际下载大小/SHA；默认不安装/启动设备，无设备则如实记录视觉/触控未验收。纯文档不触发客户端构建。

| 平台 | 构建/部署入口 | 更新接口 |
| --- | --- | --- |
| Android | `cd android && SKIP_INSTALL=1 APK_DIST_DIR="$HOME/.wand/android" ./debug.sh` | `/api/android-apk-update`（beta） |
| macOS | `cd macos && ./build.sh <version>`，ZIP/DMG 部署到 `~/.wand/macos/` | `/api/macos-app-update` |
| iOS | `cd ios && IPA_DIST_DIR="$HOME/.wand/ios" ./build.sh`（Ad Hoc 见 `ios/ADHOC.md`） | `/api/ios-ipa-update` |

- iOS 已配置 Ad Hoc 后正常交付必须签名并同步 `ios.currentIpaFile`，不得用未签名包替代可安装更新；显式 `CODE_SIGNING_ALLOWED=NO` 仅用于模拟器/未签名验证。证书/profile/设备名额与期限独立核对，手机安装由用户确认。
- 版本基数取最高语义 tag；保留原签名身份，不分发无版本产物。Android sherpa 只用固定 SHA 的轻量 API jar，完整 AAR 不入库。
- 未经本轮授权不 push/tag/正式发布。授权后先提交并 push 子仓源码，再提交主仓指针，不夹带已有混合改动；发布流程以 `.github/workflows/` 为准，`publish.sh` 只是本地构建/部署。

## 待办与续接

待办、发现的问题和跨会话续接一律走任务面板（`wand_tasks`）：建卡时写清现象、证据路径、影响与复现入口，验收通过后再归档；续接任务按面板状态与描述检索，不另设滚动日志。历史工作记录保留在 `output/architecture-stage2/AGENTS-WORKLOG.md`（本机忽略、只读参考，2026-10-27 起停止追加），长期结论已在本文、`DESIGN.md` 或各任务报告中。
