# AGENTS.md

Wand 是本机 AI 工作台（Node.js + TypeScript ESM、Express + WebSocket）。本文只保留必要的操作边界和源码入口；功能细节结合本轮需求与当前源码核实。

## 文档与历史信息的适用范围

- 当前用户需求优先于旧任务、历史验收、记忆摘要和文档中的实现选择。历史资料说明当时为何这样做，不自动成为新功能的验收条件；不得仅为满足旧记录回退已授权的新行为。
- 本文保留操作、数据和交付边界；[PRODUCT.md](PRODUCT.md) 描述产品背景，[DESIGN.md](DESIGN.md) 描述设计基线，[文档索引](docs/README.md) 区分当前说明、提案与历史。组件、目录、依赖、布局及实现路线不是永久设计锁。
- 源码是当前实现的证据，不自动证明实现符合需求。遇到冲突先判断是有意变更、过期说明还是缺陷；只有授权、数据安全或产品目标仍不明确时才向用户澄清，不因旧文档多写了“必须”就停止开发。
- 仅加载本轮涉及的文档与项目知识。更新当前说明应就地替换失效内容；历史报告保留日期与适用范围，不把逐轮日志继续累积到规则文件。全局知识托管区由知识库维护，不手改生成副本。

## 工作方式与安全

- **先想清楚再动手**：关键前提、多种合理解读、更简单的替代方案在实现前先讲出来；对影响结果的疑点先核对；可以由源码或本轮需求确定的实现选择自行处理。
- **目标驱动执行**：动手前把任务写成可验证目标（"修这个 bug"→"先确认复现条件，再核对修复后行为"）；多步任务给出每步的验证方式，验证结果与目标不符时停下重新定位，不用"看起来能用"交差。
- 开工检查主仓及涉及子模块的 Git 状态，记录已有改动；增量合并，不 reset/clean、覆盖或自动提交他人的工作。
- 在任务范围内可以重构、调整目录、替换实现或依赖，不必为每个技术选择再次确认。现有实现、历史测试和本文入口不是永久设计锁；行为有意改变时同步更新验证口径与说明，不用过期验收条件否定新需求，也不掩盖仍应保留的行为回归。
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

## 运行与数据边界

- 保护已有用户数据、草稿、历史和正在执行的工作；SQLite 迁移保持兼容，不用清库或删除旧列绕过问题。
- Server 与 Render/terminald 生命周期独立，服务重启不得终止它们持有的会话。重启使用本机统一入口 `~/start.sh`，遵守排空屏障；超时或运行事实不明时取消，不强杀。
- 区分真实运行所有权、展示状态与存储快照。未知送达不自动重放；PTY 输入保持文本与单独 `"\r"` 两包，异步回执不能覆盖新输入或另一会话。
- 尊重用户的工具、模型、权限与费用选择，不静默切换引擎、扩大权限或转付费。知识、模型输出与本地决策不构成操作授权。
- 凭据不进入日志、公共 DTO、知识或文档；员工个人知识不能跨身份读取或复制。记忆以实际保存成功为准，已删除内容不能由迟到回调复活。
- 当前实现的详细入口见 [架构参考](docs/architecture-reference.md)，只在涉及相应模块时查阅；具体模块和实现方式可以随本轮需求演进。

## 验证与交付

- 不随意新增测试用例。2026-10-30 起仓库不再保留 `tests/` 自动化测试套件；验证按受影响功能做类型检查、构建和真实界面或流程核对，不恢复整包测试执行。
- 纯文档只核对引用、约束和 `git diff --check`，不因此重启服务或构建客户端。区分本轮问题与既有基线，明确未验证项和阻塞，不把局部通过说成全量通过。
- 工作中发现的其它问题和优化机会一律当场建任务面板条目（`POST /api/wand-tasks`，workspace 归属真实项目），区分已修复、待处理、待验证；描述写清现象、证据路径、影响、复现入口和建议优先级，不把推测写成已确认缺陷，也不把已明确授权的同类修复仅留为建议。同一问题先查板再建，不重复立卡。
- 最终功能验收用本机已安装 Wand 服务，连接从私密 `~/.wand/acceptance-connection.json` 读取，不泄露凭据；隔离/mock 不替代最终验收，只验受影响流程。
- 验证不隐式调用真实付费模型；真实 CLI 样本录制须另行授权。

```bash
npm run check
npm run build
npm run typecheck                                        # 只做三套 tsc，不生成资产
npm run dev -- -c /tmp/wand-dev/config.json              # 隔离开发
```

## 多端与构建约定

- 多端一致性：Web 与 macOS 变更解耦，Web 变更不要求同步修改 macOS；Android 与 iOS 保持一致，涉及任一移动端时同步检查修改另一端；后端改动仍须核对各端功能、协议与行为兼容；允许平台原生实现差异，构建、验证、交付分端执行，一端通过不等于双端通过。改 `ios/`、`macos/` 前先读对应子模块 `AGENTS.md` 与 apple-design 技能（真源在 iOS），以平台原生方式实现；Web 界面、组件与设计以本轮需求、源码和 `DESIGN.md` 的适用设计基线为准。
- 只手改 Web 源码（browser/react、`src/web-ui/content/styles.css`、构建脚本），打包 JS、tailwind/vendor、`embedded-assets.ts`、`dist/` 一律由构建再生成。bundle 预算分硬上限与基线棘轮：功能级增长用 `npm run budget:accept` 刷新基线并在提交说明加载影响，改硬上限才需要产品取舍，不绕过门禁。

## 原生端与发布

- 只构建/验收受影响平台；原生改动默认构建带版本 Beta、部署到 `~/.wand/<platform>/`，核对更新接口与实际下载大小/SHA；默认不安装/启动设备，无设备则如实记录视觉/触控未验收。纯文档不触发客户端构建。

| 平台 | 构建/部署入口 | 更新接口 |
| --- | --- | --- |
| Android | `cd android && SKIP_INSTALL=1 APK_DIST_DIR="$HOME/.wand/android" ./debug.sh` | `/api/android-apk-update`（beta） |
| macOS | `cd macos && ./build.sh <version>`，ZIP/DMG 部署到 `~/.wand/macos/` | `/api/macos-app-update` |
| iOS | `cd ios && IPA_DIST_DIR="$HOME/.wand/ios" ./build.sh`（Ad Hoc 见 `ios/ADHOC.md`） | `/api/ios-ipa-update` |

- iOS 已配置 Ad Hoc 后正常交付必须签名并同步 `ios.currentIpaFile`，不得用未签名包替代可安装更新；显式 `CODE_SIGNING_ALLOWED=NO` 仅用于模拟器/未签名验证。证书/profile/设备名额与期限独立核对，手机安装由用户确认。
- iOS 模拟器验收只使用两台，且同一时间只启动一台：iPhone 18 Pro 与 iPhone Duo。其他机型不启动、不制作测试。需要换机时先 `xcrun simctl shutdown all`，再启动其中一台。不要同时开两台或更多模拟器；本机 16GB 内存下多开会把负载打满并拖慢服务。默认仍不主动安装或启动模拟器，只有本轮明确要求验收时才启动。
- 版本基数取最高语义 tag；保留原签名身份，不分发无版本产物。Android sherpa 只用固定 SHA 的轻量 API jar，完整 AAR 不入库。
- 未经本轮授权不 push/tag/正式发布。授权后先提交并 push 子仓源码，再提交主仓指针，不夹带已有混合改动；发布流程以 `.github/workflows/` 为准，`publish.sh` 只是本地构建/部署。

## 待办与续接

待办、发现的问题和跨会话续接一律走任务面板（`wand_tasks`）：建卡时写清现象、证据路径、影响与复现入口，验收通过后再归档；续接任务按面板状态与描述检索，不另设滚动日志。历史工作记录保留在 `output/architecture-stage2/AGENTS-WORKLOG.md`（本机忽略、只读参考，2026-10-27 起停止追加），长期结论已在本文、`DESIGN.md` 或各任务报告中。
