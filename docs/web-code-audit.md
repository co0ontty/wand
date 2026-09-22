# Web 层逐函数审计（browser + react）

审计对象：`src/web-ui/**`（browser 运行时 21097 行、react 层 35993 行、服务端 shell 与样式）。
本文件是**问题清单**，不是改造计划；每条都给了可复现的证据位置。

## 口径与覆盖度

- 全量函数登记：TypeScript AST 解析 `src/web-ui/**/*.ts(x)`，得到 **4399 个函数**（含嵌套 lambda），
  逐函数记录行数、分支数、定时器/监听器/DOM 查询/innerHTML/`any`/空 catch 等指标。
  完整表见文末《附录 A》。
- 模式扫描：28 类模式（innerHTML、监听器配对、`any`、非空断言、空 catch、`console.*`、
  localStorage、JSON.parse、动态 querySelector、setInterval 等）全目录跑过。
- 逐行精读：**高风险函数约 120 个**（下表 P0–P3 涉及的全部函数，以及各模块入口与
  状态/合并/输入/持久化链路）。其余函数的结论来自指标 + 模式扫描，未逐行读。
- 静态结论逐条人工复核过：`fetch 未检 status` 一类在 react 层多为假阳性
  （统一走 `react/http-adapter.ts::parseJsonResponse`），已剔除，不写进本文。
- 基线：`tsc -p tsconfig.browser.json` / `tsconfig.react.json` 均 0 error；
  `npm test` 1014 pass / 0 fail；`npm run audit:remnants` 34 个候选。
- 复核后状态：**P0 四项 + P1-1…P1-8（含 P1-7 部分）+ P2 清单** 已处理，`npm run check` 0 error，
  `npm test` **1063 pass / 1 fail**（唯一失败项属另一个任务，见下方归属说明），
  `npm run build` 通过（js gzip 501.8/502.0 KiB）；本审计自己的
  12 个测试文件单独跑：**69 pass / 0 fail**。
  **未完成项汇总见《已知未完成清单（Backlog）》**（在附录 A 之前）。
  第二轮由 6 条 lane（实现 + 独立复核）并行完成，汇总与遗留项见《P1-4…P1-8 + P2 批量处理结果》。
  修复过程中的两次自查找回归已修并固化成用例，见文末《复核记录》。
- 归属说明：本仓库工作区在同一时间里还有**另一个任务**的在途改动（`src/ws-broadcast.ts`、
  `src/process-manager.ts`、`src/server.ts`、`src/terminal-host.ts`、`src/pty-terminal-state.ts`）。
  当前 `npm test` 的唯一失败项 `tests/ws-broadcast.test.ts`（raw PTY output scoped/pause）属于那个任务
  （它只 import `src/ws-broadcast.js`，与本次所有改动无关；本次改动全在 `src/web-ui/**`）。
  本次交付的范围以 `src/web-ui/**` + `tests/web-ui-*` 为准。

## 总体结论

| 层 | 规模 | 判断 |
| --- | --- | --- |
| `react/**` | 35993 行 / 201 文件 | 结构健康。controller↔store↔repository 分层清楚，AbortController、revision 世代号、取消、清理普遍到位；`useEffect` 定时器基本都有 cleanup。问题集中在**少数超大组件**与**fire-and-forget 轮询**。 |
| `browser/**` | 21097 行 / 62 文件 | 主要技术债区。`var` 风格、模块加载期副作用、全局 DOM 耦合（`document.getElementById` 127 处 / `addEventListener` 152 处）、`any` 243 处、非空断言 55 处集中在这里。头部文件已到「再改必错」的复杂度。 |
| 服务端 shell / 样式 | `web-ui/*.ts`、`content/styles.css` | 基本干净；发布预算已逼近上限（见 P0-1），且存在无人消费的深色模式分支（P1-4）。 |

---

## P0 — 会直接影响发布或用户数据

### P0-1 内联 web 资产 gzip 预算逼近上限（已处理）

```
scripts.js     raw 1724.1 KiB  gzip  501.7 KiB     ← 上限 502.0 KiB
styles.css     raw  376.1 KiB  gzip   60.3 KiB
tailwind.css   raw  241.0 KiB  gzip   30.0 KiB
```

当前构建结果为 gzip **501.8 KiB / 502.0 KiB**（审计初始值 501.7）。

这轮包含 6 条 lane 的正确性修复（新增模块与错误处理，属于净增）+ 删除重复实现/死代码。
没有上调 BUDGET：余量只剩约 0.2 KiB，下一批前端改动很可能需要先做一批已验证删除或按脚本要求在
同一提交里上调 BUDGET 并说明原因。

### P0-2 登出静默失败（已处理）

`session-engine.ts` 现在先等 `/api/logout` 返回 2xx，再清理本地 session、终端和 UI。
判据只看状态码：路由在写响应体之前就已经 `revokeSession` + `clearCookie`，所以不能因为
「响应体不是 JSON」就判失败、把用户留在已登录态（第一版用 `parseJsonResponse` 有这个
假阴性，已改）。网络失败或非 2xx 时保留当前登录态并提示可重试；服务端已经返回 401 时
走被动本地收尾，不弹注销失败提示。回归用例覆盖：成功、500、网络异常、非 JSON 2xx、401。

### P0-3 批量删除把 HTTP 错误当成功（已处理）

`sidebar.ts::batchDeleteSelected` 现在通过 `parseJsonResponse` 检查 HTTP 状态。全部失败时不清选择、不 refresh；部分成功时只保留失败项，当前会话只有在确实删除成功时才取消选择。新增的 403 和部分成功回归测试已通过（`tests/web-ui-session-batch-delete.test.ts`）。

### P0-4 会话合并规则互相冲突（已处理）

`mergeServerSession` 现在采用：服务端完整快照优先（输出占位除外，见下）；
`sessionReads.record/merge` 保护请求等待期间已被实时推送或用户操作更新过的字段；只有相同
`structuredState.activeRequestId` 的本地 `__processing` assistant block 才保留；服务端
明确的权限字段会清除本地旧值。

被删掉的东西里，只有一项是无副作用的：最后一条 `JSON.stringify` 长度比较在唯一调用点
（`GET /api/sessions`）永远不可达 —— 列表 DTO 不带 `messages`，两侧消息数组不可能都非空。
而 `keepLocalOutput = 本地更长者胜` **不是**多余启发式，它是列表契约的配套保护：
`toSessionListItemDTO` 固定发 `output: ""`（`session-transport.ts` 注释写明是给客户端
初始化终端状态用的兼容占位），列表刷新必须保留本地缓冲。现在改成显式规则：

```ts
var serverHasAuthoritativeOutput = typeof serverSession.output === "string"
  && serverSession.output.length > 0;
if (!serverHasAuthoritativeOutput && typeof localSession.output === "string") {
  merged.output = localSession.output;
}
```

回归用例：`tests/web-ui-session-reads.test.ts` 共 21 项，含「列表占位输出不得清空本地缓冲」
「省略权限字段时保留本地待处理态」「旧本地输出更长时服务端完整快照仍然胜出」
「同 request 保留乐观块 / 新 request 清除」「服务端明确权限字段清除本地旧值」。

---

## P1 — 明确的缺陷或高维护风险

### P1-1 `scheduleChatRender` 重复实现（已处理）

`websocket.ts` 已删除重复实现，统一 import 并调用 `chat-render.ts::scheduleChatRender`；单一防抖状态和延迟规则保留一份。

### P1-2 PTY provider 噪声过滤散在四处（已处理）

原文写的是“三套”，实际是**四处**（复核时又找到一处）：

| 位置 | 用途 |
| --- | --- |
| `isNoiseLine` | 聊天流渲染丢弃的噪声行（最全） |
| `extractPtySystemInfo` 内联过滤 | PTY 首屏 system-info 卡片 |
| `parseMessages` 里 `// Filter noise` 块（~45 行） | PTY 转写抓取（含 npm 日志、TUI 碎片） |
| `shouldIgnoreCodexLine` + 两个 Codex 正则 | Codex 解析 |

现在全部集中在 `src/web-ui/browser/pty-noise.ts`（不碰 DOM，可直接单测）：
`isPtyNoiseLine` / `isPtySystemInfoNoiseLine` / `isPtyTranscriptNoiseLine` / `isPtyCodexNoiseLine`
+ `codexFooterRe` / `codexActivityRe`。chat-render.ts 因此少了 147 行（+2 行调用）。

**四套的判定范围刻意不合并**（合并会改变渲染结果，而 P0-4 那次的教训就是不能顺手扩大
改动面），差异在模块内逐条注明并由测试锁定：

- system-info 卡片保留 banner 框线与 `OpenAI Codex` / `model:` 行；
- 转写抓取额外挡 npm 安装日志与 TUI 动画碎片；
- Codex 判定 = 聊天流噪声 + Codex 专属模式。

顺手删掉的**有证据**的死条件：`extractPtySystemInfo` 里第二个 `{3,}` spinner 分支恒被前一个
前缀分支覆盖。同时发现两个**既有**行为需要记录（本轮不动）：

- 聊天流的框线规则字符集里没有 `╮`/`╰`，所以 `╭────╮` 这类 banner 行一直保留（`├────┤` 会命中）；
- `codexFooterRe` 要求模型名与 `·` 之间有空白，真实 Codex 若输出 `gpt-5.1-codex · 42% left · /path`
  （连字符 slug）则抓不到；缺少真机转写证据，按“不改行为”处理，已写进用例注释待验证。

测试：`tests/web-ui-pty-noise.test.ts`（5 项，含 “chat-render 不再自带过滤列表” 的架构断言）。

### P1-3 模块级定时器永不停：登出后仍在跑（已处理）

| 位置 | 周期 | 行为 |
| --- | --- | --- |
| `websocket.ts:56-61` | 30s | 扫 `.session-time`，有则 `scheduleSessionListUpdate()` |
| `input.ts:599-611` | 5s | 刷新跨会话队列 age，并 **`flushCrossSessionQueue()`** |

两者都是模块加载期 `setInterval`，没有任何 `clearInterval` 路径，
`stopPolling()`（`websocket.ts:856`）也不管它们。登出（P0-2）之后它们继续执行：
顶栏刷新拿不到东西是空转，但队列那条会继续尝试 flush 排队消息——登出状态下把
用户消息重新发出去，是真实风险。另外 `createGitStatusRefresh`
（`git-status-refresh.ts:32-35`）返回的控制器只有 `schedule/startPolling`，
**没有 stop**，`pollTimer` 永不清理。

**（已处理）** 三处定时器现在都有明确归属和停止路径：

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 侧边栏相对时间（30s） | 模块级 `setInterval`，导入即启动 | `startPolling()` 装 / `stopPolling()` 卸（幂等） |
| 跨会话排队条（5s） | 模块级 `setInterval`，登出后仍每 5s 尝试 flush | `renderCrossSessionQueue()` 按队列是否为空装/卸；登出显式 `stopCrossSessionQueueTicker()` |
| git 徽章兜底轮询 | 控制器只有 `schedule/startPolling` | 新增 `stop()`，接入 `stopPolling()` |

额外修掉一个连带风险：`flushCrossSessionQueue()` 现在在 `state.config` 为空时直接返回 —— 队列会从
localStorage 恢复，之前它会在登录页（或登出后）拿着 401 去 `POST /api/commands`。

测试：`tests/web-ui-websocket-ownership.test.ts`（+2）、`tests/web-ui-git-status-refresh.test.ts`（+1）、
`tests/web-ui-cross-session-queue-ticker.test.ts`（+3）。

### P1-4 `[data-theme="dark"]` 全仓无人设置，深色分支是死的（已处理：保守清理，方向待定见 Backlog A1）

全仓（src/scripts/tests/文档/android/ios/macos/browser-extension）grep `data-theme`，
消费者只有一处：

- `src/web-ui/content/styles.css:6763` `[data-theme="dark"] .queue-bar { --qb-bg: … }`

生产者：0（没有 `dataset.theme =`、没有 `setAttribute("data-theme"`）。
而 `src/web-ui/css/appica.css:65-66` 写着「Wand renders dark mode through
`[data-theme="dark"]`」并据此定义 `@custom-variant dark` —— 这条契约目前是假的。
注意：`content/styles.css:8785` 的 `@media (prefers-color-scheme: dark)`
（modal backdrop）**不算死代码**，它由 UA 触发，按仓库规则保留。

### P1-5 自动标题轮询不取消，最长追 19 秒（已处理）

`src/web-ui/react/issues/task-board-host.tsx:105-115, 345`

```ts
const AUTO_TITLE_POLL_DELAYS_MS = [1_200, 2_000, 3_000, 5_000, 8_000];
async function refreshGeneratedTitle(taskId, placeholder, reload) { for (const d of …) { await sleep(d); await reload(); … } }
// 345: void refreshGeneratedTitle(created.id, created.title, reload);
```

`void` 丢弃、无 AbortSignal、无卸载标记。用户在 19 秒内关掉看板/切走，循环仍在跑：
每轮 `reload()` 会全量重取任务列表 + 工作区列表，并 `setState`。

### P1-6 移动端视口 settle 定时器成批发射且不跟踪（已处理，剩余见 Backlog B3）

`src/web-ui/browser/viewport.ts:172-190`

```ts
function scheduleViewportSettle() { viewportSettleTimers.forEach(clearTimeout); viewportSettleTimers = [60,180,360,620,900].map(…) }  // 会清上一批：好
function scheduleFocusedInputSettle() { [0,50,120,220,360,560].forEach(d => setTimeout(…)) }                                  // 从不清：坏
```

`scheduleFocusedInputSettle` 每次焦点事件都新开 6 个 `setTimeout`，每个回调里
`updateViewport()` + `getElementById('input-box')`。快速 focus/blur（移动端点输入框
再点别处）会叠加 12、18 个待执行回调，全部按帧改 CSS 变量。这是「移动端键盘收起后
布局抖动」类问题的放大器。

### P1-7 模块加载期副作用挂在 document 上，永不解绑（部分处理，剩余见 Backlog B1）

`src/web-ui/browser/chat-render.ts:1027-1074` —— `(function initMobileCopyLongPress(){…})()`
在每个 `touchstart/touchmove/touchend/click` 上：

- 4 个 `document` 级监听，无 `removeEventListener`、无 `once`；
- `click` 处理器每次都 `document.querySelectorAll(".msg-copy-btn.visible")` 全量扫描；
- 模块加载即注册（`main.ts:23` 注释也承认这是自执行副作用）。

`state.ts:343-349`（pagehide/beforeunload/pageshow）、`render.ts:174+`（online/offline/
visibilitychange/focus 共 7 个）同类。单页应用里不算泄漏，但它们让「谁在监听什么」
无法静态追踪，也让一次性扫码/最小化场景无法拆掉。

### P1-8 三条 `res.json()` 后不看 status 的旧调用链（除 P0-3 外）（部分处理，剩余见 Backlog B2）

- `events.ts:16-33` `__fetchToolContent`：只看 `data.error`，HTTP 错误页 → `res.json()` 抛错 → 统一显示「加载失败」。
- `input.ts:659-679` `sendOrStart` 的新建会话：同上（`.catch` 兜成通用文案）。
- `terminal.ts:25-33` `addRecentPath`：完全 fire-and-forget。

对比新代码（`input.ts:1377` / `1407`、`websocket.ts:804`）都显式 `res.ok` + 结构化错误。
这些是同一 bug 家族里还没统一的历史调用点。

---

## P1-4…P1-8 + P2 批量处理结果（6 lane × 实现 + 独立复核）

下面每项都是「实现者改完 → 另一名 fresh-context 只读复核者独立验证」，复核结论已汇总。

| 项 | 结果 | 关键改动 | 验收 | 复核 |
| --- | --- | --- | --- | --- |
| P1-4 | 已处理（保守） | 删掉不可达的 `[data-theme="dark"] .queue-bar`；订正 `appica.css` 两处错误契约注释；保留 `@custom-variant dark` | 新增 `web-ui-dark-mode-rules.test.ts`（3 项 + 负向对照） | accepted（无 P0/P1） |
| P1-5 | 已处理 | 新增 `issues/generated-title-poll.ts`（`start/cancel` + 三处世代守卫）；host 用 ref 接线，关板/卸载都 cancel | 新增 `web-ui-generated-title-poll.test.ts`（8 项，含默认延迟序列用例） | accepted（2 个 P2 已在本轮修掉） |
| P1-6 | 已处理 | `scheduleFocusedInputSettle` 批次收进模块级数组并重排前清旧批；`teardownTerminal()` 清空两批 | 新增 `web-ui-viewport-settle.test.ts`（4 项 + 变异验证） | accepted（3 个报告项，无阻塞） |
| P1-7 | 部分处理 | `visibleCopyButton` 改为引用管理（新按钮按引用隐藏旧的、空点廉价 return、复制成功也清引用） | 新增 `web-ui-copy-dismiss.test.ts`（3 项） | accepted（报告项：四个 document 监听仍不解绑，保留） |
| P1-8 | 已处理（4 个具名点） | `__fetchToolContent` / `sendOrStart` / `addRecentPath` / 更新·重启卡片全部改走 `parseJsonResponse`；失败不再写缓存、不再静默、统一复位 UI | 新增 `web-ui-legacy-fetch-errors.test.ts`（6 项；HEAD 反向对照 1 pass/5 fail） | accepted（5 个报告项，含同家族剩余调用点清单） |
| P2 冗余导出 | 已处理 | 11 个只在本文件使用的符号去 `export`（每个都过了全仓 grep） | tsc 两套干净 + 关联套件 34/34 | accepted（并订正“净减字节”预期：bundle 里是 0 字节） |
| P2 无界 Map | 已处理（前两轮） | `sessionScales` 在 `disposePooledTerminal` 里清理 | 新增 `web-ui-terminal-pool.test.ts`（3 项） | accepted（复核发现 delete 在早退之后 → 本轮移到早退之前并补反例用例） |

### 父级综合时顺手修掉的复核 P2（都有测试或证据）

1. `sessionScales.delete()` 被 `if (!handle) return` 挡住（面板已渲染但 `XTermLib` 未就绪时就漏清）→ 移到早退之前，并补反例用例。
2. l2：所有行为用例都注入 `delays`，生产默认延迟序列从未被行为覆盖（改成 `?? []` 仍全绿）→ 新增“不注入 delays 时用生产默认序列”用例（并在旧实现下反例成立）。
3. l2 断言自相矛盾（注释说“只有一个等待”但断言 `pending===2`）→ 改成“不得多起一条轮询”的 `<=2` 并修正注释。
4. l4：复制成功 1.5s 后自动隐藏不清 `visibleCopyButton`（空点仍会走 `closest()`）→ 把引用 hoist 到模块作用域，在自动隐藏时带 `===` 守卫清掉。
5. l5：`performRestartCard(btn, …)` 的 `btn` 是死参 → 删除；`events.ts` 里恒不能命中的 `indexOf(statusNote) === -1` 死分支 → 简化（同时省 gzip 字节）。
6. l5 发现的同家族兄弟：`input.ts` 跨会话队列两条 `POST /api/commands` 仍只看 `data.error`（非 JSON 5xx 会把 `Unexpected token '<'` 透给用户）→ 改走 `parseJsonResponse`（失败仍回填队列，消息变可读）。

### 本轮明确不做/未做（已记录）

- **P1-4 没有接深色功能**：接上 `data-theme` 并补全各面板深色值属于产品决策 + 视觉重做，需你定方向；
  本轮只清死规则 + 修正契约注释，并保留 variant 方便后续一行接线。
- **l5 的一个行为变更需产品确认**：重启步骤被服务端拒绝（403/5xx）时不再进重启遮罩，而是停在更新卡片可重试。
  旧行为是「只要响应体能解析就进遮罩、然后永远等下去」，新行为更合理但是可见变化，已列入真机核对。
- **l6 的声明语义变宽**：同一窗格内切 tab（A→B→A）也会把该会话的缩放回落默认（与管理器释放路径同机制）。
  若期望「按会话记住缩放」，应改为只有真正关闭会话时才 `delete`；本轮按“缩放是窗格偏好”处理。
- **l2 的 `reload` 闭包**：`titlePollerRef.current ??=` 会永久捕获首次 `reload`；今天它依赖 `[]` 稳定，
  若将来给 `reload` 加依赖需加 `reloadRef`。
- 剩余不看 status 的调用点清单见 P1-8 节；`sessionScales` 以外的无界容器（如 `state.terminalStatesBySession` 有清理路径）未再扫。

---

## P2 — 可维护性 / 一致性

1. **`sendInputFromBox` 的返回值约定没有消费者。** 函数用 `Promise.resolve()`
   表示「未处理」（`input.ts:795-987`），但三个调用点全是丢弃：
   `input.ts:644`、`input.ts:2327`（`void`）、`session-engine.ts:2158`。
   直通模式分支里还带 `.catch(function(){})`（`input.ts:808-810`）——请求失败
   既没有 toast 也没有回填，只能靠服务端 `pty_error` 事件兜。约定与实现不一致，
   读代码的人会以为调用方能区分。
2. **`any` / 非空断言集中在 browser 层**：`as any | : any` 243 处
   （chat-scroll 38、notifications 38、events 27、websocket 25、terminal 15），
   非空断言 55 处（events.ts 25、settings/tabs.tsx 13）。`@ts-ignore` 0 处，
   说明不是被迫，而是历史风格。
3. **调试残留**：`input.ts:1024/1927/1946/2565/2597` 五处 `console.log("[wand] …")`
   （重复提交、队列丢弃），`viewport.ts:741` 一处 `console.debug`。
4. **12 个「只在本文件用却导出」的常量**（多余 export，扩大模块 API 面）：
   `THINKING_LEVELS`(session-engine.ts:677)、`_sessionListUpdateTimer`(:1290)、
   `ATTACH_MAX_SIZE`(:2290)、`SIDEBAR_PUSH_MIN_WIDTH`(sidebar-layout.ts:21)、
   `SIDEBAR_PUSH_MIN_HEIGHT`(:24)、`PIXEL_AVATAR`(chat-render.ts:1943)、
   `I18N_DEFAULT_LANG`(i18n.ts:14)、`ISSUE_BOARD_DISPLAY_KEY`(task-board-agent.ts:454)、
   `TASK_BOARD_VIEW_ALIASES`(task-board-controller.ts:13)、
   `ITERATION_CONTEXT_MODES`(iteration-panel.tsx:20)、
   `EMPTY_QUICK_COMMIT_CONTEXT`(memory-repository.ts:24)、
   `CHAT_WIDTH_OPTIONS`(chat-width-toggle.tsx:22)。
   （`_sessionListUpdateTimer` 是可变导出状态，尤其不适合 export。）
5. **`escapeHtml` 两份实现**：`scripts.ts:6`（服务端拼 configPath）与
   `text-escape.ts:6`（浏览器）。两者都要转义，目前内容相同，属于可接受的重复，
   但没有任何测试把两者锁在一起。
6. **硬编码颜色混进 token 体系**：`react/styles/features.ts` 里
   `background: #ffffff`（:777、:1726）、`#fff7ef`（:1808）、
   `rgba(255,255,255,0.92)`（:1721）；以及大量 `var(--text-muted, #7a6a58)` 式
   回退值。这是 P1-4 的连带后果：就算将来把 `data-theme` 接上，这些面板也不会跟着变。
   （diff/终端/代码高亮的语义色按仓库规则保留，不计入。）
7. **文件级监听器没有解绑**（`addEventListener` 有、全文件 `removeEventListener` 无）。
   其中多数是「元素随 DOM 一起回收」的合理情形（`terminal-pool.ts` 的 wheel、
   `file-explorer/controller.ts:183` 的 abort 桥、`task-board-controller.ts:97` 的
   popstate、`render.ts` 的 online/offline），列出来是为了让后续删改有据可查。
8. **`audit:remnants` 34 个候选未闭环。** 其中 `.tool-use-card` 已确认有生产者
   （`chat-render.ts:3375`/`3456` 字符串拼接，工具识别不到），说明其余候选不能直接删；
   `.voice-record-label`（`input.ts:74/91/123`）、`.input-hint`（`input.ts:1225/2288`）、
   `.wjp-key`（`viewport.ts:785`）等需要在真机/隐藏状态下再核一遍。

---

## P3 — 观察，不建议现在动

- `mergeServerSession` 在热路径上对整段历史做两次 `JSON.stringify` 比较
  （`session-engine.ts:1124-1127`）。消息量大时是 O(历史) 序列化，每次会话列表合并都跑。
- `terminal-pool.ts` 的 `sessionScales`（`Map<sessionId, number>`）在
  `disposePooledTerminal` 里不清理，会话关闭后比例记录常驻。量小，但属于同类
  无界 Map 的模板问题。
- `utils.ts:83` 状态栏计时器 100ms（10Hz）轮询 DOM；`viewport.ts:882` 终端健康检查 5s。
  都有清理路径，属可接受成本。
- `events.ts:61-80` 仍以 `window.__tcToggle` / `__thinkingToggle` + HTML 内联
  `onclick` 属性接线（React 已接管渲染写侧）。CSP 与可测性上都属于历史包袱。
- browser 层大量「查一个 id 就改」的写法让 `getElementById` 127 处散落（session-engine 31、input 29、events 22），
  已由 `audit:remnants` 与真机核对兜着，删改前必须走完整清单。

---

## 建议处理顺序

1. ✅ P0-1…P0-4、P1-1…P1-8、P2 清单已处理并逐项验证（见上文与《P1-4…P1-8 + P2 批量处理结果》）。
2. **P1-4 方向待定**：深色模式要么接上（需设计 + 视觉重做），要么维持现状（死规则已删、契约注释已订正）。
3. **P2 剩余**：`sendInputFromBox` 返回值约定无消费者、`any`/非空断言集中、`sessionScales` 以外的无界容器、
   以及 P1-8 里剩余的「不看 status」调用点（清单见该节）。
4. **真机验收**：无头验收已给判别性证据（见《验收证据》），但手机端/原生壳的项目需你在真机上过一遍。

---

## 验收证据（无头浏览器，两套目标对比）

工具：本机 playwright（`chromium_headless_shell-1244`）；脚本放 `/tmp/wandaudit/acceptance2.mjs`（不入库）。
目标 A = 本次构建的隔离实例（`/tmp/wand-acc`，`node dist/cli.js web`，端口 8601）；
目标 B = 本机已安装服务（`~/.wand/acceptance-connection.json` 的 serverURL + 连接码，凭据不落盘不打印）。

| 检查项 | 目标 A（本次构建） | 目标 B（已安装） | 备注 |
| --- | --- | --- | --- |
| 连接码/appToken 登录 | PASS | PASS | 两套都真的登入了 |
| 壳挂载 + 无 mount 错误 | PASS | PASS | composer/sidebar 均存在 |
| P1-4 死深色规则已删 | PASS（`deadRule=false`） | **FAIL**（`deadRule=true`） | 判别性：已安装仍是旧 CSS |
| P0-2 注销失败留在已登录态 + 提示 | PASS（`注销失败（HTTP 500），请重试。`） | PASS | 已安装已含 P0 那轮的修复 |
| P1-3 登录页不自动起会话 | PASS（`/api/commands` 0 次） | PASS | 两边都为 0 → **不具判别力**，该修复的证据是离线单测 |
| P1-7 长按只留一个复制按钮 | PASS | PASS | 语义新旧一致 |
| P1-7 空点不全量扫 DOM | PASS（`scans=0`） | **FAIL**（`scans=1`） | 判别性：已安装仍是旧 handlers |

结论：目标 A 8/8 通过；已安装服务在**恰好两个与本轮改动直接对应的项上失败**。
可据此判断：已安装服务跑的是包含 P0 那轮、但不含本轮（l1/l4）改动的构建。
（另一条证据：已安装页面的 CSS 里 `[data-theme=dark] .queue-bar` 仍在，CSS 共 6 处 `data-theme` vs 本次构建 5 处。）

方法学备注（避免误报）：

- 不能靠 grep 已服务 HTML 里的中文字串识别构建 —— bundle 被 minify 时按 ASCII charset 把非 ASCII 写成 `\uXXXX`，中文全部搜不到；
  构建识别只能靠行为了（CSS 选择器、DOM 扫描计数、错误文案）。
- 反向代理（`home.huniu.fu:8443`）可能对页面做缓存，同一个 URL 的不同请求可能拿到不同代际的资产；
  所以**最终真机验收必须在部署本次构建之后再做**。
- 探针前期出现过一次自相矛盾读数（已安装也报出了新文案），追下去是断言选择器过宽（`[class*=notification]` 把登录页/其它面板文本也算进去）。
  改成「精确类 + 文案正则双条件」后读数稳定；这也提醒：断言必须同时限定容器与文本。

## 真机验收清单（需在真机/原生壳上跑，部署本次构建后）

1. **移动端复制按钮**（触屏）：长按一条消息 → 只出现一个“复制”；再长按另一条 → 旧的消失、只剩新的；
   点页面其它位置 → 消失；再空点一次 → 无任何副作用；点“复制”本身 → 复制成功且按钮不被误隐藏。
2. **键盘/视口**（iOS/Android 壳）：键盘弹起→收起后立刻切会话/离开终端页，确认 `--app-viewport-height/-top`
   不停在动画中间值、底部输入框不偏移；连续快速 focus/blur 输入框（含 IME）无叠加抖动。
3. **跨会话排队**（登录后）：把一条消息排到队列里，确认登录页/登出后**不会**自动起会话；
   登录后队列能正常继续 flush；登出后 Network 面板不再出现 401 的 `/api/commands`。
4. **看板自动标题**：只写描述创建任务 → 立刻关看板/切走 → Network 面板在接下来 20s 内不应再出现
   `/api/wand-tasks` 轮询（旧行为会追到 19s）；再打开看板确认标题最终能刷新。
5. **任务卡片的工具结果**：截断的工具卡片点开后，404/5xx 时提示带状态码且可重试（不再缓存失败结果）。
6. **更新/重启卡片**（需能触发）：服务端拒绝重启（如 403）时停在卡片可重试；网络中断才进重启遮罩。
7. **分屏缩放**：同一窗格内切 tab（A→B→A）后终端缩放回落默认是否符合预期（若期望“按会话记住”，需改设计）。
8. **深色模式**：维持现状（无深色），确认无任何面板因缺失深色值而异常。

## 复核记录（自查找汇总）

第四轮（2026-09-22「PTY 响应卡死」专项，不在原审计清单内）：

1. **根因不在客户端 CPU，而在服务端的会话级 pause**。按秒采样真实服务：一个声明 `ptyAck`
   但停止 ack 的客户端（手机切后台 / WebView 被节流 / 标签页休眠）累计到 512KB 未确认后触发
   `pausePtyOutput`，服务端 ingest 下一秒从 70KB/s 掉到 0 且**不恢复**，同时健康客户端一起被冻。
   这与用户现象完全对得上：输入端（原生壳走 HTTP）仍生效、pi 侧真记下了 9 次 shift-tab，
   但画面不动。修法：per-client 降级（停发过期 TUI 帧）+ 追上来用终端快照重建，
   会话级 pause 连同 `TerminalProcess.pause/resume` 一并删除。
2. **量化否决了 4 项原计划改动**（都是先测后决定，不是漏做）：`appendWindow` 满窗拷贝
   43µs/chunk（13.2 MB/s append 吞吐，~1% CPU）；xterm headless 解析 33–62 MB/s
   （每个仿真实例 ~0.2% CPU）；客户端 `clamp((buf)+chunk)` 725 MB/s；每 5s 的
   PTY output 落库节流会破坏“连续输出也必须每秒落库”这个已被测试钉住的耐久性契约
   （`process-manager-safety.test.ts:451`，服务端重启后要用它恢复终端），已回滚。
3. **init/resync 不再瘦身**：`init` 里的 `output` 是 PTY 聊天转录的唯一来源
   （`restoreTerminalState` 把它写进 `state.terminalOutput`），只留 `terminalState` 快照会让
   重连后 PTY 聊天记录截断。属于需要单独设计的改动。
4. **客户端侧只留下确实成立的一处**：分片热路径原来逐分片做
   `getElementById`×2 + 读 `scrollTop/scrollHeight`（强制同步布局），现在收进 rAF 合并。
   5x CPU 节流下回归：消息间隔上限从 300–500ms 降到 117ms、0 次重建、落后 0 帧。
5. **复现/量化脚本留在 `/tmp/wand-pty-repro/`**（`flood.mjs` 造 TUI 满屏重绘洪流、
   `pause-test.mjs` 双客户端背压实验、`repro.mjs` 手机视口 + 5x 节流客户端指标）。
   不进仓库（属一次性探针）。

第三轮（6 lane 批量）的复查结论：

1. **6 名独立复核者均给 accepted**（无 P0/P1）；但他们找出的 6 条 P2 里，有 3 条是真问题，
   已由父级修掉并补测：`sessionScales.delete` 位置（早退之后 → 移到之前）、
   l2 测试从不覆盖生产默认延迟（新增用例，并验证旧实现下会红）、l4 自动隐藏后引用残留。
2. **两条复核结论修正了我的原本预期**：P2 去 `export` 在 bundle 里是 0 字节（打包器把仅本模块使用的导出打平），
   不是“净减少字节”；所以 l6 只是缩小模块 API 面与 Map 清理，不应当成瘦身提交。
3. **一条复核建议被采纳为产品待定**：重启被拒时不再进重启遮罩（可见行为变化），已列真机清单第 6 项。
4. **`npm run check` 在合并后拓到一个我自引入的类型错误**（hoist 引用时给了过窄的 `HTMLButtonElement`，
   实际赋值是 `Element`）——说明分 lane 并行时，单 lane 的 tsc 通过不等于合并后通过；集成验收不可省。

第二轮（P1-2 / P1-3）的复查结论：

1. **P1-2 的目标描述写小了**：原文说“三套”，实际是四处（转写抓取里还有 45 行内联列表）。
   已全部收进 `pty-noise.ts`。四套的判定范围**没有**合并 —— 先试算过：把 system-info 卡片
   直接改成 `isPtyNoiseLine` 会把 `╭───╮` 框线行从卡片里删掉，属于渲染行为变更，因此
   改成“同一文件四个谓词 + 差异写进注释与测试”。这是有意不做全量合并，不是遗漏。
2. **发现两处既有行为需要后续验证**（均未改代码，避免在无真机转写证据时改渲染）：
   框线规则不含 `╮`/`╰`；`codexFooterRe` 不匹配连字符模型 slug。已写进用例注释。
3. **P1-3 连带风险已一并修**：队列从 localStorage 恢复后，登录前/登出后会拿 401 去
   `POST /api/commands`（`flushCrossSessionQueue` 新增 `state.config` 门禁）。这条不在原审计
   清单里，是改定时器时顺着队列生命周期读出来的。
4. **预算换空间是真实删除，不是挪位置**：删的 5 处 `console.log` + 1 处 `console.debug` +
   3 处 `.voice-record-label` 查找都逐个确认过（无生产者、无 CSS 规则、纯诊断输出）。
   净结果 501.7 → 501.5 KiB gzip。

第一轮（P0）的复查结论（保留）：

修复完成后重新逐条对着代码复核，发现并处理了 2 个问题，其余结论维持：

1. **自己引入的回归（已修）**：P0-4 第一版删掉 `keepLocalOutput` 时，按「长度启发式」
   一概删除。复核 `src/session-transport.ts:20` 才发现 `SessionListItemDTO` 的 `output`
   被固定成 `""`（注释：给客户端初始化终端用的兼容占位），而列表路由 `GET /api/sessions`
   正是 `mergeServerSession` 的唯一调用点 —— 旧的长度比较是这条契约的配套保护，
   不是多余启发式。已先写失败用例（`列表占位输出不得清空本地缓冲`，实际得到 `''`），
   再改成显式占位规则。
2. **登出判据的假阴性（已修）**：第一版用 `parseJsonResponse` 判定成功，会在
   「服务端已 revoke + clearCookie、但响应体不是 JSON」时判失败，把用户留在已登录态。
   改为只看 2xx，并补了「非 JSON 2xx 仍然登出」用例。

复核里确认无误的部分：

- `mergeServerSession` 的权限分支改写与改动前逐位等价（`!x && x !== false` 与原
  `=== false` 早退分支同义）；`JSON.stringify` 长度比较在唯一调用点不可达，删除无行为影响。
- `sessionReads.record/merge` 能覆盖「请求期间被推送更新」的字段：服务端是每个 push 的
  来源，快照在请求之后生成，「本地更长但更旧」需要「本地更新早于请求」，而那种更新
  已经在服务端的快照里了。客户端乐观写入（队列等）走 `updateSessionSnapshot` →
  `sessionReads.record`，被 `read.merge` 保护。
- `websocket.ts` 的 diff 只有「import 换成共享实现 + 删掉重复函数」，`renderChat` 仍在用，
  `CHAT_RENDER_*` 已无引用（已从 import 移除）。
- 已跑：`npm run check`（3 套 tsconfig 0 error）、`npm test`（1026 pass / 0 fail）、
  `npm run build`（预算 501.7/502.0 KiB）、`git diff --check`（无空白问题）。

遗留说明（本轮未改，已记录）：

- 列表刷新保留了本地 `messages` 原值（含 `__processing` / `__queued` 渲染占位），
  而改动前对**非当前会话**会先 `stripRenderOnlyStructuredMessages`。差异只在
  「非当前会话 + 本地存在渲染占位」时出现，且下一次 WS 事件写入快照时会
  `normalizeStructuredSnapshot` 剥掉，因此按「不为不可达路径增加代码」处理；
  如果后续发现重复排队气泡，这里是第一怀疑点。
- Web 侧登出、批量删除仍是命令式 DOM 层（legacy），未迁移到 React；本轮只修语义。
- 真机验收（本机已安装 Wand + 连接码）尚未执行：登出失败提示、部分删除失败重试、
  列表刷新后当前会话输出不丢，这三条需要在真实客户端/浏览器里过一遍。

---

## 已知未完成清单（Backlog）— 待处理

本节是本次审计的**未完成部分汇总**（截止本轮）。已处理的见上文各节与《P1-4…P1-8 + P2 批量处理结果》。
每条都带：位置 / 为什么没做 / 验收方式。

### A. 需要你先定方向（阻塞其它改动）

- **A1. 深色模式（P1-4 的方向）**：本轮只做了保守清理（删死规则 + 订正 `appica.css` 契约注释），
  并没有接线。两个选项：
  - 接上：需要在某个壳（React Shell 或原生注入）设置 `data-theme`，并补齐各面板的深色值。
    **现状阻碍**：`src/web-ui/react/styles/features.ts` 有硬编码浅色（`#ffffff`@777/1726、
    `#fff7ef`@1808、`rgba(255,255,255,.48/.55/.6/.78/.92)`@988/1795/1687/1711/1721），
    即使接上 `data-theme` 也不会跟着变；终端/diff/代码高亮的语义色不算在内。
  - 维持：已做的事就够（死规则已删、注释已订正、`@custom-variant` 保留以便将来一行接线）。
  - 验收：接上则用 playwright 在两套主题下截图对比 + 真机核对；维持则只需确认无面板视觉异常。
- **A2. 更新/重启卡片的失败语义**（l5 声明的可见变化）：服务端拒绝重启（403/5xx）时不再进重启遮罩，
  而是停在更新卡片可重试；网络中断才进遮罩。旧行为是「响应体可解析就进遮罩然后永远等」。
  位置：`browser/notifications.ts` 的 `performRestartCard()` 与 `/api/update` 失败分支。
  需要你确认这个变化可接受（已列入真机清单第 6 项）。
- **A3. 分屏缩放语义**（l6 声明的变宽）：同一窗格内切 tab（A→B→A）也会把该会话缩放回落默认，
  因为 `workspace-window.tsx:62-70` 的 effect cleanup 会 `disposePooledTerminal`。
  若期望「按会话记住缩放」，就得改成只有真正关闭会话时才清记录（当前按“缩放是窗格偏好”处理）。

### B. 已定位、证据清楚、可直接动手（建议按序）

- **B1. P1-7 剩余（模块级 document 监听不可拆）**：`chat-render.ts` 的 `initMobileCopyLongPress()`
  仍有 4 个 document 监听永不解绑（本轮只把其 DOM 扫描改成引用化）；
  `render.ts` 的 7 个前台同步监听（已有幂等测试）、`state.ts:343+` 的 pagehide/beforeunload/pageshow、
  `input.ts` 的队列 click 委派、`settings-runtime-bridge.ts` / `ui-store-bridge.ts` 各 2–3 个。
  单页应用里不算泄漏；只有要做「一次性扫码/最小化即拆」才需要收成可拆控制器。
  验收：新增/扩展 vm 测试，断言安装 N 次只有 1 份、拆后为 0。
- **B2. P1-8 剩余（不看 `res.ok`）**：本轮只收了 4 个具名调用点 + 跨会话队列 2 处。剩余已点名：
  - `browser/input.ts` resume 路径：`:2703`、`:2756`、`:2793`、`:2823`、`:2837`；
  - `browser/session-engine.ts`：`:794`、`:959`、`:1018`、`:2025`、`:2124`（另有 `:832/914/1929/1934/1948/1952`
    需要逐个确认同一条链里是否已有 `res.ok` 守卫：本文件里大量 `res.json()` 是写在
    `if (!res.ok) { … throw … }` 之后的成功分支，不属于缺陷）。
  危害：服务端回非 JSON 5xx（反代/HTML 错误页）时，`res.json()` 抛 `SyntaxError`，
  toast 直接显示 `Unexpected token '<'`。
  做法建议：统一 `parseJsonResponse`；改前先确认每个调用点的 catch 是否会回填草稿/队列（别破坏既有语义）。
- **B3. P1-6 剩余（同族一次性定时器）**：`browser/viewport.ts` 仍有 `:214`(220ms)、`:238`、
  `:272/273`(240/720ms)、`:279`、`:293/294`(80/420ms) 等未跟踪的 `setTimeout`。
  本轮只收了两批 settle；这些若也要可拆，需按同样模式收进数组并在 `teardownTerminal()` 清空。
- **B4. `audit:remnants` 34 个候选未闭环**：`npm run audit:remnants` 的候选里，
  已确认有假阳性（如 `.tool-use-card` 的生产者在 `chat-render.ts` 字符串拼接里），
  其余需在**真机 + 隐藏状态**（折叠/抽屉/弹层/移动端/`?reactUi=0`）下逐个核对后再删。
  另外该工具的 `--fail-on-found` 目前没挂 CI（设计如此：候选≠故障）。
- **B5. P2 剩余**：
  - `sendInputFromBox` 的「`resolve()` = 未处理」返回约定无消费者（3 个调用点全丢弃：
    `input.ts:644`、`:2327`、`session-engine.ts:2158`）；直通模式分支还有 `.catch(function(){})`（失败无 toast/回填，靠服务端 `pty_error` 兜）。
  - `any` 243 处 / 非空断言 55 处集中在 browser 层（chat-scroll 38、notifications 38、events 27、websocket 25）。
  - `escapeHtml` 两份实现（`web-ui/scripts.ts:6` 服务端用、`browser/text-escape.ts:6` 浏览器用），无测试锁两者一致。
  - `browser/chat-scroll.ts:6-8` 残留注释与注释掉的 import（`// import { iconSvg } from "./i18n";` + `// TODO: ...`）。
  - `browser/notifications.ts:239`：`type` 未白名单校验就拼进 `class="notification-bubble-icon ' + type + '"`，
    是属性注入面（当前所有调用点传字面量，低危）；改成白名单可一行解决。
- **B6. P1-2 两处待真机转写证据**（本轮刻意不改渲染）：
  - 聊天流框线规则字符集不含 `╮`/`╰`，`╭───╮` 这类 banner 框线一直保留（`├────┤` 会命中）；
  - `pty-noise.ts` 的 `codexFooterRe` 要求模型名与 `·` 之间有空白，若真实 Codex 输出是
    `gpt-5.1-codex · 42% left · /path`（连字符 slug）则抓不到。
  验收：拿一份真实 claude/codex PTY 转写当 fixture，写表驱动用例锁定期望。
- **B7. l2 的闭包隐患（低危）**：`task-board-host.tsx:343` 用 `titlePollerRef.current ??=`，
  永久捕获**首次**的 `reload`；今天 `reload` 是 `useCallback(…, [])` 才安全。
  若将来给 `reload` 加依赖，需改为 `reloadRef`（每渲染更新）再传 `(...a) => reloadRef.current(...)`。
- **B8. 文档自身漂移**：附录 A 是**改动前快照**（函数名/行号已被本轮改动漂移，例如 `isNoiseLine` 已移入
  `pty-noise.ts`、`AUTO_TITLE_POLL_DELAYS_MS` 已移入 `generated-title-poll.ts`）。
  需要时按同一口径重跑 AST 脚本再替换；正文里的行号引用同理（只看“位置”小节时要留意代际）。

### C. 发布/流程约束（不是代码缺陷，但会挡路）

- **C1. 预算只剩 0.1 KiB**：`scripts.js` gzip **501.9 / 502.0 KiB**、css 90.3/97.7（含 09-22 PTY 背压修复）。
  下一批前端改动要么先做净删，要么按脚本要求在同一提交里上调 `BUDGET` 并写明原因。
- **C2. 已部署（09-22 01:43）**：本机服务已重启到 `4.72.0-debug.t09220943`（PID 77279），
  内容 = **当时工作树的全部未提交改动**（P0 那轮 + l1–l6 + 另一个任务的 structured/pty-terminal-state
  在途改动 + 本轮的 PTY 背压修复）。部署方式与 start.sh 同口径（`WAND_BUILD_CHANNEL=beta` +
  `-debug.tMMDDHHMM`、`npm pack` → `npm i -g --prefix <nvm prefix>`、+x spawn-helper、资源 `cmp` 校验），
  重启用 `/api/restart`（launchd `KeepAlive` 拉起，无需 sudo）；`terminald` 未重启，PTY 会话全部存活（含本会话）。
- **C2. 本轮改动未部署**：已安装服务（`https://home.huniu.fun:8443` + 连接码）跑的是
  “含 P0 那轮、不含本轮 l1/l4”的构建（判据：它仍带 `[data-theme=dark] .queue-bar`，且空点仍扫 DOM）。
  真机验收需在部署本次构建之后再做（清单见上节）。**不要现在部署**：工作区还混着另一个任务的在途改动。
- **C3. 未 commit**：本审计的 web 改动 = 22 个 `src/web-ui/**` 文件 + 2 个新源码模块
  （`browser/pty-noise.ts`、`react/issues/generated-title-poll.ts`）+ 10 个新测试 + 本文档。
  建议按 6 个逻辑变更拆（P1-4 / P1-5 / P1-6 / P1-7 / P1-8 / P2），纯删除与行为修复不混提交。
- **C4. 工作区归属**：`src/ws-broadcast.ts`、`src/process-manager.ts`、`src/server.ts`、
  `src/terminal-host.ts` 已被本轮（09-22 PTY 背压修复）继续修改；`src/pty-terminal-state.ts`
  仍属另一个任务的在途改动。`tests/ws-broadcast.test.ts` 已随本次修复全部通过（全量 `npm test` 1065 pass）。
  提交时需按逻辑拆：本轮 PTY 背压修复 = `ws-broadcast.ts` / `terminal-host.ts` /
  `terminal-daemon-client.ts` / `process-manager.ts`（只删 pauseOutput+resumeOutput）/ `server.ts`（只删两行 wiring）/
  `browser/terminal.ts`+`websocket.ts`（只改分片热路径）/ `tests/ws-broadcast.test.ts` / `docs/server-logic-analysis.md`。

---

## 附录 A：逐文件函数登记（4399 个函数的汇总视图）

列含义：文件 | 行数 | 函数/lambda 数 | 最大三个函数 | 被模式扫描标记的函数（`@行号[标记]`）。
标记含义：`timer+N` 定时器多于清理点、`raf+N`、`listener+N`、`innerHTML`、`内联onclick`、
`空catch×N`、`any×N`、`非空断言×N`、`JSON.parse无try`、`storage无try`、`fetch未检status`
（仅静态标记，react 层多为假阳性，已在正文剔除）、`var风格`、`document监听未解绑`。

> 未标记 ≠ 已审。完整逐函数指标（行数/分支数/各类调用计数）由审计脚本产出，
> 需要时可按同一口径重跑；本表只保留「有信号」的函数，避免用 4399 行噪声糊住结论。

| 文件 | 行数 | 函数数 | 最大的函数 | 被标记的函数 |
| --- | --- | --- | --- | --- |
| `brand-identity.ts` | 13 | 2 | `renderWandBrandMarkup`(10L) | — |
| `browser/active-task.ts` | 81 | 5 | `restoreActiveTask`(24L), `persistActiveTask`(8L), `readActiveTaskId`(7L) | — |
| `browser/agent-runs.ts` | 374 | 27 | `collectAgentRuns`(168L), `deriveSubagentMeta`(33L), `ensureAgent`(22L) | `collectAgentRuns`@207[var风格] |
| `browser/chat-render.ts` | 4037 | 203 | `parseMessages`(501L), `doRenderChat`(482L), `renderMarkdown`(347L) | `renderChat`@31[raf+1]; `scheduleChatRender`@48[空catch×1]; `extractPtySystemInfo`@76[var风格]; `renderChatEmptyState`@169[innerHTML]; `doRenderChat`@179[raf+6,innerHTML,var风格] …共37 |
| `browser/chat-scroll.ts` | 663 | 55 | `bindChatScrollListener`(80L), `applyExpandedState`(65L), `refreshChatUnreadDivider`(40L) | `refreshChatUnreadDivider`@51[innerHTML]; `scrollChatToBottom`@121[timer+1,raf+1]; `prepareChatBottomFollow`@143[raf+1]; `bindChatScrollListener`@156[any×5,var风格]; `applyExpandedState`@582[var风格] |
| `browser/composer-action-error.ts` | 36 | 3 | `syncComposerActionError`(12L), `build`(5L), `showActionError`(4L) | — |
| `browser/composer-attachments-adapter.ts` | 33 | 2 | `syncBrowserComposerAttachments`(16L), `build`(10L) | — |
| `browser/composer-badges-adapter.ts` | 103 | 6 | `syncBrowserComposerBadges`(50L), `build`(43L), `resolveAutoApproveBadge`(6L) | — |
| `browser/composer-config-adapter.ts` | 46 | 3 | `syncBrowserComposerConfig`(19L), `build`(12L), `isScope`(3L) | — |
| `browser/composer-draft.ts` | 68 | 3 | `isAmbiguousComposerSubmissionFailure`(20L), `shouldPersistComposerDraft`(5L), `shouldPersistQueueItemRestore`(3L) | — |
| `browser/composer-popover-adapter.ts` | 38 | 2 | `syncBrowserComposerPopover`(16L), `build`(9L) | — |
| `browser/composer-rail-adapter.ts` | 36 | 3 | `syncBrowserComposerRail`(19L), `onSubmit`(4L) | — |
| `browser/composer-select-adapter.ts` | 65 | 5 | `syncBrowserComposerSelects`(27L), `isControl`(3L), `isScope`(3L) | — |
| `browser/composer-select-values.ts` | 16 | 3 | `normalizeAvailableComposerValue`(8L), `normalizeComposerModelValue`(3L) | — |
| `browser/composer-skills-adapter.ts` | 38 | 2 | `syncBrowserComposerSkills`(18L), `build`(11L) | — |
| `browser/composer-voice-adapter.ts` | 34 | 2 | `syncBrowserComposerVoice`(16L), `build`(10L) | — |
| `browser/desktop-tools-bridge.ts` | 31 | 4 | `createDesktopToolsNavigation`(16L), `openFiles`(5L), `getCloseState`(4L) | — |
| `browser/events.ts` | 666 | 60 | `attachEventListeners`(282L), `bindGlobalListenersOnce`(63L), `selectAgentTab`(22L) | `__fetchToolContent`@16[fetch未检status×1]; `lazyLoadTruncatedToolContent`@42[any×6,innerHTML]; `<module>`@61[innerHTML,内联onclick]; `<module>`@118[空catch×1]; `<module>`@184[innerHTML] …共10 |
| `browser/file-browser.ts` | 133 | 18 | `copyTextSafely`(19L), `adjustTerminalScale`(14L), `setFilePanelOpen`(13L) | `setFilePanelOpen`@29[空catch×1]; `adjustTerminalScale`@67[空catch×1]; `applyTerminalScale`@82[raf+1]; `appendToComposer`@100[空catch×1] |
| `browser/file-preview-adapter.ts` | 125 | 8 | `installFilePreviewLegacyAdapter`(26L), `prepareFilePreviewForCompetingOverlay`(26L), `normalizeSiblings`(12L) | — |
| `browser/floating-panel-position.ts` | 51 | 2 | `computeFloatingPanelPosition`(26L), `clamp`(3L) | — |
| `browser/folder-picker-adapter.ts` | 64 | 8 | `openFolderPickerNow`(11L), `applySelection`(4L), `openFolderPickerFromLegacy`(4L) | — |
| `browser/git-commit.ts` | 140 | 20 | `loadGitStatus`(41L), `openQuickCommitModal`(10L), `displayGitStatus`(6L) | `loadGitStatus`@75[var风格] |
| `browser/git-status-cache.ts` | 54 | 5 | `createGitStatusCache`(20L), `accept`(8L), `nextGitStatusRequestTime`(4L) | — |
| `browser/git-status-refresh.ts` | 72 | 9 | `createGitStatusRefresh`(28L), `schedule`(9L), `startPolling`(8L) | `createGitStatusRefresh`@45[timer+2]; `schedule`@52[timer+1]; `startPolling`@62[timer+1] |
| `browser/i18n.ts` | 142 | 3 | `t`(16L), `iconSvg`(12L), `getActiveLang`(10L) | — |
| `browser/input.ts` | 3105 | 294 | `postStructuredInput`(234L), `sendInputFromBox`(184L), `updateInteractiveControls`(147L) | `startVoiceRecording`@51[空catch×1]; `commitVoiceTranscript`@132[空catch×1]; `autoResizeInput`@147[var风格]; `continueStructuredSession`@312[var风格]; `launchQueueItem`@400[fetch未检status×1] …共36 |
| `browser/legacy-pwa-cleanup.ts` | 85 | 11 | `cleanupLegacyPwaState`(18L), `deleteLegacyCaches`(14L), `unregisterLegacyServiceWorkers`(12L) | — |
| `browser/local-preview-adapter.ts` | 15 | 1 | `openLocalPreviewFromLegacy`(8L) | — |
| `browser/login-visual.ts` | 128 | 3 | `renderLoginVisual`(97L), `renderProviderConnections`(16L) | — |
| `browser/main.ts` | 154 | 16 | `confirmDiscard`(17L), `getSiblings`(6L), `installLocalPreviewLegacyBridge`(5L) | `<module>`@56[空catch×4]; `installLocalPreviewLegacyBridge`@117[空catch×1] |
| `browser/message-reconciliation.ts` | 90 | 4 | `mergeWindowedMessages`(50L), `turnContentVolume`(23L), `mergeAssistantTurn`(8L) | `turnContentVolume`@1[空catch×1]; `mergeWindowedMessages`@41[var风格] |
| `browser/missions-adapter.ts` | 25 | 5 | `installMissionsLegacyAdapter`(17L), `openSession`(6L), `onOpen`(4L) | — |
| `browser/mount-sync.ts` | 39 | 3 | `syncPortalMounts`(15L), `apply`(4L) | — |
| `browser/new-session-adapter.ts` | 90 | 8 | `completeCreate`(15L), `getContext`(14L), `prepareCreate`(13L) | `prepareCreate`@55[空catch×1]; `completeCreate`@69[timer+1] |
| `browser/notifications.ts` | 941 | 64 | `showUpdateBubble`(135L), `_doSyncSessionProgress`(89L), `showNotificationBubble`(64L) | `showNotificationBubble`@218[timer+1,innerHTML,var风格]; `dismissNotification`@283[timer+1]; `_syncWakeLock`@346[空catch×3]; `_getNativePermission`@365[空catch×1]; `requestNotificationPermission`@372[空catch×1] …共12 |
| `browser/pty-paste.ts` | 127 | 8 | `buildPtyAttachmentChunks`(24L), `clipboardImageExtension`(18L), `buildTerminalPasteSequence`(7L) | — |
| `browser/pty-system-info.ts` | 23 | 1 | `shouldExtractPtySystemInfo`(4L) | — |
| `browser/queue-dom.ts` | 60 | 2 | `directChildAnchor`(12L), `resolveInsertBeforeAnchor`(11L) | — |
| `browser/react-overlay-coordinator.ts` | 39 | 2 | `closeReactOverlays`(8L), `closeReactOverlay`(3L) | — |
| `browser/render.ts` | 674 | 33 | `renderAppShell`(146L), `render`(86L), `bindForegroundSyncListeners`(84L) | `renderBootLoading`@94[innerHTML]; `renderBootFailure`@111[innerHTML]; `bindForegroundSyncListeners`@174[listener+7,空catch×3,document监听未解绑,var风格]; `restoreLoginSession`@259[raf+1,listener+1,innerHTML,内联onclick,var风格]; `render`@364[raf+1,innerHTML,var风格] …共6 |
| `browser/session-engine.ts` | 2842 | 309 | `handleInputBoxKeydown`(159L), `startSessionInCwd`(98L), `loadSessions`(96L) | `login`@56[var风格]; `switchServer`@130[空catch×1]; `backToNativeApp`@135[空catch×1]; `logout`@145[空catch×1,fetch未检status×1]; `enqueueSessionConfigMutation`@275[空catch×2] …共40 |
| `browser/session-reads.ts` | 39 | 8 | `createSessionReads`(36L), `begin`(21L), `merge`(10L) | — |
| `browser/session-ui.ts` | 20 | 1 | `getLastAssistantSummary`(19L) | — |
| `browser/settings-runtime-bridge.ts` | 27 | 3 | `installSettingsRuntimeBridge`(17L) | `installSettingsRuntimeBridge`@11[listener+2] |
| `browser/shell-commands.ts` | 169 | 26 | `createBrowserShellCommands`(63L), `confirmAndDelete`(18L), `copyTopbarField`(16L) | — |
| `browser/shell-runtime.ts` | 121 | 12 | `createLegacyRefs`(39L), `renderBrowserReactShell`(29L), `unmountBrowserReactShell`(9L) | `createLegacyRefs`@39[innerHTML] |
| `browser/sidebar.ts` | 95 | 15 | `batchDeleteSelected`(29L), `toggleManagedItemSelection`(14L), `selectAllVisibleItems`(10L) | `batchDeleteSelected`@67[fetch未检status×1] |
| `browser/state.ts` | 349 | 20 | `runLocalStorageMigrations`(13L), `readStoredBoolean`(10L), `trackPageUnloading`(7L) | `runLocalStorageMigrations`@24[空catch×1]; `writeStoredBoolean`@49[空catch×1]; `<module>`@56[空catch×1]; `trackPageUnloading`@343[listener+3] |
| `browser/terminal-fit.ts` | 102 | 5 | `proposeTerminalDimensions`(25L), `measureCell`(15L), `fitTerminalToContainer`(13L) | — |
| `browser/terminal-pool.ts` | 409 | 44 | `createPooledTerminal`(169L), `restorePooledTerminalState`(38L), `writePooledTerminal`(17L) | `scheduleFitAndSync`@96[timer+1,raf+2]; `createPooledTerminal`@140[listener+1] |
| `browser/terminal-wheel.ts` | 136 | 5 | `consumeTerminalWheelPage`(30L), `consumeTerminalWheelLines`(23L), `consumeTerminalTouchPage`(16L) | — |
| `browser/terminal.ts` | 978 | 82 | `initTerminal`(263L), `initTerminalScrollbar`(177L), `initTerminalTouchScroll`(131L) | `addRecentPath`@25[空catch×1,fetch未检status×1]; `initTerminalTouchScroll`@142[listener+4,空catch×2,var风格]; `readCellHeight`@156[空catch×1]; `touchWheelSequence`@180[空catch×1]; `initTerminalScrollbar`@275[raf+1,var风格] …共14 |
| `browser/text-escape.ts` | 13 | 1 | `escapeHtml`(8L) | — |
| `browser/todo-progress.ts` | 102 | 8 | `summarizeTodoProgress`(28L), `buildTodoItemsHtml`(14L), `buildTodoSegmentsHtml`(5L) | — |
| `browser/tool-identity.ts` | 98 | 3 | `getToolIconKind`(19L), `getToolDisplayName`(8L), `getToolIcon`(6L) | — |
| `browser/ui-store-bridge.ts` | 78 | 10 | `browserEnvironment`(16L), `subscribeBrowserChanges`(15L), `createBrowserUiStoreBridge`(12L) | — |
| `browser/utils.ts` | 192 | 11 | `renderStructuredStatusBar`(91L), `scrollPathElementToEnd`(26L), `apply`(18L) | `renderStructuredStatusBar`@31[非空断言×4,innerHTML,var风格]; `scrollPathElementToEnd`@159[raf+1] |
| `browser/viewport.ts` | 1096 | 102 | `setupVisualViewportHandlers`(190L), `teardownTerminal`(98L), `initTerminalResizeHandle`(71L) | `scheduleClosedViewportBaselineWindow`@33[timer+1]; `setupVisualViewportHandlers`@118[timer+9,listener+7,document监听未解绑,var风格]; `scheduleFocusedInputSettle`@179[timer+1]; `updateViewport`@191[timer+3,var风格]; `initTerminalResizeHandle`@309[listener+6,innerHTML,document监听未解绑,var风格] …共19 |
| `browser/websocket.ts` | 908 | 46 | `handleWebSocketMessage`(459L), `initWebSocket`(134L), `postPermissionAction`(41L) | `startPolling`@41[timer+1]; `startWsHeartbeatCheck`@77[timer+1]; `scheduleWsReconnect`@125[timer+1]; `initWebSocket`@145[空catch×1,var风格]; `handleWebSocketMessage`@280[any×13,var风格] …共8 |
| `browser/workspaces-adapter.ts` | 280 | 37 | `installWorkspacesLegacyAdapter`(196L), `openTask`(49L), `newTaskSession`(32L) | — |
| `browser/worktree-merge-adapter.ts` | 205 | 17 | `buildWorktreeMergeOpenContext`(28L), `createRuntime`(22L), `installWorktreeMergeLegacyAdapter`(20L) | — |
| `embedded-assets.ts` | 6 | 1 | `decode`(3L) | — |
| `index.ts` | 51 | 2 | `renderApp`(35L), `vendorAssetUrl`(3L) | — |
| `provider-identity.ts` | 124 | 7 | `renderProviderLogoMarkup`(25L), `inferProviderIdFromCommand`(9L), `providerDisplayName`(6L) | — |
| `react/code-editor/controller.ts` | 459 | 28 | `createCodeEditorModule`(340L), `execute`(113L), `saveFile`(45L) | — |
| `react/code-editor/host.tsx` | 495 | 36 | `CodeEditorHost`(210L), `EditorBody`(93L), `FindBar`(73L) | `handleEditorKeydown`@265[raf+1] |
| `react/code-editor/model.ts` | 90 | 4 | `codeEditorFindMatches`(24L), `caseSensitiveMatches`(13L), `countNewlines`(7L) | — |
| `react/code-editor/repository.ts` | 119 | 6 | `load`(38L), `save`(34L), `failureFromResponse`(12L) | `<module>`@44[fetch未检status×1] |
| `react/composer-action-error/controller.ts` | 32 | 2 | `sameMount`(3L) | — |
| `react/composer-action-error/host.tsx` | 33 | 3 | `ComposerActionErrorHost`(13L), `ComposerActionError`(7L) | — |
| `react/composer-attachments/controller.ts` | 54 | 3 | `sameMount`(8L), `sameItem`(6L) | — |
| `react/composer-attachments/host.tsx` | 61 | 5 | `ComposerAttachments`(33L), `ComposerAttachmentsHost`(13L) | — |
| `react/composer-badges/controller.ts` | 87 | 3 | `sameMount`(14L), `sameStats`(5L) | — |
| `react/composer-badges/host.tsx` | 156 | 13 | `ComposerApprovalStatsBadge`(53L), `ComposerAutoApproveChip`(35L), `ComposerPermissionActions`(19L) | — |
| `react/composer-badges/model.ts` | 23 | 1 | `resolveComposerPermission`(10L) | — |
| `react/composer-config/controller.ts` | 63 | 3 | `sameState`(12L), `sameMount`(3L) | — |
| `react/composer-config/host.tsx` | 115 | 6 | `ComposerConfigControl`(77L), `ComposerConfigHost`(13L), `selectHost`(11L) | — |
| `react/composer-popover/controller.ts` | 39 | 2 | `sameMount`(5L) | — |
| `react/composer-popover/host.tsx` | 54 | 5 | `ComposerPopoverItems`(30L), `ComposerPopoverHost`(13L) | — |
| `react/composer-portal/mount-store.ts` | 50 | 7 | `sync`(11L), `subscribe`(4L), `clear`(4L) | — |
| `react/composer-rail/controller.ts` | 49 | 5 | `sync`(7L), `subscribe`(4L), `clear`(4L) | — |
| `react/composer-rail/host.tsx` | 32 | 2 | `ComposerRailHost`(24L) | — |
| `react/composer-select/controller.ts` | 55 | 5 | `sync`(7L), `subscribe`(4L), `clear`(4L) | — |
| `react/composer-select/host.tsx` | 37 | 2 | `ComposerSelectHost`(31L) | — |
| `react/composer-skills/controller.ts` | 59 | 3 | `sameMount`(9L), `sameOption`(6L) | — |
| `react/composer-skills/host.tsx` | 92 | 6 | `ComposerSkillsPopover`(63L), `ComposerSkillsHost`(13L) | — |
| `react/composer-voice/controller.ts` | 44 | 2 | `sameMount`(6L) | — |
| `react/composer-voice/host.tsx` | 45 | 4 | `ComposerVoiceHost`(13L), `ComposerVoiceBubble`(12L), `bubbleClassName`(6L) | — |
| `react/errors.ts` | 25 | 4 | `describeError`(4L), `failureMessage`(3L), `isAbortError`(3L) | — |
| `react/feature-flags.ts` | 51 | 2 | `isReactUiEnabled`(20L), `readBoolean`(7L) | — |
| `react/file-explorer/controller.ts` | 454 | 29 | `createFileExplorerModule`(377L), `execute`(142L), `runSearch`(43L) | `createFileExplorerModule`@78[listener+1]; `runSearch`@168[listener+1] |
| `react/file-explorer/host.tsx` | 969 | 84 | `FileExplorerHost`(295L), `ExplorerRow`(208L), `SearchPanel`(138L) | — |
| `react/file-explorer/model.ts` | 147 | 12 | `groupFileExplorerSearchResults`(18L), `fileExplorerSearchMatches`(14L), `fileExplorerSearchSegments`(13L) | — |
| `react/file-explorer/move-dialog.tsx` | 259 | 25 | `MoveEntryDialog`(217L), `handleInputKeyDown`(19L), `commit`(18L) | — |
| `react/file-explorer/paths.ts` | 31 | 4 | `joinExplorerPath`(7L), `explorerParentOf`(7L), `isPathWithin`(6L) | — |
| `react/file-explorer/repository.ts` | 130 | 11 | `coerceEntry`(24L), `list`(22L), `postMutation`(19L) | `<module>`@71[fetch未检status×1] |
| `react/file-preview/controller.ts` | 356 | 23 | `createFilePreviewModule`(248L), `execute`(111L), `load`(45L) | — |
| `react/file-preview/host.tsx` | 343 | 28 | `FilePreviewHost`(98L), `PreviewBody`(85L), `PreviewToolbar`(76L) | `PreviewBody`@83[raf+1] |
| `react/file-preview/markdown.tsx` | 137 | 14 | `MarkdownBlock`(41L), `MarkdownInline`(37L), `MarkdownHeading`(11L) | — |
| `react/file-preview/memory-repository.ts` | 80 | 6 | `load`(13L), `save`(13L), `setFile`(4L) | — |
| `react/file-preview/model.ts` | 312 | 21 | `parseFilePreviewMarkdown`(89L), `tokenizeFilePreviewMarkdownInline`(29L), `normalizeFilePreviewRequest`(20L) | — |
| `react/file-preview/platform-adapter.ts` | 8 | 1 | `copyTextToPlatformClipboard`(8L) | — |
| `react/file-preview/repository.ts` | 111 | 8 | `save`(20L), `failureFromResponse`(19L), `normalizeFilePreview`(19L) | `<module>`@74[fetch未检status×1] |
| `react/folder-picker/controller.ts` | 106 | 14 | `open`(8L), `choose`(8L), `configureFolderPickerRuntime`(8L) | — |
| `react/folder-picker/host.tsx` | 256 | 26 | `FolderPickerHost`(229L), `submit`(21L), `handleInputKeyDown`(16L) | — |
| `react/folder-picker/memory-repository.ts` | 44 | 6 | `list`(12L), `cloneListing`(6L), `setListing`(4L) | — |
| `react/folder-picker/model.ts` | 13 | 1 | `nextFolderPickerIndex`(11L) | — |
| `react/folder-picker/repository.ts` | 70 | 6 | `normalizeListing`(23L), `list`(16L), `messageFromPayload`(12L) | `<module>`@52[fetch未检status×1] |
| `react/http-adapter.ts` | 53 | 4 | `parseJsonResponse`(21L), `requestJson`(10L), `jsonBody`(7L) | `requestJson`@35[fetch未检status×1] |
| `react/index.tsx` | 97 | 4 | `startReactUi`(24L), `exposeBusinessControllers`(14L), `getOrCreateChild`(9L) | — |
| `react/issues/controller.ts` | 7 | 7 | `publish`(1L), `open`(1L), `close`(1L) | — |
| `react/issues/host.tsx` | 173 | 23 | `GithubIssuesHost`(157L), `loadFrom`(23L), `create`(19L) | — |
| `react/issues/repository.ts` | 19 | 6 | `list`(3L), `create`(3L), `update`(3L) | — |
| `react/issues/task-board-agent.ts` | 650 | 72 | `filterIssues`(30L), `groupIssueSessionsByAgent`(25L), `issueProgressSeries`(23L) | — |
| `react/issues/task-board-controller.ts` | 147 | 15 | `open`(16L), `close`(15L), `writeLocation`(13L) | `installTaskBoardHistory`@97[listener+1] |
| `react/issues/task-board-host.tsx` | 1331 | 181 | `TaskBoardHost`(940L), `IssueDetail`(252L), `renderCard`(98L) | `refreshGeneratedTitle`@107[timer+1]; `TaskBoardHost`@139[raf+2] |
| `react/issues/task-board-icons.tsx` | 131 | 11 | `TaskBoardStatusIcon`(35L), `TaskBoardPriorityIcon`(28L), `svgProps`(13L) | — |
| `react/issues/task-board-repository.ts` | 121 | 17 | `create`(15L), `dispatch`(11L), `saveAgentDefaults`(9L) | — |
| `react/issues/task-board-view-state.ts` | 46 | 9 | `parseTaskBoardViewState`(19L), `readTaskBoardViewState`(7L), `writeTaskBoardViewState`(3L) | — |
| `react/issues/task-board-views.tsx` | 778 | 89 | `TaskBoardDashboard`(137L), `TaskBoardGantt`(79L), `TaskBoardListView`(66L) | `TaskBoardConversationButton`@80[非空断言×3] |
| `react/issues/task-drag.ts` | 17 | 3 | `startTaskDrag`(5L), `isTaskDrag`(3L), `draggedTaskId`(3L) | — |
| `react/json-utils.ts` | 27 | 5 | `readJson`(9L), `isRecord`(3L), `record`(3L) | — |
| `react/legacy-overlays.ts` | 201 | 16 | `openReactLegacyDialog`(57L), `scheduleFocusRestore`(15L), `showReactLegacyToast`(15L) | `scheduleFocusRestore`@101[timer+1] |
| `react/local-preview/controller.ts` | 176 | 20 | `openFile`(21L), `openUrl`(21L), `submit`(14L) | — |
| `react/local-preview/host.tsx` | 97 | 8 | `LocalPreviewHost`(62L), `ModeToggle`(24L), `submit`(4L) | — |
| `react/milestones/controller.ts` | 102 | 19 | `load`(10L), `configureMilestonesRepository`(10L), `create`(8L) | — |
| `react/milestones/default-iteration.ts` | 66 | 8 | `useDefaultMilestone`(19L), `usePreselectMilestone`(18L), `defaultMilestone`(6L) | — |
| `react/milestones/picker.tsx` | 203 | 15 | `MilestonePicker`(176L), `submit`(15L), `close`(7L) | `MilestonePicker`@28[timer+1]; `startCreating`@72[timer+1] |
| `react/milestones/repository.ts` | 29 | 4 | `list`(4L), `create`(3L), `update`(3L) | — |
| `react/missions/controller.ts` | 59 | 12 | `configureMissionsRuntime`(7L), `closeIfOpen`(6L), `open`(5L) | — |
| `react/missions/host.tsx` | 404 | 59 | `MissionsHost`(301L), `parseDiff`(36L), `submitMission`(32L) | — |
| `react/missions/repository.ts` | 55 | 9 | `markInboxRead`(8L), `create`(6L), `sendReview`(6L) | `<module>`@12[fetch未检status×1]; `<module>`@12[fetch未检status×1] |
| `react/model-catalog.ts` | 118 | 8 | `normalizeWandModelCatalog`(26L), `loadWandModelCatalog`(11L), `wandModelOptions`(9L) | — |
| `react/new-session/choice-navigation.ts` | 22 | 1 | `nextChoice`(13L) | — |
| `react/new-session/controller.ts` | 109 | 14 | `publish`(9L), `configureNewSessionRuntime`(8L), `publishDismissable`(7L) | — |
| `react/new-session/host.tsx` | 575 | 63 | `NewSessionHost`(422L), `submit`(31L), `modeHint`(24L) | `NewSessionHost`@154[timer+1,raf+1]; `navigateChoice`@278[raf+1] |
| `react/new-session/repository.ts` | 241 | 20 | `buildCreateRequest`(55L), `create`(39L), `load`(16L) | `<module>`@145[fetch未检status×1] |
| `react/overlay-controller.tsx` | 123 | 11 | `dialog`(14L), `completeDialog`(10L), `closeTopmost`(6L) | — |
| `react/overlay-host.tsx` | 92 | 4 | `OverlayHost`(58L) | — |
| `react/provider-logo.tsx` | 144 | 2 | `ProviderLogo`(124L) | — |
| `react/quick-commit/controller.ts` | 109 | 15 | `open`(9L), `configureQuickCommitRuntime`(8L), `close`(6L) | — |
| `react/quick-commit/host.tsx` | 620 | 47 | `QuickCommitHost`(464L), `submit`(53L), `ChangedFiles`(43L) | — |
| `react/quick-commit/iteration-panel.tsx` | 150 | 13 | `IterationContextPanel`(104L), `entryMeta`(4L) | — |
| `react/quick-commit/memory-repository.ts` | 110 | 7 | `generate`(14L), `commit`(14L), `push`(9L) | — |
| `react/quick-commit/model.ts` | 138 | 7 | `buildQuickCommitInput`(27L), `buildQuickCommitOutcome`(21L), `quickCommitStatusBadge`(17L) | — |
| `react/quick-commit/repository.ts` | 249 | 21 | `commit`(37L), `generate`(30L), `normalizeQuickCommitStatus`(23L) | `<module>`@121[fetch未检status×1] |
| `react/restart-overlay/controller.ts` | 343 | 39 | `createRestartOverlayController`(259L), `poll`(88L), `begin`(43L) | `poll`@127[timer+1]; `begin`@216[timer+2]; `setInterval`@310[timer+2]; `setTimeout`@316[timer+2] |
| `react/restart-overlay/host.tsx` | 92 | 4 | `RestartOverlayHost`(76L) | — |
| `react/restart-overlay/memory-repository.ts` | 30 | 2 | `loadConfig`(15L) | — |
| `react/restart-overlay/model.ts` | 84 | 4 | `restartOverlayPresentation`(28L), `waitingStatus`(21L), `evaluateRestartReadiness`(19L) | — |
| `react/restart-overlay/repository.ts` | 54 | 5 | `loadConfig`(25L), `normalizeRestartOverlayConfig`(8L) | `<module>`@27[fetch未检status×1] |
| `react/settings/controller.ts` | 83 | 11 | `closeTopmost`(7L), `closeIfOpen`(5L), `publish`(4L) | — |
| `react/settings/fields.tsx` | 213 | 10 | `SettingsTextInput`(43L), `SettingsSelect`(33L), `SettingsToggle`(28L) | — |
| `react/settings/host.tsx` | 335 | 26 | `SettingsHost`(144L), `ConnectedAppAccess`(70L), `SettingsLoading`(25L) | — |
| `react/settings/memory-repository.ts` | 40 | 4 | `execute`(8L), `load`(3L), `replace`(3L) | — |
| `react/settings/repository.ts` | 724 | 46 | `execute`(179L), `normalizeConfig`(67L), `requestPermission`(31L) | `request`@378[fetch未检status×1]; `execute`@537[timer+1,fetch未检status×1]; `cloneSettingsSnapshot`@720[JSON.parse无try×1] |
| `react/settings/tabs.tsx` | 1784 | 224 | `AiSettingsTab`(451L), `NotificationSettingsTab`(164L), `AboutSettingsTab`(137L) | `DistributionSection`@149[非空断言×7]; `AiSettingsTab`@987[非空断言×6]; `SecuritySettingsTab`@1604[timer+1]; `changePassword`@1615[timer+1] |
| `react/shell/chat-width-toggle.tsx` | 67 | 3 | `ChatWidthToggle`(33L) | — |
| `react/shell/chat-width.ts` | 70 | 8 | `setChatWidthMode`(10L), `readStoredChatWidthMode`(8L), `subscribe`(6L) | `setChatWidthMode`@61[空catch×1] |
| `react/shell/legacy-hosts.ts` | 90 | 7 | `mount`(16L), `unmount`(11L), `dispose`(8L) | — |
| `react/shell/legacy-snapshot.ts` | 345 | 19 | `deriveLegacyUiSnapshot`(98L), `sessionToVm`(51L), `sortSessionVms`(14L) | — |
| `react/shell/legacy-ui-actions.ts` | 96 | 2 | `applyLegacyUiAction`(46L), `assertNever`(3L) | — |
| `react/shell/session-elapsed.tsx` | 13 | 5 | `SessionElapsed`(9L) | — |
| `react/shell/shell-app.tsx` | 54 | 3 | `ShellAppFrame`(13L), `getShellLayoutClassName`(7L), `ShellApp`(7L) | — |
| `react/shell/shell-file-panel.tsx` | 163 | 13 | `ShellFilePanel`(135L), `normalizeFilePanelCwd`(7L), `getParentFilePanelCwd`(6L) | — |
| `react/shell/shell-main-content.tsx` | 245 | 12 | `ShellBlankChat`(106L), `ShellMainContent`(74L), `startInProject`(28L) | — |
| `react/shell/shell-sidebar.tsx` | 925 | 62 | `ShellSidebar`(376L), `SessionEntry`(150L), `SessionGroup`(66L) | — |
| `react/shell/shell-topbar.tsx` | 292 | 12 | `ShellTopbar`(151L), `getTopbarMoreActions`(60L), `TopbarMoreMenu`(20L) | — |
| `react/shell/sidebar-peek.tsx` | 70 | 1 | `SidebarPeek`(44L) | — |
| `react/shell/topbar-git-badge.tsx` | 46 | 2 | `TopbarGitBadge`(26L) | — |
| `react/shell/ui-store-react.tsx` | 59 | 9 | `useUiStore`(7L), `createUiStoreExternalSource`(6L), `useUiStoreSnapshot`(5L) | — |
| `react/shell/ui-store.ts` | 478 | 43 | `cloneValue`(17L), `dispatch`(17L), `publish`(17L) | `publish`@328[timer+1] |
| `react/shell/use-sidebar-drawer.ts` | 52 | 4 | `useSidebarDrawer`(49L), `onKeyDown`(30L) | — |
| `react/shell/use-sidebar-peek.ts` | 214 | 31 | `useSidebarPeek`(144L), `useHoverPointer`(18L), `onKeyDown`(14L) | — |
| `react/styles.ts` | 35 | 1 | `installReactUiStyles`(7L) | — |
| `react/task-changes.ts` | 17 | 4 | `subscribeTaskChanges`(4L), `taskMutationCompleted`(4L), `notifyTasksChanged`(3L) | — |
| `react/task-draft-guard.ts` | 14 | 1 | `confirmDiscardTaskDraft`(11L) | — |
| `react/ui/badge.tsx` | 38 | 1 | `WandBadge`(16L) | — |
| `react/ui/brand-mark.tsx` | 15 | 2 | `WandBrandMark`(11L) | — |
| `react/ui/button.tsx` | 97 | 2 | `WandIconButton`(22L), `WandButton`(22L) | — |
| `react/ui/chip.tsx` | 22 | 1 | `WandChip`(8L) | — |
| `react/ui/class-names.ts` | 12 | 2 | `classNames`(3L), `staticClassName`(3L) | — |
| `react/ui/dialog-focus.ts` | 46 | 6 | `watchDialogAutofocus`(35L), `findDialogFocusTarget`(9L), `stop`(7L) | — |
| `react/ui/dialog.tsx` | 295 | 21 | `WandDialog`(116L), `WandDialogSurface`(73L), `makeOpenChangeHandler`(11L) | — |
| `react/ui/dropdown-menu.tsx` | 120 | 5 | `WandDropdownMenuItem`(24L), `WandDropdownMenuContent`(14L), `WandDropdownMenuTrigger`(8L) | — |
| `react/ui/icons.tsx` | 255 | 2 | `WandIcon`(170L), `workspaceTaskIconName`(3L) | — |
| `react/ui/input.tsx` | 24 | 1 | `WandInput`(8L) | — |
| `react/ui/menu.tsx` | 62 | 4 | `WandMenuItem`(25L), `WandMenuSeparator`(3L), `WandMenuLabel`(3L) | — |
| `react/ui/navigation.tsx` | 109 | 4 | `WandNavigation`(35L), `WandNavigationList`(11L), `WandNavigationItem`(11L) | — |
| `react/ui/popover.tsx` | 72 | 1 | `WandPopover`(34L) | — |
| `react/ui/portal-context.tsx` | 29 | 3 | `PortalContainerProvider`(7L), `documentPortalContainer`(4L), `usePortalContainer`(3L) | — |
| `react/ui/search-field.tsx` | 79 | 6 | `WandSearchField`(53L), `clear`(6L) | — |
| `react/ui/select.tsx` | 305 | 23 | `SearchableWandSelect`(102L), `ClassicWandSelect`(69L), `filterSelectOptions`(7L) | — |
| `react/ui/skeleton.tsx` | 15 | 1 | `WandSkeleton`(9L) | — |
| `react/ui/switch.tsx` | 44 | 1 | `WandSwitch`(27L) | — |
| `react/ui/tabs.tsx` | 69 | 4 | `WandTabs`(42L) | — |
| `react/ui/toast.tsx` | 95 | 5 | `WandToastViewport`(23L), `WandToastRegion`(10L), `showWandToast`(9L) | — |
| `react/use-model-catalog.ts` | 22 | 6 | `useWandModelCatalog`(12L) | — |
| `react/workspaces/controller.ts` | 94 | 13 | `publishDismissable`(9L), `configureWorkspacesRuntime`(8L), `open`(5L) | — |
| `react/workspaces/host.tsx` | 454 | 45 | `WorkspacesHost`(411L), `submit`(72L), `startTaskSession`(29L) | `WorkspacesHost`@44[timer+1] |
| `react/workspaces/layout-tree.ts` | 131 | 26 | `moveTab`(20L), `setRatioAt`(10L), `pruneEmpty`(10L) | — |
| `react/workspaces/repository.ts` | 347 | 38 | `normalizeWorkspaceWorktree`(32L), `loadNewProjectDefaults`(25L), `saveTaskLayout`(16L) | `<module>`@109[fetch未检status×1]; `<module>`@109[fetch未检status×1]; `loadNewProjectDefaults`@307[fetch未检status×1] |
| `react/workspaces/session-drag.ts` | 14 | 3 | `startSessionDrag`(4L), `isSessionDrag`(3L), `draggedSessionId`(3L) | — |
| `react/workspaces/session-mark.tsx` | 22 | 1 | `SessionProviderMark`(15L) | — |
| `react/workspaces/session-move-button.tsx` | 51 | 14 | `SessionMoveButton`(44L) | — |
| `react/workspaces/session-open.ts` | 89 | 7 | `openSessionWithOwningTask`(26L), `findTaskContext`(12L), `findSessionOwningTask`(11L) | — |
| `react/workspaces/session-order.ts` | 104 | 12 | `orderWorkspaceSessions`(16L), `workspaceSessionProvider`(15L), `isCommandFallbackTitle`(14L) | — |
| `react/workspaces/session-task-lookup.ts` | 19 | 8 | `findSessionTask`(13L) | — |
| `react/workspaces/sidebar-disclosure.tsx` | 41 | 5 | `useSidebarCollapsed`(23L), `SidebarDisclosure`(15L) | — |
| `react/workspaces/sidebar-manage.ts` | 105 | 18 | `toggleManagedGroup`(14L), `collectManagedIds`(12L), `pruneManagedSelection`(12L) | — |
| `react/workspaces/sidebar-search.ts` | 40 | 12 | `filterSidebarGroups`(30L), `sidebarSearchMatches`(6L), `sessionText`(3L) | — |
| `react/workspaces/sidebar-task-meta.ts` | 51 | 9 | `sidebarSelection`(16L), `formatTaskRecency`(13L), `taskActivity`(9L) | — |
| `react/workspaces/task-detail-store.ts` | 76 | 17 | `createTaskDetailStore`(55L), `load`(18L), `subscribe`(15L) | — |
| `react/workspaces/task-layout-controller.ts` | 111 | 13 | `createTaskLayoutController`(88L), `drain`(30L), `save`(11L) | — |
| `react/workspaces/task-tree.ts` | 16 | 3 | `showsTaskSessionDisclosure`(3L), `isDirectoryExpanded`(3L), `isTaskSessionsExpanded`(3L) | — |
| `react/workspaces/window-layout.ts` | 347 | 54 | `reconcileTaskWindowLayout`(47L), `normalizeNode`(34L), `moveSessionBeside`(28L) | — |
| `react/workspaces/workspace-agent-dialog-controller.ts` | 38 | 7 | `publish`(5L), `subscribe`(4L), `open`(3L) | — |
| `react/workspaces/workspace-agent-dialog.tsx` | 122 | 11 | `WorkspaceAgentDialog`(92L), `submit`(14L) | — |
| `react/workspaces/workspace-agent-picker.tsx` | 293 | 31 | `WorkspaceAgentPicker`(134L), `WorkspaceWelcomeChooser`(86L), `submit`(14L) | `WorkspaceAgentPicker`@73[raf+2]; `navigateTarget`@112[raf+1]; `navigateKind`@123[raf+1] |
| `react/workspaces/workspace-context.ts` | 69 | 6 | `subscribe`(6L), `clearActiveWorkspaceContext`(5L), `setActiveWorkspaceContext`(4L) | — |
| `react/workspaces/workspace-tab-bar.tsx` | 332 | 33 | `WorkspaceTabBar`(253L), `handleNewSession`(22L), `selectWindow`(19L) | — |
| `react/workspaces/workspace-window.tsx` | 358 | 37 | `PaneNode`(118L), `WorkspaceWindow`(83L), `SplitNode`(52L) | — |
| `react/workspaces/workspace-worktree-dialog.tsx` | 215 | 18 | `WorkspaceWorktreeDialog`(142L), `WorktreeBubble`(38L), `submit`(14L) | — |
| `react/workspaces/workspace-worktree-model.ts` | 56 | 5 | `buildWorkspaceMergeAgentPrompt`(39L), `workspaceWorktreeSummary`(5L) | — |
| `react/workspaces/workspaces-panel.tsx` | 1600 | 145 | `TaskGroupSection`(441L), `WorkspacesPanel`(405L), `TaskItem`(358L) | — |
| `react/worktree-merge/controller.ts` | 106 | 14 | `open`(13L), `configureWorktreeMergeRuntime`(8L), `close`(6L) | — |
| `react/worktree-merge/host.tsx` | 283 | 21 | `WorktreeMergeHost`(195L), `InspectionDetails`(36L), `confirmMerge`(23L) | — |
| `react/worktree-merge/memory-repository.ts` | 45 | 5 | `inspect`(7L), `result`(6L), `merge`(3L) | — |
| `react/worktree-merge/model.ts` | 65 | 4 | `worktreeMergeAvailability`(27L), `canConfirmWorktreeMerge`(10L), `inspectionStatusMessage`(8L) | — |
| `react/worktree-merge/repository.ts` | 133 | 12 | `readRecord`(18L), `normalizeWorktreeMergeInspection`(16L), `normalizeWorktreeMergeResult`(15L) | `<module>`@95[fetch未检status×1] |
| `scripts.ts` | 36 | 2 | `getScriptContent`(17L), `escapeHtml`(8L) | — |
| `session-activity.ts` | 51 | 4 | `formatElapsedShort`(10L), `computeRunningSignal`(9L), `ptyTurnActive`(4L) | — |
| `sidebar-layout.ts` | 37 | 1 | `usesSidebarDrawer`(4L) | — |
| `styles.ts` | 49 | 4 | `getCSSStyles`(15L), `cssCacheKey`(6L) | — |
