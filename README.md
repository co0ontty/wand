# wand

[![npm version](https://img.shields.io/npm/v/@co0ontty/wand.svg)](https://www.npmjs.com/package/@co0ontty/wand)
[![license](https://img.shields.io/npm/l/@co0ontty/wand.svg)](https://github.com/co0ontty/wand/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/@co0ontty/wand.svg)](https://nodejs.org)
[![GitHub last commit](https://img.shields.io/github/last-commit/co0ontty/wand)](https://github.com/co0ontty/wand/commits/master)

[English](#english) | [中文](#中文)

## English

### Overview

Wand is a web console for remotely accessing and managing local CLI tools from a browser. It supports [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai/), [Grok Build](https://grok.com/), [Qoder CLI](https://docs.qoder.com/en/cli/quick-start), and [Pi](https://pi.dev/), with terminal and structured conversation views, persistent resumable sessions, permission controls, file browsing, and native clients for multiple platforms.

The browser password manager extension source lives in `browser-extension/`.

### Installation

Choose one installation method:

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

or:

```bash
npm install -g @co0ontty/wand
```

If you install with `npm`, initialize and start Wand manually:

```bash
wand init
wand config:password  # Print the login password
wand web
```

The install script already runs `wand init`, prints the login password, and lets you choose whether to install a background service or start Wand manually. To view the password later, run:

```bash
wand config:password
```

### Features

#### Core

- **Dual view modes** — switch between raw terminal output and a structured conversation view for the same session
- **Multiple providers** — create PTY or structured sessions for Claude Code, Codex, OpenCode, Grok, Qoder CLI, and Pi
- **Session management** — create, archive, and resume Claude, Codex, OpenCode, Grok, and Qoder sessions with their provider-native context; restore Claude/Codex native history; show summaries in the session list
- **Permission control** — visual permission prompts with one-time approval, per-turn memory, and related policies

#### Experience

- **Structured conversations** — syntax-highlighted code blocks, collapsible tool calls, grouped tool rendering, and per-turn token usage
- **Personalized roles** — pixel cat avatars and customizable conversation role names
- **Message queueing** — keep typing while the AI is working; messages are queued automatically
- **File browser** — built-in path browsing and search
- **Quick commits** — review Git changes and generate a commit message from the web UI
- **Scheduled tasks** — choose an employee, workspace directory and prompt, run once or repeat daily/weekly, and review execution history. See [scheduling behavior](docs/scheduled-tasks.md).

#### Deployment

- **Native clients** — Android, iOS, and macOS clients with encrypted connection codes and update checks
- **HTTPS** — optional self-signed certificates for remote or mobile access
- **Update channels** — built-in stable/beta update checks and upgrade prompts
- **CLI updates** — check and quickly update Claude Code, Codex, OpenCode, Qoder CLI, and Pi from server settings, with optional automatic updates

Stable subscribers receive npm `latest`; Beta subscribers receive the newer of `latest`
and `beta`, including a stable release that supersedes its prerelease. Installing stable
keeps the Beta subscription enabled. Updates pin the checked version, wait for Core turns,
and restart only the Web service. If an old updater cannot run, rerun `install.sh` for a
staged recovery that preserves the previous installation and service scope. Node.js must
meet the new package's requirement. The runtime minimum is **Node.js 22.19.0**;
maintained even-numbered LTS releases are recommended (22.x / 24.x, with 26.x
also checked for compatibility). `.nvmrc` pins reproducible builds, not the
installation minimum. See [Web update and recovery](docs/web-updates.md).

### Configuration

The default config file is `~/.wand/config.json`; it is created by `wand init`.

```bash
wand config:path              # Print the config file path
wand config:show              # Show current config
wand config:set host 0.0.0.0  # Allow remote access
wand config:set port 9443
```

Common options:

| Field | Default | Description |
|------|---------|-------------|
| `host` | `127.0.0.1` | Listen address; use `0.0.0.0` for remote access |
| `port` | `8443` | Listen port |
| `https` | `false` | Enable HTTPS with an auto-generated self-signed certificate |
| `password` | Random on first `wand init`; `change-me` placeholder otherwise | Login password. Stored in SQLite, not `config.json` (`wand config:password` prints it). Running with the `change-me` placeholder logs a warning |
| `language` | `""` | Preferred Claude response language (a preference, stored in SQLite) |
| `publicOrigin` | unset | Public URL clients should use, e.g. `https://home.example.com:8443`. Required when TLS terminates in an L4 proxy |

### Optional local decisions (experimental)

On Apple Silicon, Wand can share one offline Laya-MLX worker across structured CLI sessions. It answers bounded `choice`/`score`/`noul` questions, not chat messages or execution/permission approvals. Install Python dependencies and a verified multilingual checkpoint separately, then configure their absolute paths:

```bash
wand decision:configure --python /path/to/venv/bin/python --model /path/to/laya-multilingual-mlx
wand decision:skills                 # Install the managed wand-decision skill for all seven CLIs
# Restart the existing Wand service, then start a new structured CLI conversation.
```

The skill's helper calls `wand decide --stdin` over the existing HTTP service. `/api/decisions/evaluate` and `/api/decisions/status` require authentication; runner capabilities authorize only inference, expire within6h, and are revoked when the run ends. No token is stored in the skill and no new public port is opened. Inputs that would be truncated are rejected. The worker unloads after5 minutes idle. `wand decision:configure --disable` disables it after a server restart. Standalone CLI/PTY sessions are not implicitly authorized.

Web and Android show inference calls as standalone local-decision cards, outside activity groups. Details start collapsed; click the header to expand the input and result in place. Explicit expansion choices survive refreshes and late results. Skill reads and status checks remain ordinary tools. This feature does not automatically install the model or change task assignment. Local evaluation found substantial routing errors, including high-confidence mistakes; use it as an optional aid, not a reliable arbiter. See [AGENTS.md](AGENTS.md) for deployment and safety boundaries.

### System Service

The default service mode is system-wide: Linux writes `/etc/systemd/system/wand.service`, and macOS writes `/Library/LaunchDaemons/com.wand.web.plist`. System service changes require administrator permission. Wand automatically invokes sudo and lets you enter the password in the terminal; it never reads or stores the password. Without an interactive terminal, only already-authorized noninteractive sudo is allowed. Restart waits for active Core turns before gracefully restarting Server, leaving Render/terminald running (`--timeout <seconds>` cancels on timeout).

```bash
wand service:install   # Register and start; automatically request sudo
wand service:status    # Show status
wand service:start     # Start
wand service:stop      # Stop
wand service:restart   # Safely restart; automatically request sudo
wand service:logs      # Show recent logs
wand service:uninstall # Stop and remove the service
```

Use `--user` for a user-level service:

```bash
wand service:install --user
wand service:status --user
```

After a service is installed, `wand web` detects the running instance for the same config and attaches to it instead of starting a second process.

### Development

```bash
npm install                # Install dependencies
npm run dev                # Start the dev server from source
npm run check              # TypeScript type check
npm run build              # Compile and copy static assets to dist/
```

On this configured development machine, use `~/start.sh` to build/install the working tree and restart, `~/start.sh --restart` to restart without rebuilding, or `~/start.sh --status` to check status. This user-home helper enters the project and handles sudo locally; do not prefix it with `sudo`. It is not included in a fresh clone, and credentials stay outside the repository. Restart safety rules remain in [AGENTS.md](AGENTS.md). Build/check commands share a project lock; local deployment and npm updates share the global installation lock. A busy lock fails before package or service changes. Local Beta versions are written only to build metadata and a private package snapshot, never to the working tree's package manifests. The `build:body` / `check:body` scripts are internal steps for the locked entry points.

Use an isolated config for testing:

```bash
npm run dev -- -c /tmp/wand-test/config.json
```

For server development, check out only the pinned Render binaries. Native clients and
Rust source are independent submodules; initialize the one you are changing:

```bash
git clone https://github.com/co0ontty/wand.git
cd wand
git submodule update --init -- render-bin
# Optional: git submodule update --init -- android  # or ios, macos, render
```

The full cross-platform test suite reads native source contracts, so initialize
`android ios macos render` before running `npm test`. The brand-consistency test
also reads generated iOS/macOS AppIcon PNGs, which on macOS come from
`swift <platform>/scripts/generate-icons.swift` (run `npm run sync:brand-assets`
first; CI does the same in `.github/workflows/ci.yml`). To preview removable
compiler caches, run `npm run clean:build-cache`; add `-- --apply` to remove them.
For macOS daily cleanup of inactive archived compiler intermediates (seven-day retention),
use `npm run clean:build-cache:install -- --install`; see [automatic cleanup](docs/build-cache-cleanup.md).
This does not install Git hooks or remove live native build trees.

Runtime data is stored under `~/.wand/`: `config.json`, `wand.db`, and `sessions/`.

OpenCode structured sessions require the current `opencode-ai` CLI (0.1 or newer). Remove the unrelated legacy `opencode` 0.0.x package before installing it:

```bash
npm uninstall -g opencode
npm install -g opencode-ai@latest
```

```

## 中文

### 概览

通过浏览器远程访问和管理本地 CLI 工具的 Web 控制台。支持 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex)、[OpenCode](https://opencode.ai/)、[Grok Build](https://grok.com/)、[Qoder CLI](https://docs.qoder.com/zh/cli/quick-start)、[Pi](https://pi.dev/)，提供终端和结构化对话双视图、会话持久化与恢复、权限管控、文件浏览和多平台客户端。

### 安装

选择下面任意一种安装方式：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

或者：

```bash
npm install -g @co0ontty/wand
```

如果使用 `npm install -g` 安装，需要手动初始化并启动：

```bash
wand init
wand config:password  # 查看登录密码
wand web
```

一键安装脚本会自动执行 `wand init`、显示登录密码，并让你选择安装为后台服务或之后手动运行 `wand web`。之后如需再次查看密码，运行：

```bash
wand config:password
```

OpenCode 结构化会话需要当前的 `opencode-ai` CLI（0.1 或更高版本）。如果装过无关的旧版 `opencode` 0.0.x 包，请先替换：

```bash
npm uninstall -g opencode
npm install -g opencode-ai@latest
```

```

### 功能

#### 核心

- **双视图模式** — 终端原始输出和结构化对话视图可随时切换，同一会话两种呈现
- **多 Provider 支持** — Claude Code、Codex、OpenCode、Grok、Qoder CLI 和 Pi 均可创建 PTY 或结构化会话
- **会话管理** — 创建、归档并携带原生上下文恢复 Claude、Codex、OpenCode、Grok、Qoder 会话；支持恢复 Claude/Codex 原生历史记录；会话列表显示摘要
- **权限控制** — 可视化权限提示，支持逐次确认、单次批准、本轮记忆等策略

#### 交互体验

- **结构化对话** — 代码块语法高亮、工具调用折叠/展开、多问题分组渲染、输入区展示最近一轮 Token 用量与费用
- **个性化角色** — 像素风猫咪头像（赛博虎妞 / 勤劳初二），支持自定义对话角色名称
- **消息排队** — 在 AI 思考时可继续输入，消息自动排队发送
- **文件浏览器** — 内置路径浏览和搜索功能
- **本地预览** — 消息和终端里的本机链接可点击预览；顶栏也可手动打开本机 HTTP 端口或 HTML 目录
- **快捷提交** — Git 变动快速提交入口，一键生成 commit message
- **定时任务** — 选择员工、工作区目录和提示词，单次或每天／每周自动执行，并查看执行记录；详见 [使用说明](docs/scheduled-tasks.md)。

#### 部署与访问

- **多平台客户端** — Android / iOS / macOS 原生客户端，支持加密连接码分发、自动更新检查
- **HTTPS** — 可选自签证书，适合远程或移动端访问
- **版本管理** — 内置更新检查与升级提示，支持 stable/beta 双通道

Web 设置中的「Beta 通道」决定服务端 npm 更新候选：关闭时仅检查
`@co0ontty/wand@latest`，开启时同时检查 `latest` 与 `beta`，选择版本较新的一个；
同号正式版高于其 beta。「自动更新 Web 服务」独立决定是否自动安装。
检查后安装锁定具体版本，避免 dist-tag 在安装期间移动。Beta 用户安装正式版后
仍保留 Beta 订阅，下一次有更新的 beta 时继续收到更新。关闭 Beta 不会自动降级；
需要立即返回较旧正式版时，点击「更新或重新安装」。

手动与自动更新共用独立 helper：等待 Core 回合完成后安装，失败保留旧服务；
成功后只重启 Web 服务，Render/terminald 的会话继续运行。Web 更新不能升级 Node.js；
Node 版本不足会在改动安装前拒绝。页面同时核对新服务实例和目标版本后才刷新。
旧版本无法自更新时，重新执行本文的 `install.sh`：恢复流程先下载验证完整包，
保留旧安装，等待 Core 排空，再修复全局入口与原 service scope，支持残缺安装。
默认保留已保存的 Beta 订阅；切换 Node 后已有配置/数据库仍进入升级流程。
入口会复用兼容的已有 Node，必要时使用已配置 nvm 安装；npm 目录不可写时迁入用户可写的运行时目录，
后续更新始终绑定这份实际安装。新版也附带 `wand update:repair` 恢复命令，避免依赖 GitHub 可达。
可用 `WAND_UPDATE_CHANNEL=stable` 或 `beta` 指定本次恢复目标，
`WAND_CONFIG_PATH` 指定自定义配置路径。详细流程、失败原因与补救见 [Web 更新说明](docs/web-updates.md)。

正式 npm 发布由 `vX.Y.Z` Git tag 触发，只写入 `latest`，拒绝预发布版本。
master 的 Beta 发布只写入 `beta`，版本为下一补丁号加
`-beta.<构建序号>.<重试序号>.g<提交>`，例如 `4.89.5-beta.100.1.gabcdef0`。
版本基数同时检查正式 Git tags 和 npm latest，兼容未推送 Git 的本地正式发布。
Beta 标签缺失或无效时，Beta 订阅仍可接收有效正式版；正式通道始终不选择 beta。
两个候选都无效或 npm 不可达时不安装。
- **CLI 更新** — 在服务端设置中检查并快速更新 Claude Code、Codex、OpenCode、Qoder CLI 和 Pi，也可开启自动更新

### 配置

配置文件位于 `~/.wand/config.json`，首次 `wand init` 时自动生成。

```bash
wand config:path           # 查看配置文件路径
wand config:show           # 查看当前配置
wand config:set host 0.0.0.0  # 修改配置项
wand config:set port 9443
```

常用配置项：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `host` | `127.0.0.1` | 监听地址，`0.0.0.0` 允许远程访问 |
| `port` | `8443` | 监听端口 |
| `https` | `false` | 启用 HTTPS（自签证书自动生成） |
| `password` | 首次 `wand init` 随机生成；否则为 `change-me` 占位 | 登录密码。存在 SQLite 而非 `config.json`（`wand config:password` 查看）。仍是 `change-me` 时会打警告 |
| `language` | `""` | Claude 回复语言偏好（偏好项，存 SQLite） |
| `publicOrigin` | 未设置 | 客户端应使用的公开访问地址，如 `https://home.example.com:8443`。TLS 在 L4 反代终止时必填 |

### 本地访问与数据备份边界

- 配对的原生端可创建 CLI 会话和空白终端；空白终端可执行本机命令。应用连接码应当按本机执行凭据保管，而不是只读访问凭据。当前连接码仍采用既有共享令牌，不支持按设备单独撤销。
- 文件 API 允许浏览普通本地项目，但拒绝系统配置目录及家目录下的 `.wand`、SSH/云凭据、密钥环等敏感位置；检查覆盖符号链接目标和新建路径的已有上级目录。工作目录不是权限沙盒，CLI 工具的访问能力不由文件浏览 API 的过滤规则决定。
- 可在启动配置中设置 `browserExtensionIds`（扩展 ID 数组）收窄扩展跨域访问；未设置时兼容携带 Bearer 令牌的扩展，但不授予跨域 Cookie 凭据许可。`trustProxy` 指定可信代理地址/CIDR，影响登录限流使用的客户端 IP；不要将不受信任的请求来源加入可信代理。
- SQLite 升级前会生成一致性备份，迁移保留既有数据；遇到高于当前版本所支持的 schema 会拒绝启动，不会猜测兼容性并继续写入。降级需使用匹配的数据备份，不能让旧版本直接打开已经迁移的库。保险库和连接器的新密文使用数据库目录内独立的 `wand-vault.key`（权限 `0600`），不再只依赖同一数据库里的 `appSecret`。备份/迁移实例时须同时妥善保存数据库和密钥文件；只有数据库备份不能恢复新密文。缺失或损坏密钥会明确失败，不会生成新密钥覆盖现有密文。
- 独立密钥防止仅泄露数据库时直接解密，但不防御获得整个数据目录或当前用户权限的攻击者。管理员密码的现有 CLI 查看/连接码兼容契约仍保留；不能据此宣称已全面完成密码哈希迁移或按设备令牌改造。

### 语音识别

Web、Android、iOS 可在语音输入设置中选择「服务端识别」或「客户端本地识别」。服务端使用按需安装的 whisper.cpp 多语言模型，支持无 GPU CPU 服务器、Mac mini Metal 与可选 CUDA；模型不随普通构建下载。部署、模型大小、鉴权和隐私边界见 [服务端语音识别](docs/server-speech.md)。设置内下载/初始化 LAYA 与语音模型，以及「石一」（决策专家）的本机性能检查和默认本地/免费调用链，见 [本地模型管理](docs/local-model-setup.md)。

### 可选本地决策（实验性）

Apple Silicon 服务端可共享一份离线 Laya-MLX，为结构化 CLI 提供通用选择、评分和是非判断。它不是聊天模型，也不负责授权或自动派工。

```bash
wand decision:configure --python /绝对路径/venv/bin/python --model /绝对路径/多语言模型目录
wand decision:skills                 # 安装七种CLI共用的 wand-decision 技能
# 重启现有Wand服务，新建结构化CLI会话后使用该技能。
```

需先安装依赖和校验过的多语言模型，本命令不自动下载。Skill辅助命令通过已有HTTP服务调用，凭据只在本轮执行环境中，最长6小时、结束撤销；不写进Skill、不另开公网端口。单例worker空闲5分钟卸载，超长输入拒绝截断后判断。普通终端/在Wand外启动的CLI不自动获得凭据。停用：`wand decision:configure --disable`，然后重启服务。

Web/Android 的推理调用独立显示为「本地决策」卡，不混入普通工具分组；详情默认收起，点击卡头原位展开输入与结果，显式展开/收起状态在刷新和结果迟到时保留。读取Skill和查询状态仍按普通工具处理。本机合成任务评测发现明显误判和高概率选错，目前只能作为可选参考；不得据此自动审批权限、执行危险操作或派工。部署细节见 [AGENTS.md](AGENTS.md)。

### 系统服务

默认走 **system-wide**：Linux 写 `/etc/systemd/system/wand.service`，macOS 写 `/Library/LaunchDaemons/com.wand.web.plist`。开机自启、不依赖 login session、`service wand` / `systemctl status wand` 这些老命令都能用。系统服务变更需要管理员权限，Wand 会自动申请 sudo，让你在终端输入密码（不显示、不读取、不保存）。无交互终端时仅允许已经授权的非交互 sudo。重启会先等待 Core 回合排空，再优雅重启 Server，保留 Render/terminald；可用 `--timeout <秒数>` 限制等待时间，超时不停止服务。

```bash
wand service:install   # 注册并启动（自动申请 sudo）
wand service:status    # 查状态（active / inactive / failed） — 读取不要 sudo
wand service:start     # 启动
wand service:stop      # 停止
wand service:restart   # 安全重启（自动申请 sudo）
wand service:logs      # 看最近日志（--lines N 调整行数）
wand service:uninstall # 卸载（停服 + 删 unit）
```

不想用 sudo？传 `--user` 切到 user-level（写 `~/.config/systemd/user/wand.service` 或 `~/Library/LaunchAgents/`）：

```bash
wand service:install --user
wand service:status --user
# ...其他子命令同理
```

> User-level 版本登出后会被回收，除非跑 `loginctl enable-linger $USER`。

服务装好后，`wand web` 会自动检测正在运行的实例（同一份 `config.json` 下）并以 TUI 模式 **attach 到现有 service**，不会重复启动第二个进程。多份配置（`-c` 指向不同路径）之间彼此隔离，互不影响。

### 开发

```bash
npm install                # 安装依赖
npm run dev                # 从源码直接启动开发服务器
npm run check              # TypeScript 类型检查
npm run build              # 编译 + 复制静态资源到 dist/
```

本机开发环境统一调用用户主目录入口：`~/start.sh` 构建/安装当前代码并重启，`~/start.sh --restart` 仅重启、不重新构建，`~/start.sh --status` 查状态。入口自动进入项目并在本地处理 sudo，外层不要再加 sudo；它是本机配置，不随新克隆提供，凭据不入仓库。重启安全约束仍以 [AGENTS.md](AGENTS.md) 为准。构建/检查共用项目锁，本地部署与 npm 更新共用全局安装锁；锁忙时在包或服务修改前拒绝执行。本地 Beta 版本仅写入构建信息和私有打包快照，不改共享工作树的包版本文件。`build:body` / `check:body` 是加锁入口的内部步骤，不直接调用。

隔离测试环境（不影响生产实例）：

```bash
npm run dev -- -c /tmp/wand-test/config.json
```

### 项目结构

```
wand/
├── src/
│   ├── cli.ts                    # CLI 入口
│   ├── server.ts                 # Express 服务器 + WebSocket
│   ├── process-manager.ts        # PTY 会话编排
│   ├── structured-session-manager.ts  # 结构化会话编排（非 PTY）
│   ├── claude-pty-bridge.ts      # PTY 输出解析为结构化对话
│   ├── storage.ts                # SQLite 持久化
│   ├── config.ts                 # 配置加载
│   ├── provider-catalog.ts       # Provider 唯一真源（服务端与浏览器共用）
│   └── web-ui/                   # 前端 HTML/CSS/JS（legacy TS + React 两层）
├── browser-extension/            # MV3 密码库浏览器扩展
├── android/                      # Android 客户端（submodule）
├── ios/                          # iOS 客户端（submodule）
├── macos/                        # macOS 客户端（submodule）
├── render/                       # Render 源码：Rust 常驻进程，持有 PTY（submodule）
└── render-bin/                   # Render 各平台产物 + manifest（submodule，只由 CI 写入）
```

配置分三处：部署项（`config.json`）、用户偏好（SQLite `pref:*`，设置面板与 `wand config:set` 都写这里）、密钥（SQLite，不回写 JSON）。

服务端开发只需检出固定版本的 Render 二进制。原生客户端和 Rust 源码都是独立子模块，修改哪个再检出哪个：

```bash
git clone https://github.com/co0ontty/wand.git
cd wand
git submodule update --init -- render-bin
# 按需：git submodule update --init -- android  # 或 ios、macos、render
```

全量 `npm test` 包含跨端源码契约检查，运行前另检出 `android ios macos render`。品牌一致性用例还会读 iOS/macOS 的 AppIcon PNG（生成物），在 macOS 上先跑 `npm run sync:brand-assets`，再用 `swift <平台>/scripts/generate-icons.swift` 生成（CI 的 `.github/workflows/ci.yml` 做同样的事）。
`npm run clean:build-cache` 预览可清理的编译缓存，追加 `-- --apply` 才执行删除；
保留分发包、Release Render 二进制、签名、依赖和会话数据。
macOS 每日清理历史归档编译中间物（保留7天）用 `npm run clean:build-cache:install -- --install`；
范围、并发保护、日志和停用方式见[自动清理说明](docs/build-cache-cleanup.md)。不修改Git hook，不自动删除现用原生构建树。

通过 npm 安装后，运行存储维护默认在后台自动执行：回收过期临时残留与无引用的上传文件，限制诊断日志大小并清理过期轮转日志。无需源码仓库或日常手动操作，保留会话历史和正在使用的文件。
归属判断、保留时间与可选管理员诊断入口见[运行存储自动维护](docs/storage-cleanup.md)。

数据存储在 `~/.wand/` 下：`config.json`（配置）、`wand.db`（SQLite）、`sessions/`（日志）。

### License

MIT
