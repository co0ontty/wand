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
