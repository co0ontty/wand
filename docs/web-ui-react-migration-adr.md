# Web UI React/Radix 迁移架构决策

状态：已采纳  
日期：2026-07-16

## 背景

原 Web UI 由 TypeScript 拼接 HTML、全局可变状态与命令式事件组成。完整 `render()` 会替换 `#app`，使终端节点、聊天滚动位置、输入草稿、选区和 IME composition 容易在低频 Shell 更新时丢失。设置与弹层还分别维护焦点、Escape、Portal、异步状态和移动端滚动锁。

此次改造需要在不改变 Express、单页 IIFE、embedded asset 和原生 WebView 协议的前提下，引入成熟组件模型；同时避免一次性重写终端、流式 Chat 与 Composer 的高风险业务。

## 决策

采用 React 19 + Radix Primitives，按领域渐进迁移。

- React 负责应用 Shell、标准表单和 Overlay；Radix 只能从 `src/web-ui/react/ui/` 的项目级封装中导入。
- Repository Interface 隔离 HTTP；生产使用 HTTP Adapter，测试使用 Memory Adapter。
- `UiStore` 通过不可变快照和领域 action 连接现有状态。React 不直接访问 Legacy 全局 state、WebSocket 或业务 DOM。
- Terminal、流式 Chat、Composer 暂时保留命令式实现。React 只提供稳定 Host 根节点，Legacy 只能管理这些根节点的子树。
- `#overlay-root` 独立于 `#app`，统一承载 Dialog、Toast、Popover 与 Select Portal。
- 登录页暂保留 Legacy 渲染；认证后的 Shell 由 React 挂载。每迁移一个功能，同一任务删除对应旧 HTML、监听器、状态与专用 CSS，不保留长期双实现。
- 保留运行时 feature flag 作为短期回退通道；不改变原生 bridge 的 selector、`window.*`、CustomEvent、safe-area 与返回键协议。

## 模块边界

```text
Browser/WebView events
        │
        ▼
Legacy state ── snapshot ──► UiStore ──► React Shell
        ▲                       │
        └──── command port ◄────┘

React feature ──► Repository Interface ──► HTTP Adapter
       │
       └────────► Memory Adapter（测试）

React Shell ── stable host roots ──► Terminal / Chat / Composer legacy children
```

边界规则由架构测试约束：业务 React 模块不得直接操作 Legacy DOM/state；Radix 依赖不得越过 UI wrapper；React TypeScript 必须通过 `strict`/`noImplicitAny`。

## 收益

- Shell 更新不再要求替换高频交互节点，降低焦点、滚动、选区与 IME 回归风险。
- Dialog、Toast 与复杂表单获得一致的焦点陷阱、Escape、Portal、无障碍语义和异步状态模型。
- Repository/Memory Adapter 与纯模型使关键行为可以脱离浏览器测试。
- 领域 action 和稳定快照切断 `state/render/websocket` 的直接循环，为后续模块独立演进提供边界。
- 迁移可以按功能回滚，不要求同时重写终端与流式消息核心。

## 成本与取舍

- React、ReactDOM 与 Radix 增加 bundle；以生产 gzip 增量 120 KiB 为决策门限。
- 过渡期需要维护 Browser Adapter 和稳定 Host 契约，代码总量会短期上升。
- React 与 Legacy 共存时必须严格保证单一 DOM ownership；错误越界会造成重复监听或节点被重建。
- Terminal、Chat、Composer 的内部实现不会立即获得 React 的声明式收益，但保留它们显著降低本次迁移风险。

## Terminal、Chat、Composer 的后续决定

本轮将三者作为长期可支持的 imperative Adapter 保留，不安排完整重写。只有在独立评审证明下列收益高于风险时才继续迁移：缺陷率明显下降、业务测试可覆盖、流式性能无退化、IME/选区/滚动在 Android 与 iOS WebView 中稳定，并且 bundle 仍在预算内。

## 验收与回退

- `npm run check`、`npm test`、`npm run build` 和浏览器关键路径必须通过。
- 覆盖 375、768、1440 三档视口、键盘/焦点、自动无障碍、原生 bridge 静态契约。
- 验证 Terminal Host identity、Chat scroll、Composer draft/selection/composition 在 Shell 更新前后保持。
- 记录最终 JS/CSS gzip 并与迁移前基线比较；超预算或出现 P0/P1 时保持 feature flag 回退并停止扩大范围。

## 完成范围

本轮已完成认证后 React Shell、通用 Dialog/Toast、Settings、New Session、Quick Commit、Folder Picker、Worktree Merge、File Preview、Restart/Auto-update Overlay 与文件抽屉迁移。Terminal、流式 Chat、Composer、File Explorer 和跨会话队列继续由 Legacy 管理其稳定 Host 的子树；React 不重建这些根节点。

运行时 `reactUi=0` 会回退到 Legacy Shell，并让通用 confirm/prompt 与通知使用浏览器/Legacy 通道。已经没有 Legacy 实现的业务 Overlay 仍保持 React Host 挂载，New Session、Settings、File Preview、Quick Commit、Worktree Merge 和 Folder Picker 的公开入口继续可用。

## 定量结果

| 指标 | 迁移前 | 最终 |
| --- | ---: | ---: |
| Browser TypeScript | 24,919 行 | 19,939 行 |
| Legacy CSS | 17,598 行 | 12,029 行 |
| Legacy + React 样式 | 17,598 行 | 14,832 行 |
| `addEventListener` | 301 | 187 |
| `getElementById` | 539 | 224 |
| `innerHTML` / `insertAdjacentHTML` | 103 | 55 |
| 直接 state 写入 | 623 | 523 |
| 生产 JS gzip | 148,590 bytes | 268,022 bytes |
| 生产 CSS gzip | 53,661 bytes | 37,307 bytes |
| 生产主资源总 gzip | 202,251 bytes | 305,329 bytes |

总 gzip 增量为 103,078 bytes（100.7 KiB），低于 120 KiB 决策门限。新增 React TS/TSX 为 15,140 行；它包含 UI wrapper、领域 Controller/Repository/Host、状态桥、严格类型与测试友好边界。

## 最终验证

- `npm run check` 通过，包括主工程、Browser 与 React 三套 TypeScript 配置。
- Node 测试 289/289 通过，覆盖架构边界、Controller、Repository、Store、原生协议与回退语义。
- Playwright 144/144 通过，覆盖 Chromium Desktop、Edge 兼容配置、Chromium Tablet/Mobile、WebKit Desktop/Mobile，并包含 Axe、焦点、IME、返回键、Shell identity 和公开业务入口。
- `npm run build` 与 `git diff --check` 通过；独立集成复核未发现剩余 P0/P1/P2。

## 发布环境限制

当前机器未安装可直接调用的 Microsoft Edge 品牌二进制，安装包需要交互式 sudo，因此本轮使用 Edge device profile + Chromium 内核验证兼容性。WebKit 覆盖 Safari 引擎，但真实 Android/iOS WebView 与触屏设备仍属于发布环境 smoke test。此次未修改 Android 工程或配置，未触发 APK 构建；也未执行外部 Beta 发布。

## 后续变更（2026-09-16）

本文第 22/67/73 行记录的「运行时 feature flag 回退通道」已部分收敛：

- **已删除** `?reactShell=0`、`localStorage["wand.reactShell.enabled"]`、`window.__wandFeatureFlags.reactShell` 与 `isReactShellEnabled()`。认证后的 Shell 不再有回退路径，`renderBrowserReactShell()` 的返回值从 `"disabled" | "mounted" | "updated"` 收窄为 `"mounted" | "updated"`。原因是该回退在生产中从未被测过（仅 3 处测试引用），且它把「React 挂载失败」静默降级成一个没人维护的 legacy Shell；现在挂载失败会显示可重试的 boot 错误卡片。
- **保留** `?reactUi=0`，但语义收窄为「通用对话框/通知层退回原生 confirm/prompt + legacy 气泡」，不再影响 Shell。它仍被 84 处 legacy 调用点依赖。

`renderAppShell()` 暂时保留：它仍是 legacy 槽位（`#output`/`#chat-output`/`.input-panel`/`#file-explorer`/`#cross-session-queue-host`）的 seed markup 模板，删除它需要先让 React 自己渲染这些稳定容器（见 `docs/optimization-plan.md` 的后续切片）。

## 技术栈统一路线（2026-09-16，第二轮）

用户决策：**结构/技术栈尽量统一**，接受较大工作量以换取长期收益。目标态收敛为一句话：

> React 是唯一 UI 技术栈；`src/web-ui/browser/*.ts` 只保留「引擎与协议」——xterm 终端引擎、PTY/WS 传输、provider parser、纯逻辑工具。它不再渲染 HTML、不再持有 UI 状态、不再直接改 React 拥有的 DOM。

### 当前量化基线

| 指标 | 当前值 | 说明 |
| --- | --- | --- |
| legacy 层规模 | 20,588 行 / 43 文件 | `src/web-ui/browser/*.ts`（2026-09-16 第二轮，Phase 1+2 后） || React 层规模 | 149 文件 / 31,291 行 | `src/web-ui/react/**` |
| 返回 HTML 的 legacy `render*` 函数 | 42 | 全仓 `render*` 命名口径；另有大量返回 HTML 片段的非 `render` 辅助函数 |
| `innerHTML` 写入点 | 40 | session-engine、chat-render、events、websocket… |
| legacy 槽位 | 5 | `#output`、`#chat-output`、`.input-panel`、`#file-explorer`、`#cross-session-queue-host` |
| React 挂载时的死分支 | 0 处守卫 | `isBrowserReactShellMounted()` 只剩 `render.ts` 定义点与 `shell-runtime.ts` 定义 |

### 分期（每期独立可验证、可回滚）

**Phase 1 — 清掉 React 外壳下不可达的一切（纯删除，零行为变化）**

证据基线：登录页 0 命中全部目标节点；认证态命中项一律 React-owned 或 legacy 槽位。因此「React 未挂载」分支不可达。

- ✅ 已删：`updateShellChrome`/`applyCurrentView` 的 ABSENT 节点写入（`#terminal-title`/`#terminal-info`/`#session-kind-display`/`.session-summary-value`/`.topbar-tagline`/`#blank-chat-cwd-path`）。
- ✅ 已删：`updatePinState`/`updateDrawerState`/`updateSidebarCollapseButton`/`updateFilePanelState`/`updateFilePanelCwd`/`updateTopbarGitBadge` 的不可达 DOM 写入，收敛为 `notifyLegacyUiChange`；folder-picker 的 `#blank-chat-cwd` 写入与 document 代理。
- ✅ 已删（3 个提交，-922 行）：
  1. `sidebar.ts` 会话列表渲染簇（`renderSessions`/`renderSessionsListContent`/`renderSessionManageBar`/`renderSessionEntries`/`renderAutomationSessionGroup`/`renderManageCheckbox`/`renderClaudeHistoryItem`/`renderCollapsedSessionTiles`）+ `session-ui.renderSessionItem` + `session-engine` 的 `#sessions-list` 守卫分支 + `render.ts` seed 里的 `renderSessionsListContent()` 调用。
  2. `events.ts` 三处 `if (!reactShellActive) { … }` 块与 5 处 `if (isBrowserReactShellMounted()) return;`（1002 → 683 行）。
  3. `input.ts`/`websocket.ts`/`file-browser.ts` 的死守卫与 DOM 写入（`#current-task` 三元、`terminalTitle`/`terminalInfo`/`sessionSummary`、`cwdEl`）+ `file-explorer-adapter.ts` 整个文件。
- 有意保留：`render.ts` 的 `shouldResetShell`（`!isLoggedIn` 仍活，第二项不可达性未严格证明，收益 1 行）。

**Phase 2 — 删掉不可见/重复的 legacy 子系统**

- ✅ 已删（-498 行）：legacy 文件浏览器扁平列表（`file-browser.ts` 的图标库/`renderFileExplorer`/`refreshFileExplorer`/`filterFileTree`/树节点渲染/右键菜单）、`state` 的 `fileExplorer*` 字段、`shell-commands` 的 5 个文件命令、`ui-store` 的 5 个 action 与 `legacy-ui-actions` 映射、`render.ts` seed 里的文件面板 markup（只留 `#file-explorer` 槽位锚点）。
  - 前置已先做：`installFilePreviewLegacyAdapter` 的 `getSiblings` 改为按预览路径父目录读 React `fileExplorerStore` 条目。
  - 实测收益：开面板时隐藏宿主写入 **113,267 → 0 字符**，同目录 `/api/directory` 由 2 次去重为 1 次。
  - 顺带修一处由此暴露的缺陷：`ShellFilePanel.committedCwd` 原为 ref，`commitCwd` 的 `setCwd` 常与当前值相同而被 React bail-out，ref 更新不再传给 `FileExplorerHost` 的 `root`，回车后文件树不重载 → 改为 state。
- ⏳ 待做：
  1. `#file-explorer` 空槽位锚点与 `explorerRef`（删除需 Phase 4 一并移除槽位机制）。
  2. `input.ts` 的 `executeDeleteHistory`/`getHistoryItemsByCwd`/`setDeletingState` 簇（`.claude-history-item` 自 Phase 1 起已无渲染者）。
  3. `state.topbarMoreOpen`（值为 false 时仍被 `deriveLegacyUiSnapshot` 读取；写入点在 seed 中）。

**Phase 3 — 逐个把 legacy 槽位换成 React 组件（收益主体）**

按「行数 × 改动风险」排序，一次一个槽位，每个都保持可交付：

1. `.input-panel` 组合器：`session-engine.renderComposerConfigControlsHtml`/`renderThinkingOptions`/`renderClaudeSkillsPickerHtml`/`renderChatModeTrioHtml`/`renderAutoApproveChip` 等 → React 组件（~1,000 行 legacy 模板）。
   - ✅ 已迁（`84c7507`）：自动批准 chip 与自动批准统计徽章。新增 `react/composer-badges/`（controller + host）与 `browser/composer-badges-adapter.ts`，沿用 `composer-select` 已经确立的 portal 约定。legacy 侧只推送值与可见性，`renderAutoApproveChip` / `renderApprovalStatsBadge` / `updateApprovalStats` 与 `updateAutoApproveIndicator` 的节点改写全部删除，收敛到 `syncComposerBadges()`。
     - 关键约束：宿主 span 常驻种子 markup，空状态用宿主上的 `.hidden` 表达 —— `.composer-status-row:has(> *:not(.hidden))` 的折叠判定与 `.input-composer:has(.permission-actions:not(.hidden)) > :not(.permission-actions)` 都依赖子节点的 class，用 `display: none` 或移除节点会破坏它们。宿主 `display: contents` 让徽章继续作为状态行的 flex item。
     - `total === 0` 继续视为「无统计」（服务端会给会话挂 `{ total: 0 }`，那不是有统计）。
     - controller `sync` 幂等：值没变不广播，否则每次 `render()` 都会重放脉冲动画。
     - 可复用的迁移模式：种子留 `[data-*-host]` 宿主 → browser 适配器扫宿主并 `sync(mounts)` → React `createPortal` 渲染 → 交互闭包回调 legacy 命令。`model`/`thinking`/`mode` select 早前已按此模式迁完。
   - ⏳ 同一槽位剩余：`model-refresh-button`、三件套容器的 `title` 同步（`refreshComposerConfigControls`）、`#todo-progress`、语音气泡、输入行按钮状态、`#input-box`、`#composer-skills-popover` 本体。
   - ✅ 已迁（`623c33a`）：composer 三件套（mode/model/thinking）与 Skills 按钮。新增 `react/composer-config/`（`ComposerConfigScope = "mode"|"runtime"|"all"`）与 `browser/composer-config-adapter.ts`；`renderComposerSelectHost` / `renderComposerConfigControlsHtml` / `syncModelRefreshButtons` 删除，`refreshComposerConfigControls` 改为发布快照。
     - 该适配器必须 `flushSync` 提交：chip 内部还要长出 `[data-composer-select-host]`，同帧才能被 `syncBrowserComposerSelects` 扫到。
     - 踩坑记录（皆为本轮自引入并当次修复）：① 替换 `composer-inline-config` 时多写一个 `</div>`，`.input-panel` 提前闭合，其后的 `#composer-plus-popover`/`#voice-transcript-bubble`/`#action-error`/`#composer-skills-popover` 被 `replaceChildren()` 静默丢弃 —— 现在由 `tests/web-ui-composer-seed-structure.test.ts` 用源码级标签平衡断言钉住；② `events.ts` 的「点外部关闭 Skills」守卫没排除 trigger 自身，点击立即被自己的关闭逻辑抵销。
   - ✅ 已迁（`d8cb130`）：加号 popover 内两个条目（上传附件、终端交互开关）。新增 `react/composer-popover/` 与 `browser/composer-popover-adapter.ts`。
     - **只迁「内容」不迁「容器」**：容器 `#composer-plus-popover`、开合状态、键盘导航、点外部关闭都绑在容器节点上，留在 legacy；React 只管两个条目。
     - 条目必须保留 `.hidden` class 而非删节点：Android 注入脚本仍按 id 点 `#terminal-interactive-toggle-top`。
     - 该适配器同样 `flushSync`：Android 侧点完立刻读 `aria-pressed`。
   - ✅ 已重构（`3f33356`）：抽出 composer portal 宿主共用的注册表与同步骨架 —— `react/composer-portal/mount-store.ts`（`MountSnapshot`/`MountStore`，`equals` 由构造注入）与 `browser/mount-sync.ts`（`syncPortalMounts`，`flush` 为显式选项）。三个 controller 收敛为 `extends MountStore<...>` 薄封装（类名与单例导出不变）；`sync` 幂等、回调不参与比较、业务规则留在 legacy 侧的 `build` 里。
   - ✅ 已迁（`20b9ad9`）：错误条 `#action-error`。文案存 `state.actionError`，无错误时不发布 mount（等价旧的 `.hidden` 且不占布局）。同时删掉 `resumeSession(sessionId, errorEl?)` / `ensureSessionReadyForInput(session, errorEl?)` 的 `errorEl` 参数 —— 唯一调用点从不传它，`if (errorEl) showError(...)` 是死分支，现直接 `showToast(...)`（行为不变）。
   - ✅ 已迁（`88bd2c8`）：待发送附件预览 `#attachment-preview`。新增 `react/composer-attachments/` 与 `browser/composer-attachments-adapter.ts`；`renderAttachmentPreview()` 不再拼 `innerHTML`、不再逐次重挂 `.att-remove` 监听。`previewUrl` 的 `createObjectURL`/`revokeObjectURL` 仍归 legacy 侧（React 只显示），`formatFileSize` 等业务格式化留在 legacy。
     - 迁移前 grep 原生壳是否按 id/aria 引用目标节点，是这几次的固定前臵步骤（Android `EnableTerminalPassthroughScript` 依赖 `#terminal-interactive-toggle-top` 的 id 与 `aria-pressed`）。
   - ✅ 已迁（`49de482`）：语音转写气泡 `#voice-transcript-bubble`。新增
     `react/composer-voice/` 与 `browser/composer-voice-adapter.ts`；`.has-text`
     由 `transcript !== ""` 推导（旧代码就是 `toggle("has-text", !!transcript)`）。
     录制按钮 `#voice-record-btn` 暂留 legacy —— 它的 pointer 监听直接绑在节点上，
     迁它需要先建立「React 渲染 + 事件委托」的模式。注意该按钮只在原生壳可见
     （`html:not(.is-wand-app) .input-composer .btn-circle-voice { display: none }`），
     STT 由原生端调 `updateVoiceTranscript`（保留为唯一注入点）注入。
   - ✅ 已迁（`41884bc`）：Skills 弹层本体。触发按钮早在 `623c33a` 就迁到 React，
     这次补齐弹层，两侧不再一半 React 一半 legacy。`renderClaudeSkillsPickerHtml`
     与 `picker.outerHTML = markup` / `insertAdjacentElement("afterend")` 全部删除。
     保留 `#composer-skills-popover` 的 id 与 role/aria —— `events.ts` 的
     「点外部关闭」与 Escape 仍按该节点判断；选项点击委托删除，改由 React onClick。
     顺手修一处既有缺陷：切换会话只重置了 `state.claudeSkillsPickerOpen` 而没人
     重新渲染弹层，弹层会残留上一个会话的内容（旧实现同样有问题）。
2. `#chat-output` 聊天渲染：`chat-render.ts` **4,040 行 / 129 个渲染函数**（气泡、工具块、活动行、折叠窗、附件、审批）→ React。这是最大单笔收益，也是最大风险，需要按块灰度（先文本/工具块，后活动/折叠/附件）。
3. `#output` 终端：**不重写 xterm**。改为 React 组件持有容器并挂载客户端实例，legacy 只暴露引擎 API（写入、fit、replay、交互态）。这是「统一技术栈」与「不重写成熟引擎」的边界。
4. `#cross-session-queue-host`：队列条迁 React，删除 legacy 队列 DOM 与 `attachQueueBarDelegates`。

**Phase 4 — 状态单一数据源与构建统一**

- 收敛重复状态：legacy `state.*` 中镜像 `UiStore` 快照的字段改由 React store 提供，`deriveLegacyUiSnapshot` 逐步缩小；目标是 legacy 不再有自己的 UI 状态。
- 删除 5 个 legacy 槽位与 `renderAppShell()`（Phase 3 完成后才可能）。
- esbuild `splitting: true` + `React.lazy` 拆分重面板（任务看板、工作区、代码编辑器、设置、文件预览），vendor 独立 hashed chunk；`check-bundle-budget.js` 预算随之下调。

### 边界（不做的事）

- **不重写 xterm**：终端引擎保持命令式，仅由 React 组件持有容器。
- **不合并两套 runner**：PTY 与 structured 的执行代码分离是既有决策，与 UI 技术栈无关。
- **`?reactUi=0` 暂留**：它 gate 的是通用对话框/通知层（84 处 legacy 调用点），删除属于 Phase 4 的产品决策。

### 每期验证门

`npm run check` + `npm test`（当前 **738** 通过）+ `npm run build`（含 gzip 预算：js 475.8/500 KiB、css 91.7/97.7 KiB）+ 真机 Playwright 核对：认证桌面 / 移动端 390px / 原生 embed 壳（`is-wand-app`+`is-wand-embed-terminal`）/ `?reactUi=0`，断言 5 槽位齐备、目标功能可用、**0 console 错误**。

迁移后的探针约定（本轮固定下来的手法）：

- 用 `Object.keys(el).find(k => k.startsWith("__reactFiber$"))` 判定「节点由 React 渲染」，并沿 `fiber.return` 读 `memoizedProps.mount` 直接比对 legacy 发布值与渲染结果。
- 叶子功能必须在**真实交互路径**上验证：附件预览用 `setInputFiles` 走真实上传，不用合成 `dispatchEvent`。
- 需要人为触发时（如错误条只在删除失败时出现），临时暴露入口做端到端验证，验证后**还原且确认无残留**，再跑一次全量测试。
