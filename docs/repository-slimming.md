# 仓库精简工作记录

最后更新：2026-09-28。状态：全仓库审计与第一批精简已完成并验证。A1–A5 是后续架构迭代队列。

本文是本次精简工作的续接入口。后续 agent 先读本文，再读 `AGENTS.md`；从未完成项继续，不重复执行已完成的操作。

## 目标与约束

- 保留现有功能，让源码、生产依赖、构建与发布流程各自只承担必要职责。
- 同时审计主仓库与 `android`、`ios`、`macos`、`render`、`render-bin`。
- 只有使用检索和测试证据支持的代码才删除；UI 选择器还必须经过真实页面状态验证。
- Server / Render 独立生命周期、PTY / structured 执行差异、数据库只加不删、原生签名与更新契约继续遵守。
- 开始时主仓库有 101 个已跟踪文件的未提交修改，以及多个新文件；Android/iOS/macOS 也有未提交修改。它们是既有工作，不能重置、覆盖或混入自动提交。
- 保留用户数据、会话报告、上传、分发包、签名文件和 Git 历史。可再生缓存须经过明确路径检查后再清理。

## 基线

2026-09-28 本机工作目录 `du` 合计约 3.9 GiB。这是磁盘占用，不能当成 Git 源码体积。

| 目录 | 本机占用 | 已识别的主要来源 |
| --- | ---: | --- |
| macos | 1.9 GiB | build 776 MiB；两套 derived-data 共约 1.1 GiB |
| android | 608 MiB | app/build 533 MiB；.gradle 26 MiB |
| node_modules | 455 MiB | SDK、node-pty、开发与浏览器依赖 |
| render | 371 MiB | target 370 MiB |
| ios | 250 MiB | build 244 MiB |
| .wand-team | 210 MiB | 会话报告与验收证据，属于用户数据 |
| .git | 130 MiB | 含 submodule 对象库，不能当成源码重复副本 |
| dist | 16 MiB | 当前生成的服务端与 Web/Render 分发内容 |
| render-bin | 11 MiB | CI 发布并固定哈希的 Render 二进制 |

主仓库初始跟踪路径 742 个，共约 14.29 MB（gitlink 不计文件内容）；其中源码约 5.82 MB、测试 2.07 MB、文档 5.78 MB。文档截图约 5.4 MB，现有 10 张截图都有引用，不能当死文件删除。`src/tests/scripts/docs` 可见路径约 700 个。

子仓库跟踪内容的文件字节数如下，不含 `.git`、未跟踪文件与缓存：

| 仓库 | 跟踪内容字节 | 说明 |
| --- | ---: | --- |
| android | 41,453,336 | sherpa AAR 单文件 38,208,264，占绝大部分 |
| ios | 1,911,524 | Swift 源码、项目配置、图标 |
| macos | 1,455,078 | Swift 源码、项目配置、图标 |
| render | 338,027 | Rust 源码与契约 |
| render-bin | 11,369,306 | 固定版本二进制及 manifest |

## 工作队列

| 编号 | 工作 | 状态 | 验收方式 |
| --- | --- | --- | --- |
| S1 | 核算各仓库跟踪内容、缓存和依赖来源 | 已完成 | Git 跟踪清单、字节数、调用检索 |
| S2 | 裁剪生产安装中的纯浏览器构建依赖 | 已完成 | 全量 check/test/build；生产依赖闭包与打包检查 |
| S3 | npm CI 与服务启动只检出需要的 submodule | 已完成 | workflow/shell 校验；Render 严格 staging 检查 |
| S4 | 提供默认预览、路径受限的构建缓存清理入口 | 已完成，已执行清理 | 临时仓库保护测试；本机清理前后测量 |
| S5 | 删除本轮确认的非 UI 死代码 | 已完成 | 完整 src 检索；相关测试与全量验证 |
| S6 | 写明架构调整顺序、收益、风险和继续入口 | 已完成 | 路径证据、独立可交付步骤 |
| S7 | 内嵌备用资产改用 gzip 存储 | 已完成 | 六类资产字节一致；磁盘文件消失时备用读取 |
| S8 | 生成的 vendor 资产退出源码版本控制 | 已完成 | 删掉本地生成目录后跑 check/build |

## 关键发现与决策

1. **先处理依赖和构建范围。** 源码目录本身很小，直接把 submodule 合并进主仓库无法解决本机编译缓存，也会破坏独立发版职责。
2. **浏览器包不等于服务运行依赖。** React、Appica、浏览器 xterm 被 esbuild 打包；服务端的 headless xterm、serialize、unicode11 仍有直接调用，不能一并移走。依赖闭包须以实际 server 导入为准。
3. **npm 发布当前拉取全部五个 submodule。** 两个 npm workflow 使用 recursive checkout；服务端发布实际只需要 `render-bin` 的已发布产物。`start.sh` 也把 Rust 源码检出当成运行前提，应缩小范围。
4. **不清理 `.wand-team`。** 其中含断线续接材料和验收证据，与本次用户要求保留工作记录一致。

## 本轮实现

- `package.json` / lock：将 Appica、React、React DOM、浏览器 xterm、fit 共五个根依赖移到 devDependencies。193 个生产 lock 项降到 154 个；按当前机器各包实际文件统计，355,308,519 → 299,242,357 字节，减少 56,066,162 字节（53.47 MiB，15.8%）。开发安装仍需要这些包。已有依赖版本没有升级。
- `.github/workflows/{npm-release,beta-branch}.yml`：只检出固定指针的 `render-bin`；已有 build + strict 校验之后的 publish 使用 `--ignore-scripts`，避免 `prepublishOnly` 再完整构建一次。本地发布的 `prepublishOnly` 安全网继续生效。
- `start.sh`：服务端构建前只补齐 `render-bin`，不再自动检出 Rust 源码。
- README / AGENTS：服务端的轻量 clone 路径与按需子模块检出规则；完整跨端测试仍需要原生源码，已写明。
- vendor 的三个生成文件（408,540 字节、374 行）从 Git 索引移除，工作文件保留且加入忽略规则。`check` / `dev` 也补上二维码 bundler，确保干净 checkout 可重建。只有这三个确定的生成文件删除进入暂存区；未把既有工作或本轮其他修改自动提交。
- 非 UI 清理：删除 `terminal-daemon-protocol.ts` 的未使用 os import（1 行）；删除 `server-local-preview-routes.ts` 的未使用 NextFunction 类型和 next 参数（2 处）；删除 `git-quick-commit.ts` 的未使用 usedIteration 解构绑定（1 处）。检索与 TypeScript unused 检查证明它们未被读取，其他实际调用保留。
- `scripts/generate-web-assets.js`：六类备用资产改为 gzip level 9 后再 base64，模块加载时用 Node 内置 zlib 解压。相同资产的未压缩 base64 为 3,900,380 字节，压缩后 1,002,204 字节，减少 2,898,176 字节（74.30%）；生成源码现为 1,003,108 字节。对外仍返回原有字符串、哈希与 MIME，不改变浏览器下载内容。
- 新增 `scripts/clean-build-cache.js` / `tests/clean-build-cache.test.ts`：默认预览，`npm run clean:build-cache -- --apply` 才删除固定白名单。先预检全部候选，再逐项重检；Git 失败、tracked 内容、非 ignored 路径、祖先符号链接、候选内嵌套 Git 元数据都会拒绝。保留 Xcode SourcePackages 与 Logs、导出的应用、分发包、Render release、签名、依赖和用户数据。

实际清理 25 个目录：Android app/build、build、.gradle；四个 Xcode derived-data 树中的 Build、ModuleCache、SDK caches、Index、CompilationCache；Render target/debug。清理后再次预览为 0 候选。

| 结果 | 修改前 | 修改后 | 缩减 |
| --- | ---: | ---: | ---: |
| 本机工作目录磁盘占用 | 4,195,618,816 B（3.91 GiB） | 1,219,346,432 B（1.14 GiB） | 2,976,272,384 B（2.77 GiB） |
| 生产依赖 lock 项 | 193 | 154 | 39 项 |
| npm 解包体积 | 16,124,543 B | 13,228,726 B | 约 2.90 MB（18.0%） |
| npm 压缩包体积 | 6,027,216 B | 5,610,143 B | 约 0.42 MB（6.9%） |

磁盘占用使用清理前后 `du -sk .`；缓存脚本的文件字节总和为 2,991,608,827 B，与磁盘占用因块大小、硬链接等不同。npm 对比基于本轮前已有 dist 与本轮完整构建后的 pack dry-run，文件数均为 346；Git 删除不会缩小旧历史对象，本轮未重写 Git 历史。

## 架构审计与后续调整

按收益与改动风险排列。以下是后续独立迭代，不表示本轮已完成这些迁移。

### A1：任务只有一套事实源，旧 DTO 做投影（优先）

证据：`WorkspaceTask` 与 `WandTask` 两种模型并存，`src/wand-task-sync.ts` 约 300 行承担双向补齐。active/done 与 todo/doing/done/archived 状态映射、默认迭代、会话移动、标题和布局更新分散在 task/workspace/session 路由。

目标：做一个任务 Module，小 Interface 只暴露创建、移动会话、改标题/状态、归档。Implementation 内完成事务、默认迭代和布局清理；两个现有 DTO 成为兼容投影。数据库继续只加不删。

顺序：先建立真实行为测试与读投影；把写操作逐项收敛；最后删除经证实不再需要的同步写链。验收覆盖历史 NULL milestone、归档、跨工作区会话移动、布局恢复和已有 HTTP 契约。不要为了改文件位置先增加一层无行为包装。

### A2：共享 iOS/macOS 的纯数据与布局规则

证据：两端 `WorkspaceLayoutReconciler.swift` 完全相同（211 行），`WorkspaceWorktreeModels.swift` 完全相同（181 行）；`WorkspaceModels.swift` 行相似度约 84.4%。网络层和其他 model 已有漂移。

目标：先提取纯 DTO 与布局规则为一个版本化 Swift Package，让两端直接消费同一个实现和测试。先验证 Swift/Xcode 最低版本与两端存储契约，再决定 package 所属仓库。UI、权限、更新、窗口生命周期仍由各端负责。每次迁移两端都要构建和完成 Beta 分发验收。

### A3：Android 语音依赖改为最小编译接口 + 按需原生库

证据：38.2 MB AAR 的 `classes.jar` 只有 232,828 字节；主要体积是原生库，当前原生子仓库工作树已经有按需下载相关改动。`SpeechNativeLibraryTest.kt` 仍读取完整 AAR 作为下载提取测试材料。

目标：配合现有改动裁剪编译依赖，同时把下载提取测试改为确定的小型 fixture 与真实产物完整性测试。先核对供应方分发许可、固定 SHA 与离线启动策略；不能直接删 AAR，否则编译/测试/语音功能都会失效。完成后要按 Android Beta 流程验收。

### A4：Web 逐步收敛状态所有权

证据：browser 64 文件约 22,399 行，React 214 文件约 42,931 行；`chat-render.ts` / `input.ts` / `session-engine.ts` 三个文件占 browser 行数约 46%；手写 CSS 20,503 行。两层仍通过 adapter 共享选择会话、终端池、输入和 WS 状态，不能当死实现一并删掉。

目标：先按一个行为迁移完整状态所有权，例如 composer draft/queue/send，让 React 通过一个小 Interface 操作；旧 DOM 写入在行为验证完成后删除。PTY WebView 与 nativeInput、上传、权限、reconnect、隐藏抽屉和移动布局必须用已安装服务验收。CSS 清理必须补所有原生/隐藏/响应式运行态证据。

测试改进：209 个测试文件中 98 个读取源码，Web 测试 84 文件里 59 个读取源码。保留必要契约检查，重构时以 Interface 的行为测试替换字符串匹配，避免改实现结构引发大量无意义失败。现有测试名称没有重复，不据此批量删测试。

### A5：统一 macOS 派生目录，约束二进制历史增长

证据：macOS `build/dd`、`.debug-derived-data`、`.release-derived-data` 三套编译缓存并存；`build.sh` 删除 build 后重建 `build/dd`，`debug.sh` 另建 derived-data。建议构建脚本统一一个可配置缓存目录，让 Debug/Release 由 Xcode 配置区分；保留产物分发目录。

`render-bin/scripts/prune.js` 目前按 major.minor 分组，0.1.0/0.1.1/0.1.3 都保留，同 minor 的 patch 可无限增长。建议保留最新 patch 和明确回滚集合，CI 内更新 manifest/产物；不能清除主仓库当前固定指针需要的版本。

审计还发现 `render-bin/scripts/sync.mjs` 的 `manifest.latest > options.version` 为字符串比较，0.1.9/0.1.10 会排序错误。该文件属于 CI 管理的发布产物子仓库，需在那里做数值语义比较与针对性测试后发版，再更新主仓库指针。本轮未修改它。

### 保留的设计

- 五个 submodule 的独立版本/发布职责成立。主仓库只按需要检出；将它们全部合并成 monorepo 不会消除编译缓存，也会扩大服务端改动的验证范围。
- Server/Render 两进程生命周期与 PTY/structured 两种执行机制都有真实差异，不合并 runner。
- 非 Web 服务端 135 文件、53,416 行，入口可达性分析未发现整文件死代码；22 个脚本都有构建、测试、文档或手工验收用途。
- npm 的 `.d.ts` 约 371 KB，可能供外部引用，收益低于依赖/内嵌表示裁剪，不删除公开接口。
- 文档与备用 Web 资产分别承担续接和无损自更新职责；压缩与索引治理优于删掉功能。

## 验证记录

环境 Node v26.10.0，与 `.nvmrc` 一致。

| 验证 | 结果 |
| --- | --- |
| 删除本地三份 vendor 生成资产后 `npm run check` | 通过；二维码、xterm、Web 备用资产全部从零再生 |
| `npm test` | 1521 项：1520 通过、1 跳过、0 失败，约 91 秒 |
| `npm run build` | 通过，包括 bundle budget 与 Render staging |
| 清理白名单收窄后的定点测试 | 10/10 通过；未重复运行无关的全量测试 |
| 内嵌资产与磁盘缺失备用读取定点测试 | 3/3 通过，并已包含在全量测试中 |
| `node scripts/stage-render-binaries.js --all --strict --check` | 四平台通过；sha256、版本、容器与已 stage 副本一致 |
| 两个 npm workflow YAML、构建/严格校验/publish 顺序 | 通过；保留固定 Node 与独立发布安全门 |
| `bash -n start.sh` / `git diff --check` | 通过 |
| 临时目录 `npm ci --omit=dev` | 成功安装 147 个本平台包；五个纯浏览器依赖均不可 resolve |
| 生产依赖环境运行实际 dist | CLI help、server import、内嵌解码、Wand 原有 helper 修复和真实 PTY 输出均通过 |
| 已安装服务公开资源探测 | 使用私密 acceptance 文件所指服务，HTML、session-check、xterm、二维码均 HTTP 200；不记录连接信息 |
| 清理后缓存预览 / submodule 指针 | 0 候选；五个指针与开始时完全一致 |

验证过程中遇到并解决的情况：

- npm 离线更新 lock 因 WASI 变体不在缓存而失败；正常更新成功，所有已有依赖版本保持原值，npm 补全了锁中可选 bundled 元数据。
- 清理保护测试初次错误分类不匹配，调整为先判 tracked 内容再判 ignore，已通过。
- 第一次真实预览拒绝 Xcode SourcePackages 中的 SwiftTerm Git checkout。白名单改为仅删除派生目录的编译子目录，保留整个 SourcePackages 和诊断 Logs，并补保留测试；重新预览和执行成功。
- 生产安装的 node-pty helper 被 npm 解包为不可执行，直接调用原始库会失败。实际 Wand 启动已有 `ensureNodePtyHelperExecutable()` 自修复；按真实启动路径修复后 PTY 通过。没有为测试修改生产逻辑或放宽依赖权限配置。

`npm run audit:remnants` 输出 30 个候选、7 处未解析动态查询。包含 xterm/Appica 与实际运行分支，不能据此认定死选择器。本轮未删除 UI 选择器，也未改变 UI 行为。

完整本机日志在忽略目录 `output/repository-slimming/`。本文已保留关键数据与结论，日志缺失不影响续接。没有提交或 push；仅三个生成 vendor 文件的取消跟踪已暂存。原生客户端源码/配置未产生本轮修改，因此本轮无需重新发原生 Beta 包。

## 断线续接

1. `git status --short` 和各子模块状态只用于确认变化，不能用 reset/clean 恢复所谓干净基线。
2. S1–S8 已完成，不重跑清理。下一阶段优先 A1 的任务事实源收敛，先画当前读写链和建立行为测试，再逐项迁移写操作；A2/A3 涉及原生子仓库和构建分发，作为独立迭代处理。
3. 本轮若修改原生客户端代码/配置，必须依 `AGENTS.md` 重新构建、部署、核验 Beta 更新；只读审计与删除可再生缓存不属于原生代码修改。
4. 最终把实际修改路径、数量、验证结果和剩余架构工作写回本文，再向用户汇报。
