# Appica UI 迁移

本文件记录 `src/web-ui/react/**` 从手写 CSS + Radix 迁到 [Appica UI](https://www.npmjs.com/package/@appica/ui-react) 的**架构契约与进度**。迁移是分层的、可中断的：加一层不会影响另一层，但下面几条契约必须守住。

## 构建链路

```text
src/web-ui/browser/*.ts + react/*.tsx
  -> scripts/bundle-browser.js      -> src/web-ui/content/scripts.js      （不入库）
src/web-ui/css/appica.css
  -> scripts/bundle-tailwind.js     -> src/web-ui/content/tailwind.css     （不入库）
                                      -> scripts/generate-web-assets.js   -> src/web-ui/embedded-assets.ts（不入库）
```

`tailwind.css` 是 Tailwind v4 + Appica 的编译产物，**禁止手改**。手写源码只有 `src/web-ui/css/appica.css` 与 `react/**`。

Tailwind 不扫描 `node_modules`，`appica.css` 里的 `@source "../../../node_modules/@appica/ui-react/dist"` 是必需的；删掉它所有 Appica 组件的类名都不会被生成，界面会整体失去样式。

## 层叠契约（改 token 前必读）

### 1. 无层规则永远赢过 Tailwind

Tailwind 的输出全在 `@layer theme/base/utilities` 里，而 `content/styles.css` 与 React 各 style 模块（`react/styles/*.ts` 运行时注入 `<style>`）都是**无层**的。所以：

- 手写 CSS 稳压所有 Utilities 一层，这是有意为之，不是巧合。
- 因此 `styles.css` 的 `*` 重置只保留 `box-sizing`，把 `margin/padding` 让给 Tailwind preflight。无层的 `* { margin: 0 }` 会击穿所有 spacing 工具类。

### 2. `styles.css` 必须排在 `tailwind.css` 之后

Appica 在自己的无层 `:root` 里声明了一批**与 Wand 同名**的 token：

```text
--border  --border-strong  --font-sans  --font-mono
--info  --info-muted  --success  --success-muted  --warning  --warning-muted
--radius-xs  --radius-sm  --radius-md  --radius-lg
--shadow-xs  --shadow-sm  --shadow-md  --shadow-lg  --shadow-xl
```

无层对无层只能靠先后裁决。顺序反了，Appica 的中性灰会静默覆盖整套暖色调，而且**没有任何报错**——只会看到圆角、边框、字号、状态色整体漂移。

这个顺序写在**两个地方**，改一处必须改另一处：

| 位置 | 作用 |
| --- | --- |
| `src/web-ui/styles.ts` 的 `CSS_FILES` | 运行时从 `dist` 读盘拼接 |
| `scripts/generate-web-assets.js` | 编译期内嵌兜底（`embedded-assets.ts`） |

排查「改完 CSS 没生效」时先看这里：读盘失败会静默退回内嵌 CSS，表现为「新代码明明编译过但页面是旧的」。

### 3. 不要重新声明 `styles.css` 已经拥有的名字

CSS 无法读取一个被遮蔽的同名变量，所以

```css
--success: var(--success);      /* 自引用 */
```

**不是**「恢复原值」，而是自引用：该变量会解析成 guaranteed-invalid，`var()` 回退到 unset。表现是这套颜色对应的所有元素背景变透明、文字变黑，且**同时打坏仍在用这套 token 的全部 legacy 界面**。

`appica.css` 里的 token 桥接因此只写 `styles.css` 没有的名字（`--foreground*`、`--background*`、`--primary*`、`--secondary*`、`--error*`、`--ring*` 等）。新增映射前先确认名字没被 Wand 占用。

### 4. Appica 的 `*-foreground` 是「实心色上的文字色」

Appica 的浅色主题里角色色是**浅色**（`oklch(0.7~0.8)`），`*-foreground` 是深色文字；Wand 的角色色是**中深色**（`#4f7a58` / `#b24f45`），`*-foreground` 映射成白色（`--text-inverse`），实心按钮才读得出来。

代价：Appica 把 `*-muted`（淡色底）也配 `*-foreground`，于是淡色底 + 白字不可读。所以

- `ui/badge.tsx` 一律用 Appica 的 `soft` 变体，**颜色**由 `react/styles/base.ts` 里 `.wand-ui-badge-<tone>` 接管（`::before` 画底色，根元素写文字色）。
- 以后接 Alert / Toast 等「淡色底 + 状态色文字」的组件时，同样要单独处理，不能指望角色变体直接可用。

### 5. `wand-bridge` 层：抵消库给的尺寸/状态类

Appica 在组件根节点上挂工具类表达自己的设计意图，这些意图有时和目标界面冲突（靠 `inset` 撑满屏幕的弹层被 `w-150` 压窄、二层弹层打开时父弹层淡出）。放在**最后一层**的 `@layer wand-bridge`（`appica.css`）专门抵消这类工具类：层序上它稳压 `@layer utilities`，又输给所有无层规则，所以「抹掉库给的样式」和「Wand 自己的 width/inset 继续生效」可以同时成立。

当前三条：

```css
[data-slot="dialog-popup"] { width: auto; max-width: none; }
[data-slot="dialog-popup"][data-nested-dialog-open] { opacity: 1; scale: none; pointer-events: auto; }
/* Appica 的 trigger 自带 `w-full` + 固定高度；Wand 的下拉宽度由业务布局决定
   （composer chip、任务板 pill），所以把宽高交还给样式表。 */
[data-slot="select-trigger"], [data-slot="combobox-trigger"] { width: auto; height: auto; }
```

### 6. 只翻 `visibility` 的 `.hidden` 仍然占盒模型

Wand 有一批浮层为了做「进出场渐变的重定向」故意**不**用 `display: none` 藏起来：

```css
.composer-plus-popover.hidden {
  display: flex !important;   /* 故意保持渲染 */
  visibility: hidden;         /* 只翻这一个 */
}
```

`visibility: hidden` 只挡绘制和命中测试，元素**仍在盒模型里**。所以只要它的 `position: absolute`
被删掉，它就会退回普通流（normal flow），把宿主容器撑高一大截。典型案例：

| 症状 | 实测 |
| --- | --- |
| composer 输入框浮到屏幕中间 | `.input-panel` 从 60px 涨到 287px，输入行 top 从 748 弹到 521（800px 视口里居中） |

`position: absolute` 和它一起被删的还有 `display: flex` / `flex-direction: column` / `z-index`——
迁移时这些「布局属性」比视觉属性更隐蔽，因为单个浮层看不出来，只有容器高度变了才暴露。

**规则：凡是 `.hidden` 只翻 `visibility` 的浮层，它的 `position: absolute` 必须留在生效的规则里。**
改浮层 CSS 后，除了看浮层本身，还要量它的宿主容器高度有没有变。

同类坑还有一个（第 3 条 dialog-viewport）：`position: fixed` 即使 `z-index: auto` 也会新建
stacking context。两处都说明——**迁移时最容易丢的不是颜色和圆角，而是那些「不写就退回默认布局」的属性**。

新增抵消规则时不要写 `!important`，也不要把规则挪回无层——无层里它会连业务 dialog 自己的 `width` 一起盖掉。

## 已迁移

`react/ui/**` 是唯一允许出现第三方组件 API 的目录；业务模块只认 `Wand*` 接口，所以实现可以随时换。

| 组件 | Appica 源 | 保留的业务钩子 |
| --- | --- | --- |
| `WandButton` | `@appica/ui-react/button` | `wand-ui-button`、`wand-ui-button-<kind>` |
| `WandBadge` | `@appica/ui-react/badge` | `wand-ui-badge`、`wand-ui-badge-<tone>` |
| `WandSkeleton` | `@appica/ui-react/skeleton` | `wand-ui-skeleton` |
| `WandSwitch` | `@appica/ui-react/switch` | `wand-ui-switch-row`、`wand-ui-switch` |
| `WandTabs` | `@appica/ui-react/tabs` | `wand-ui-tabs-list/-trigger/-content` |
| `WandDialogSurface` / `WandDialog` | `@appica/ui-react/dialog` | `wand-ui-dialog-*`、`wand-file-preview-dialog`、`wand-settings-dialog` 等 16 处业务类名 |
| `WandSelect` | `@appica/ui-react/select` + `@appica/ui-react/combobox` | `wand-ui-select-trigger/-content/-item/-empty`、`wand-ui-select-search*` |
| `showWandToast` / `WandToastRegion` | `@appica/ui-react/toast` | `wand-ui-toast`、`wand-ui-toast-<tone>`、`wand-ui-toast-viewport` |
| `WandPopover` | `@appica/ui-react/popover` | `wand-ui-popover-content`、`wand-ui-popover-arrow` |
| `ComposerRail` | `@appica/ui-react/button`（经 `WandButton`） | `wand-composer-rail-submit` |

`ui/**` 里现在 **零 Radix 依赖**，`package.json` 里的 6 个 `@radix-ui/react-*` 已删除。

`ui/menu.tsx` 是纯 `<button>` + token，本来就没引 Radix，不需要迁；但它是**全站唯一的菜单行实现**，
业务模块要出菜单行就复用它（`WandMenuItem` / `WandMenuSeparator` / `WandMenuLabel`），不要再写自己的
`.xxx-menu-item`。任务板右键菜单（`issues/task-board-views.tsx`）已按这条收敛。

### 首屏仍然由 legacy 层持有的两个高频表面

React 层没有接管终端本身：xterm、底部 composer、文件浏览器、权限按钮仍在
`src/web-ui/browser/**`。所以「改用组件库」不能只看 `react/**` 的文件数，下面两处是特例，
是按上面的层叠契约反向处理 legacy 的：

1. `html { font-size }` 必须是 16px。Appica / Tailwind 全部按 rem 计量，而 legacy 的
   `styles.css` 是 px 写死的；把根字号调小会整体压缩 Appica 组件的尺寸而不是 legacy 的。
2. PTY 直通模式（`state.terminalInteractive`）下的 composer 是**真实可用的输入面**，
   详见下一节。

### PTY 直通 composer（`is-terminal-interactive`）

PTY 会话处于 `terminal` 视图且进程在跑时，composer 进入直通模式。契约：

| 项 | 网页端 | 原生嵌入壳（`html.is-wand-embed-terminal`） |
| --- | --- | --- |
| `.composer-input-wrap` / `#input-box` | **保留**（单行 40px，`.is-terminal-passthrough`） | `display: none`，底栏由原生渲染 |
| `.composer-actions-left`（附件 / 模式 / 权限 chip） | `display: none`（附件走终端粘贴协议） | 同左 |
| 打字 | `input` 事件里逐字 `queueDirectInput` 到 PTY | 原生输入栏 |
| Enter | `sendInputFromBox` → 先文本（若有）后单独 `"\r"` | 原生输入栏 |
| Backspace | `\x7f` 送给 PTY（textarea 永远是空的，本地删除无意义） | 原生输入栏 |
| `#input-box` 的 keydown | **不**被 `shouldCaptureTerminalEvent` 捕获 | — |

### 直通 composer 的尾部操作区（Appica）

legacy 的发送 / 语音 / 优化按钮在直通下全部收起，右侧栏本来会留下一条空白。现在由
`react/composer-rail/**` 往 `.composer-actions-right` 里的
`<span data-composer-rail-host="pty">` portal 一个 Appica `WandButton`（「发送」，等于 Enter）：

```text
browser/render.ts            写宿主 span（composer 标记里，随会话切换保留）
browser/input.ts             updateInteractiveControls() -> syncBrowserComposerRail()
browser/composer-rail-adapter.ts   扫 [data-composer-rail-host] -> controller.sync()
react/composer-rail/host.tsx       createPortal(<WandButton/>)
```

- `active()` 必须是 `state.terminalInteractive && !is-wand-embed-terminal`：原生嵌入壳的底栏由原生
  渲染，结构化会话保留 legacy 发送按钮。清空时宿主变 `:empty`，被 CSS 收起、不占位。
- 点击走的是同一条提交路径（`sendInputFromBox()`），因此与 Enter 完全等价，不新增协议；
  点完把焦点还给 `#input-box`，可以接着逐字透传。
- 宿主 span 落在 `.composer-actions-right` 里，该组在直通下只有这一个子节点，
  `grid-column: 2` 由 `.composer-main-row` 的 `minmax(0, 1fr) auto` 分配宽度。

两条容易写错的边界：

- 网页端 composer 保留之后，`shouldCaptureTerminalEvent` 必须对 `#input-box` 直接返回 `false`。
  否则同一个字符会走两次：keydown 走 `captureTerminalInput`，input 事件走
  `handleInteractiveTextInput`，终端里每个字符都变成两个。
- 反向的坑是「把 drafting row 藏起来但不收高度」：`.composer-main-row` 被压成 1 行、
  子元素全 `display: none` 之后，`.input-panel` 仍会留一条 60px 的空白带。
  嵌入壳用 `grid-template-rows: 48px` 显式占位来避免它；网页端不再走这条路径。

### dialog 的迁移要点

- Radix 的 `onOpenChange(open)` 只有布尔；Base UI 给 `(open, eventDetails)`，`eventDetails.reason` 是 `'escape-key'` / `'outside-press'`。`dismissable === false` 时要在回调里 `eventDetails.cancel()`，否则遮罩点击仍会关闭（原来的 `onInteractOutside` 拦不住）。
- Base UI 用 `data-open` / `data-closed` / `data-starting-style` / `data-ending-style`。`content/styles.css` 与 `react/styles/{base,features}.ts` 里的 `[data-state="open|closed"]` 全部要改，漏一处就是弹层不再有进出场动画。
- Appica 的 `DialogContent` 会再包一层 `div[data-slot="dialog-content"]`（自带 `pb-6`）和一层 `div[data-slot="dialog-viewport"]`。viewport 是 `position: fixed` 的整屏容器，**必须**在业务 CSS 里退回 `position: static`：`position: fixed` 即使 `z-index: auto` 也会新建 stacking context，业务弹层的 z-index 阶梯（设置 30/31、任务板 34/35、文件预览 54/55、通用 0/1）会退化成层内比较，弹层被自己的遮罩罩住。
- 真正做居中的是业务自己的规则（`.wand-settings-dialog`、`.wand-file-preview-dialog` … 都写了 `position: fixed` + `width/height`，`.wand-missions-dialog` 靠 `inset: 24px`）。视口只是空容器，退回 static 不影响任何一个。
- 文件预览的 z-index 阶梯原来是「兄弟节点 + 相邻选择器」，弹层各自进了独立 Portal 后不再互为兄弟，改成 `.wand-ui-portals:has(.wand-file-preview-dialog) …`。
- `role="dialog"` 与 `aria-labelledby/describedby` 保留（legacy 输入层靠 `[role="dialog"]` 判断是否让出按键）。

### select 的迁移要点

`ui/select.tsx` 有两条实现，各自对应一个 Base UI 原语，但对外只暴露 `WandSelectProps`：

| 分支 | Appica 源 | 关键设置 |
| --- | --- | --- |
| 普通下拉 | `Select`（subpath `@appica/ui-react/select`） | `modal={false}`、`alignItemWithTrigger={false}` |
| `searchable` | `Combobox`（subpath `@appica/ui-react/combobox`），"input inside popup" 模式 | `defaultInputValue=""`、`icon={false}` |

- **`icon={false}` 必须给在 `Combobox` 根上，不是 `ComboboxInput` 上。** Appica 的
  `ComboboxInput` 默认会再渲染一个 `Combobox.Trigger`（右端的小箭头），而这个按钮在
  **弹层内部**。Base UI 只保留最后注册的 trigger 作为定位锚点，于是弹层开始追自己内部的
  元素：每帧布局重新定位一次、位置逐帧漂移，最后停在屏幕左下角而不是 composer 上。
  根上的 `icon={false}` 让 `ComboboxInput` 不再渲染这个 trigger，锚点回到外层 trigger。
  排查这类「弹层位置乱飘」时，先看 positioner 上的 `--anchor-width`：它应该等于 trigger 宽度。
- `defaultInputValue=""`：弹层里的搜索框必须从空开始。Base UI 默认会把当前选中项的
  label 填进输入框，第一次键入就变成「默认gpt」而不是替换查询。
- `ComboboxValue` 不接受 `className`，所以业务类 `wand-ui-select-value` 挂在包它的
  `<span>` 上；同理搜索图标走 `ComboboxInput` 的 `startSlot`（内联前置插槽），
  不再是绝对定位的 `.wand-ui-select-search-icon`。
- trigger 的 DOM 变成 `<button><span class="flex … truncate"><span class="wand-ui-select-value">…</span></span><svg data-slot="select-icon"></svg></button>`。
  `features.ts` 里那两条 `> span:first-child` / `> [aria-hidden="true"]` 复合选择器仍然命中
  （Appica 的箭头是直接子节点且带 `aria-hidden`），换库时不要顺手删掉。
- 经典分支的 popup 会用 `--anchor-width` / `--available-height` / `--transform-origin`
  这组 Base UI 变量；`--radix-*` 名字全部作废。

### toast 的迁移要点

Appica 没有「单组件、逐条 tone」的 API，`Toaster` 是一个管理器式组件，所以 `ui/toast.tsx` 自己组：

```text
ToastProvider -> ToastPortal(container) -> ToastViewport(position="top-right")
  -> 每个条目一个 <Toast position="top-right" className="wand-ui-toast wand-ui-toast-<tone>">
       ToastTitle / ToastDescription / ToastClose
```

- 公开 API 未变：`showWandToast()` 之外只有 `WandToastRegion`（无 props）。
  `WandToastHandle` 现在是 `{ id: string; dismiss() }`——id 是 Appica 管理器给的
  `string`，不再是自增 number。
- `react/overlay-controller.tsx` 里的 `toasts` 数组 / `ToastEntry` / `dismissToast` 已删除，
  `OverlaySnapshot` 只剩 `{ activeDialog }`；`showWandToast()` 直接调管理器并立即返回句柄，
  **不经过 `publish()`**，否则 `useSyncExternalStore` 会跟着每次 toast 抖动。
- `.wand-ui-toast` 不再自己画 grid：Appica 的 `grid-template-areas` 已经在管
  title/description/close 的排布，Wand 只保留色调类。
- viewport 保留业务规则（`position: fixed`、`z-index: 20`、`top/right`、宽度），
  Appica 那个 `z-50` 工具类会被无层规则压掉——这是有意的，弹层 z 阶梯仍在业务侧。

### 迁一个组件的步骤

1. 在 `ui/<name>.tsx` 内换成 Appica 组件，保持导出的 `Wand*` 名称与 props 不变。
2. 把原有的 `wand-ui-*` 类名继续挂在最外层，业务 CSS 靠它定位。
3. 删掉 `react/styles/base.ts` 里被取代的视觉规则（只留布局类，如 `.wand-ui-switch-row`）。
4. 数据属性要对齐：Radix 用 `[data-state="checked"|"active"|"open"]`，Base UI 用 `[data-checked]` / `[data-active]` / `[data-open]`。业务 CSS 里搜 `data-state` 全部核对一遍（当前只剩 `.wand-settings-tabs` 一处，已改成 `[data-active]`）。
5. 用 `output/` 下的截图比对，重点看 `features.ts` 里带 `> .wand-ui-*` 的复合选择器是否还命中。

第 1 步有个编译期坑：`tsconfig.react.json` 不含 `jsx: react-jsx` 之外的 React 运行时假设，
若文件里只剩类型引用（迁移后很常见），`tsc` 会报 `React` 未使用或找不到 —— 保留一行
`import * as React from "react";` + `void React;` 即可，别为了消警告删掉整个 import。

`WandTabs` 是个提醒：Appica 的 trigger 会在内容外包一层 `[data-slot="tabs-trigger-inner"]` 并自带 padding/居中，`TabsList` 还会插一个滑动 indicator。当业务 CSS 已经自己画了选中态时，必须把这两层显式关掉（见 `features.ts` 的 `.wand-settings-tabs` 规则），否则会叠出双份 padding 和双份高亮。

## 验证

```bash
npm run check                      # 三个 tsconfig + 重新生成 web 产物
npm test                           # 667 个用例
npm run build && node dist/cli.js web -c /tmp/wand-ui-qa/config.json
```

改 token / 层叠后至少要肉眼过一遍：登录页、主界面、设置对话框（连接器 / AI 与模型）、PTY 终端、任务板。任何「颜色/圆角/字号整体变了」的现象，先按上面第 2、3 条查。

改 select / toast / popover 后额外过一遍：

- composer 的模型下拉是 searchable 分支：弹层要贴住 trigger（读 positioner 的 `--anchor-width`，
  应等于 trigger 宽度），搜索框重新打开时是空的，键入 "haiku" 只筛不追加。
- composer 的模式 / 思考下拉走经典分支，选中项有对勾、弹层不越界。
- PTY 直通 composer：输入框贴屏幕底部（面板 68px、行 48px、输入框 40px），发按钮来自 Appica（`data-slot="button"`），点它等于回车，结构化会话里该按钮消失。
- 触发一次 toast（例如设置里「保存 AI 与模型配置」），确认它出现在右上角 viewport 里
  且 tone 类名（`wand-ui-toast-success`）生效。

改 dialog 后要跑的回归（`/tmp/wand-uicheck/probe*.mjs`）：设置弹层不被自己的遮罩罩住、嵌套弹层（设置 → 环境变量预览）父层不淡出、在文件预览上叠一个确认框（z-index 阶梯 :has 规则）、Escape 关闭后焦点回到 `#settings-button`。
