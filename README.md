# wand

[![npm version](https://img.shields.io/npm/v/@co0ontty/wand.svg)](https://www.npmjs.com/package/@co0ontty/wand)
[![license](https://img.shields.io/npm/l/@co0ontty/wand.svg)](https://github.com/co0ontty/wand/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/@co0ontty/wand.svg)](https://nodejs.org)
[![GitHub last commit](https://img.shields.io/github/last-commit/co0ontty/wand)](https://github.com/co0ontty/wand/commits/master)

通过浏览器远程访问和管理本地 CLI 工具的 Web 控制台。专为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 [Codex](https://github.com/openai/codex) 设计，支持终端和结构化对话双视图、会话持久化与恢复、权限管控、文件浏览、Android 客户端等功能。

<p align="center">
  <img src="docs/screenshots/chat-view.png" width="800" alt="结构化对话视图" />
</p>

## 安装

### 一键安装

自动检测并安装 Node.js（需要 v22+），然后安装 wand：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

### 手动安装

```bash
npm install -g @co0ontty/wand
wand init
wand web
```

安装完成后打开浏览器访问终端中提示的地址即可。

### 升级

推荐用同一条一键脚本升级（脚本会自动停掉正在运行的 wand 进程、清理 npm 改名残留再装最新版）：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/co0ontty/wand/master/install.sh)
```

> 也可以直接在网页设置里点「更新」按钮，或在 TUI 模式按 `u`，wand 自己会调用同样的清理逻辑。Web 端点击更新后会自动重启服务，无需手动操作。

如果以前装过 systemd 自启服务但还是 `Restart=on-failure`（v1.25.x 前的版本），重新进入 TUI 按一次 `i` 重装服务即可换成 `Restart=always`，自动更新后才能正确拉起新进程。

## 功能

<p align="center">
  <img src="docs/screenshots/home.png" width="800" alt="欢迎页" />
</p>

### 核心

- **双视图模式** — 终端原始输出和结构化对话视图可随时切换，同一会话两种呈现
- **多 Provider 支持** — 同时支持 Claude Code 和 Codex，可按需创建不同类型的会话
- **会话管理** — 创建、归档、恢复会话；支持从 Claude 原生历史记录恢复；会话列表显示摘要，懒加载
- **权限控制** — 可视化权限提示，支持逐次确认、单次批准、本轮记忆等策略；工具调用自动分组与审批统计

### 交互体验

- **结构化对话** — 代码块语法高亮、工具调用折叠/展开、多问题分组渲染、Token 用量按轮累计
- **个性化角色** — 像素风猫咪头像（赛博虎妞 / 勤劳初二），支持自定义对话角色名称
- **消息排队** — 在 AI 思考时可继续输入，消息自动排队发送
- **文件浏览器** — 内置路径浏览和搜索功能

### 部署与访问

- **PWA 支持** — 可添加到主屏幕作为独立应用使用
- **Android 客户端** — WebView 壳应用，支持加密连接码分发、APK 自动更新检查、原生通知推送、启动器图标切换
- **HTTPS** — 可选自签证书，适合远程或移动端访问
- **版本管理** — 内置更新检查与升级提示

## 截图

| 登录 | 对话视图 |
|:---:|:---:|
| <img src="docs/screenshots/login.png" width="400" alt="登录页" /> | <img src="docs/screenshots/chat-view.png" width="400" alt="对话视图" /> |

| 终端 PTY 视图 |
|:---:|
| <img src="docs/screenshots/terminal-pty.png" width="800" alt="终端 PTY 视图" /> |

## 配置

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
| `password` | (随机生成) | 登录密码 |
| `language` | `""` | Claude 回复语言偏好 |

## 开发

```bash
npm install                # 安装依赖
npm run dev                # 从源码直接启动开发服务器
npm run check              # TypeScript 类型检查
npm run build              # 编译 + 复制静态资源到 dist/
```

隔离测试环境（不影响生产实例）：

```bash
npm run dev -- -c /tmp/wand-test/config.json
```

## 项目结构

```
src/
  cli.ts                    # CLI 入口，解析命令和参数
  server.ts                 # Express 服务器、REST API、WebSocket
  server-session-routes.ts  # 会话/恢复/历史相关路由
  process-manager.ts        # PTY 会话编排、输入输出路由、权限处理
  claude-pty-bridge.ts      # PTY 输出解析为结构化对话数据
  storage.ts                # SQLite 持久化
  config.ts                 # 配置加载与合并
  session-lifecycle.ts      # 会话状态机（idle/thinking/waiting/archived）
  session-logger.ts         # 文件日志 ~/.wand/sessions/
  resume-policy.ts          # Claude 历史绑定与恢复策略
  web-ui/                   # 服务端渲染的前端 HTML/CSS/JS
android/                    # Android WebView 壳应用
```

数据存储在 `~/.wand/` 下：`config.json`（配置）、`wand.db`（SQLite）、`sessions/`（日志）。

## License

MIT
