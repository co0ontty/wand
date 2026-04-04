# Web UI 运行逻辑

wand 的前端不是独立构建产物，而是由服务端在请求 `/` 时拼出的一份 HTML 文档。理解这一点非常重要，因为它决定了前端的加载方式、资源组织方式、以及很多“为什么这里没有前端打包产物”的问题答案。

## 1. 浏览器拿到页面时发生了什么

### 1.1 `renderApp(configPath)` 组装 HTML
`src/web-ui/index.ts` 的 `renderApp(configPath)` 会：

1. 调用 `getCSSStyles()` 读取 CSS 文本
2. 调用 `getScriptContent(configPath)` 读取脚本文本并注入配置路径
3. 拼出完整 HTML 字符串
4. 在页面里引入：
   - `/vendor/xterm/lib/xterm.js`
   - `/vendor/xterm-addon-fit/lib/addon-fit.js`
5. 把 CSS 内联进 `<style>`
6. 把主脚本内联进 `<script>`

也就是说，浏览器端主逻辑不是从打包后的 JS chunk 加载，而是从 HTML 里直接执行。

### 1.2 CSS 与 JS 的来源
- `src/web-ui/styles.ts`：读取 `content/styles.css` 并缓存到 `_cssCache`
- `src/web-ui/scripts.ts`：读取 `content/scripts.js` 并缓存到 `_scriptCache`
- `scripts.ts` 还会把模板中的 `${escapeHtml(configPath)}` 替换成当前运行时的 configPath

因此：

- 前端没有模块拆包
- 所有浏览器端状态和逻辑基本都集中在 `src/web-ui/content/scripts.js`

## 2. 页面初始启动链路

浏览器一加载脚本，就会先处理两类“环境层”逻辑：

### 2.1 PWA / Service Worker
脚本会：

- 先尝试 `fetch('/sw.js')`
- 如果成功，再 `navigator.serviceWorker.register('/sw.js')`
- 监听 `controllerchange`，在非初始加载阶段自动刷新页面
- 处理 display-mode 检测，为根元素打 `data-display-mode` 和 `is-pwa` 样式标记

### 2.2 全局 `state`
`scripts.js` 顶层维护一个非常大的 `state` 对象，保存：

- 当前选中的 session
- 轮询与 suggestion timer
- xterm 实例与 fit addon
- 终端输出缓存
- 输入队列
- drafts 草稿
- 登录状态
- modal / drawer 状态
- 当前视图（chat / terminal）
- 当前任务标题
- 文件浏览相关状态
- Claude history 相关状态
- working directory
- 最近的渲染 hash 与消息数量

前端本质上是“单文件 + 单大状态对象 + 一批 DOM patch 函数”的架构。

## 3. 登录恢复与首屏加载

脚本启动时首先执行：

1. `renderBootLoading()`
2. `restoreLoginSession()`

### 3.1 `renderBootLoading()`
先把页面替换成“正在恢复会话”的 loading UI。

### 3.2 `restoreLoginSession()`
它通过 `fetch('/api/config', { credentials: 'same-origin' })` 判断是否已经登录：

- 如果成功拿到配置：认为当前 cookie 有效，进入主界面初始化
- 如果失败：显示登录页或离线提示

这是一个很关键的设计：**前端并不先问“我是否已登录”，而是直接请求一个需要登录的资源并以结果反推状态。**

## 4. 登录成功后的主界面初始化

在 `restoreLoginSession()` 成功分支里，前端会：

1. 保存 `state.config`
2. 先渲染 app shell
3. `startPolling()`
4. `refreshAll()`
5. 请求浏览器通知权限
6. 根据 `/api/config` 结果决定是否显示更新通知
7. 如果 Claude history 默认展开，则加载 Claude history

也就是说，前端数据源不是纯 WebSocket，也不是纯 HTTP，而是：

- 首屏靠 REST 拉快照
- 后续靠 WebSocket + polling 混合刷新

## 5. UI 视图结构的核心概念

前端至少同时维护几组主要界面：

- 登录页
- 主工作区
- sidebar / sessions drawer
- terminal 视图
- chat 视图
- 设置弹窗
- 新建会话弹窗
- 文件浏览/目录选择弹窗
- Claude 历史区块

从用户视角看像一个“Web terminal app”，但从实现上，它更接近一个由大量模板字符串和局部 DOM 更新函数组成的状态驱动 UI。

## 6. 终端视图如何工作

终端视图依赖 xterm.js。

### 6.1 关键状态
- `state.terminal`
- `state.fitAddon`
- `state.terminalSessionId`
- `state.terminalOutput`
- `state.terminalScale`
- `state.lastResize`

### 6.2 核心行为
前端会：

- 初始化 xterm
- 把后端发来的 raw output 写入 terminal
- 通过 `/api/sessions/:id/resize` 把终端大小同步回后端 PTY
- 维护自动滚动到底部、跳到底部按钮、缩放等交互

所以 terminal 视图的“真数据”来自 `output.raw` / snapshot.output，而不是结构化消息。

## 7. chat 视图如何工作

chat 视图依赖结构化 `messages`。

数据来源优先级：

1. WebSocket 推来的 `output.chat`
2. 会话详情接口返回的 `messages`
3. 如果没有 `messages`，后端可能已经在 `/api/sessions/:id?format=chat` 里降级从 output 解析

前端在渲染时会追踪：

- `state.currentMessages`
- `state.lastRenderedHash`
- `state.lastRenderedMsgCount`
- `state.renderPending`

这些字段用于减少重复渲染开销。

## 8. 为什么一个页面里同时有 polling 和 WebSocket

这不是冗余，而是出于可靠性和初始化考虑。

### WebSocket 负责
- 实时输出流
- started / ended / status / task / notification
- 首次 subscribe 后的 init snapshot

### Polling 负责
- 登录恢复后的初始刷新
- 某些非流式状态的兜底同步
- WebSocket 断线期间的状态刷新

这也解释了为什么 `state` 里既有 `pollTimer`，也有 `ws` / `wsConnected`。

## 9. 文件浏览与工作目录切换

前端支持：

- 路径建议
- 项目内目录浏览
- 任意目录的文件夹选择器（受后端敏感路径限制）
- 收藏路径 / 最近路径
- 文件搜索
- 文件预览

这些都通过 REST 接口驱动，而不是 WebSocket。前端只负责：

- 保存选择状态
- 打开对应 modal / panel
- 根据返回数据渲染列表

## 10. Claude history 区块

前端会维护一份独立的 Claude 历史状态：

- `state.claudeHistory`
- `state.claudeHistoryLoaded`
- `state.claudeHistoryExpanded`
- `state.claudeHistoryExpandedDirs`
- `state.selectedClaudeHistoryIds`

对应后端的 `/api/claude-history*` 系列接口，用于：

- 查看 Claude 原生历史会话
- 批量删除/隐藏
- 按 Claude session ID 恢复

这说明“会话列表”其实分成两套：

- wand 自己管理的 session
- Claude 原生历史扫描出来的 session

## 11. 输入框与消息发送逻辑

前端发送消息时，不是直接往 WebSocket 发文本，而是走 HTTP：

- `POST /api/sessions/:id/input`

原因是：

- 后端要在写入 PTY 前更新 lifecycle
- 还要同时通知 `ClaudePtyBridge` 启动 chat turn 跟踪
- 某些输入还要带 `view`、`shortcutKey` 等额外上下文

因此这里是一个“命令式 API”，不是简单的 socket write。

## 12. 权限请求在前端如何呈现

当前端收到会话 snapshot 或 WebSocket 事件，发现 session 上有：

- `permissionBlocked`
- `pendingEscalation`
- `lastEscalationResult`

就会渲染审批相关控件，并通过：

- approve-permission
- deny-permission
- escalations/:requestId/resolve

把决策发回后端。

这部分 UI 不是独立的权限系统，而是会话视图中的一部分状态投影。

## 13. PWA、离线与浏览器通知

前端除了核心会话功能，还处理几个“壳层能力”：

### 13.1 离线提示
监听 `online` / `offline`，在离线时显示 banner。

### 13.2 安装提示
监听 `beforeinstallprompt`，决定是否显示安装按钮。

### 13.3 浏览器通知
登录后主动请求通知权限，并在有新版本时显示通知泡泡与浏览器通知。

因此这个前端不只是 terminal/chat UI，还承担了完整的 Web App shell 行为。

## 14. 构建与部署对前端的真实要求

由于前端没有单独 bundler，真正影响产物可用性的关键是：

- TypeScript 要编译 server 代码
- `src/web-ui/content/` 必须被复制到 `dist/web-ui/`

`package.json` 里的：

```json
"build": "tsc -p tsconfig.json && npm run build:copy-content"
```

就是为了保证打包后的 `dist/cli.js` 在运行时还能找到浏览器资源。

如果未来改动 build 过程，最容易破坏的地方就是这一层。

## 15. 这个前端架构的维护含义

### 优点
- 部署简单
- 无额外前端构建链
- 运行时只依赖 Node 服务本身

### 代价
- 浏览器代码集中在单文件 `scripts.js`
- 缺少模块化边界
- 很多 UI 更新依赖手写 DOM 与状态同步
- 某些复杂功能更难局部演进

因此后续做前端修改时，最重要的是先分清变更属于哪一类：

- 纯 DOM 呈现问题
- 状态同步问题
- WebSocket / polling 数据源问题
- 后端 API 语义问题

否则容易在错误层面修 bug。
