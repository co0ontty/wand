# Web 技术栈与职责规范

## 技术选型

沿用已经投入使用的技术栈，不引入第二套页面框架、组件库、路由器或状态库。

| 层 | 统一选型 | 职责 |
| --- | --- | --- |
| 服务端 | Node.js ≥22.5、TypeScript strict、ESM、Express 4 | 鉴权、参数校验、业务路由与运行时组合 |
| 实时与执行 | ws、node-pty、terminal daemon、provider adapters | 实时事件、终端及结构化会话；按 SessionRegistry 分派 |
| 存储 | node:sqlite | 配置偏好、会话与任务持久化；迁移只加不删 |
| Web 页面 | React 19、TypeScript strict | Shell、导航、设置、任务、文件管理与业务弹层 |
| UI 基础组件 | react/ui 下的 Wand 封装，底层 Appica | 按钮、表单、弹层、菜单、焦点与键盘交互 |
| 样式 | CSS 语义 token + Tailwind 4 构建 | Wand 主题与业务布局；Tailwind 生成 Appica 所需工具类 |
| 浏览器运行时 | browser 下的 TypeScript、xterm | 终端、流式聊天、输入协议、WebSocket、登录引导与原生桥接 |
| 构建与测试 | esbuild、tsc、node:test + tsx | 单 HTML 内联资产、三套类型检查、行为测试与包体预算 |

React 与 browser 不是两个竞争的页面框架。认证后的 Shell 已只有 React 实现；
browser 仍持有实际使用中的终端池、聊天渲染和连接生命周期。不能因为文件名含
`legacy` 就删除桥接层，也不能重新创建一套 vanilla Shell。

## 模块边界

```text
React Host → Controller / Store → Repository → HTTP API
                      ↓
                 Runtime adapter → browser runtime → WebSocket / xterm

Express route → 参数与权限检查 → 业务服务 / SessionRegistry → manager / storage
```

- Host 处理展示与交互；Controller 处理异步状态、取消、重试和并发；Repository
  处理 HTTP 与 DTO。可测试的模型逻辑独立于 DOM。
- 外部组件库只在 `react/ui/` 导入。业务组件通过 Wand 封装使用基础控件。
- 普通 JSON 请求复用 `react/http-adapter.ts`，保留 HTTP status，解析失败不得
  伪装成成功的空对象。文件操作和 worktree 等有领域错误结构的 API 保留其领域适配。
- `react/json-utils.ts` 负责未知 JSON 的字段收窄，不将类型断言当成运行时校验。
- imperative DOM 只能修改自己拥有的宿主节点；React 与 xterm/chat 不得相互重建子树。
- `?reactUi=0` 仅回退通用提示/确认框。业务弹层与 Shell 仍为 React；
  `?reactShell=0` 已不再是回滚实现。
- 服务端统一使用 `asyncRoute`、`server-request`、`getErrorMessage`；权限检查与
  业务逻辑必须使用同一次参数解析结果。
- PTY 与 structured 保留独立执行代码，通过 SessionRegistry 统一查找，不合并 runner。

## Shell 与 Composer 的所有权

认证后的 Shell 只由 React 渲染。`browser/render.ts::renderAppShell()` 是运行时
宿主的种子生成器：只保留 `#output`、`#chat-output`、`.input-panel`、
`#file-explorer`、`#cross-session-queue-host`。`shell-runtime.ts` 只搬运这些种子
根的子节点；宿主根的 class、可见性及外围布局由 React 设置。已删除原来生成后
被丢弃的侧栏、顶栏、欢迎页模板，以及仅被这些模板调用的状态和 Git HTML 函数。

- 顶栏运行条、等待授权状态和回复计时节点由 `ShellTopbar` 渲染。计时组件按
  会话 ID 隔离，响应结束或切走会话时清理计时器；数字表示本次挂载后的已观察
  回复时长。browser 不再给 React 徽章追加/删除子节点，也不修改顶栏 class。
- `session-activity.ts` 为顶栏与输入栏停止按钮提供同一套运行判断：structured
  看 `inFlight`，provider PTY 看 `ptyBusy` 和 `providerCliActive`，裸 shell
  看进程状态，空会话和归档会话返回完整的 false 标志。
- Composer 状态行的自动批准、权限操作、批准统计通过 `composer-badges` portal
  渲染。browser 只设置宿主可见性、发布快照、执行会话命令；按钮事件、disabled
  和 aria 状态归 React。权限强调样式以 portal 宿主为选择目标。
- 自动批准与权限请求分别按会话去重。挂载快照比较必须包含会话 ID、pending，
  权限操作还包含 escalation request ID，避免同文案/同开关状态保留旧回调。
  请求发出前校验所选会话与请求身份，响应更新原会话，finally 重新投影当前
  会话；使用共享 HTTP 解析器处理 HTTP 错误和无效响应。

后续迁移沿稳定宿主逐个推进：先迁移 Composer 内剩余展示叶子，再处理聊天消息
展示；WebSocket、终端池、输入分包及原生桥接继续由 browser 运行时承担。每次
迁移同步删除原生产者、事件绑定和 DOM 写入，补会话切换、失败恢复与窄屏回归，
避免两套代码同时修改同一个节点。

## 工作区、任务与 CLI 会话

- 工作区对应工作目录，任务是其下的**逻辑分组**，会话是任务内的执行实例。
  默认创建任务不建子目录、不建 worktree；高级选项可显式开启 worktree 隔离。
- 侧边栏与任务看板通过 `workspaceTaskId` 对应同一个任务；创建、改名、里程碑、
  完成和重新打开双向同步。空任务也显示，同名任务不得按标题自动合并。
  里程碑就是**迭代**：每个任务都有归属（没选时落到全局「默认迭代」），看板/侧栏/
  派发三个新建入口打开时预选默认迭代；细节见 `docs/iteration.md`。
- 会话落地时（侧栏「＋」、标签栏「＋」、派发、关联任务的自动化）就调用
  `syncWorkspaceTaskToBoard` 把归属写进卡片：补卡片、按会话补 Agent、绑定会话、
  `todo → doing`，不必等 `GET /api/wand-tasks` 的全量兜底。单卡读取
  `GET /api/wand-tasks/:id` 也会按需补一次本任务，原生客户端只拉单卡时同样不会
  看到一张没有会话的卡片。
- 新建任务里的提示词属于首个会话，不用于替换任务名称。未分组的历史会话
  继续保留，不因打开看板自动生成任务。
- 会话只有一个任务归属。侧边栏/看板拖动与“移动到其他任务”菜单走同一移动操作：
  原子更新归属与看板关联、清理源任务布局；保留 cwd、进程、历史和运行状态。
  已移出的会话仍使用旧 worktree 时，禁止删除该 worktree 所属任务/工作区。
- 归属由 SQLite 持有，runner checkpoint 不回写旧归属；`SessionRegistry` 按原
  owner 刷新 PTY/structured 内存投影。前端成功写入后通知两个视图刷新，并以轮询
  同步其他客户端的更改。

### 归档就是软删除

用户能删的两处都是**归档**，不是真删：

- 侧栏任务菜单的「归档任务」走 `POST /api/workspace-tasks/:id/archive`
  （`archiveWorkspaceTask`）：先把看板卡片置为 `archived`，再把侧栏任务置为 `done`；
  侧栏把 `done` 任务连同它的会话整段隐藏。终端进程、执行历史、布局和 worktree
  都保留，**不清理 worktree**，随时可以恢复。
- 看板卡片的「归档」/拖进归档区也只是把卡片置为 `archived`，侧栏任务由存储的
  反向投影跟着变成 `done`（`storage.updateWandTask` / `updateWorkspaceTask`）。
- 恢复＝把卡片状态改回 `todo`（拖出归档目录、右键「恢复到等待认领」，或直接
  拖到任意列），侧栏任务随之回到 `active` 重新出现，会话归属不变。

旧版级联删除 `DELETE /api/workspace-tasks/:id?cascade=1` 仍保留给原生客户端
（Android/iOS 的删除按钮就是它，会删终端、清 worktree），Web 侧不再用它；
只有隔离任务还留「删除任务并清理 Worktree」这一个真删入口。

看板不靠轮询之外的额外状态：拖拽用私有 MIME `application/x-wand-task`
（`issues/task-drag.ts`）与终端拖拽 `application/x-wand-session`
（`workspaces/session-drag.ts`）区分，归档区只接受前者，卡片拖到列上仍兼容
`text/plain`。

## 样式归属与后续视觉方向

先清理失效实现，再调整保留组件。登录页是视觉基准：纸色底、暖中性色、赤陶色
主操作、细分隔线、克制的圆角和明确的文字层级。改 token / 层叠前必读
`docs/appica-ui-migration.md`（无层与 Tailwind 分层的覆盖顺序、构建链路、已迁移组件）。

- 全局语义 token 的唯一来源为 `content/styles.css` 的 `:root`。
- `css/appica.css` 只桥接 Appica 独有 token，不重复定义 Wand 已拥有的 token。
- `react/styles/base.ts` 负责共享控件及弹层基础规则；业务样式归各 feature。
- 修改某组件时修改其原规则，不在文件末尾不断叠加覆盖层。
- 终端、代码高亮、diff 的语义颜色保留，不为视觉统一损失信息。
- 动态尺寸可用内联 style；颜色、字体、圆角和交互状态使用共享 token。
- 不手改 scripts.js、embedded-assets.ts、tailwind.css、vendor bundle 或 dist。

## 清理与验证

死代码必须有静态与运行时两类证据。搜索整个 src，包括运行时拼接；在实际页面
查询选择器，并覆盖窄屏、折叠、抽屉、弹层、通用 UI 回滚与原生壳分支。
公开接口、插件扩展、数据库兼容字段、只在媒体条件下生效的规则不能仅凭零引用删除。

纯删除与行为修复分别审查。交付执行 `npm run check`、`npm test`、`npm run build`，
并在隔离配置实例中操作登录、任务、文件、设置与会话。浏览器中的原生 UA 模拟
仅验证 Web 分支，不能替代真机验收。

## Legacy 残留审计（可复跑）

React 迁移删掉的是 legacy 的**渲染层**，留下的往往是「查得到选择器、但没人再造节点」
的查询与写入。这类残留可能不报错，却静默失效或与 React 重复写入，因此必须用
成体系的检查发现，不能靠读代码碰运气。

```bash
npm run audit:remnants              # 未识别到字面量生产者的 DOM 候选
npm run audit:remnants -- --json    # 机器可读
```

判定口径（`scripts/audit-legacy-remnants.js`）：

- **消费者**：`src/web-ui/browser/**` 里的 `getElementById` / `querySelector(All)` /
  `closest` / `matches` / `classList.*` 引用的 id 与 class。
- **可能的生产者**：手编源码中的 JSX 属性、HTML 字符串、`id/className` 赋值、
  `classNames(...)`、`setAttribute(...)`、`classList.add/toggle/replace(...)`。
- 用 TypeScript AST 定位调用与所属函数，忽略注释；CSS 只作为独立线索，不算生产者。
- 动态查询单独计数；变量拼接、第三方组件和运行分支不能由本工具证明。
- 输出仅为候选，不做死代码/可达性判定，也不自动删除。函数名在 bundle 中出现或
  消失都不是充分证据（可能重名、改名、内联或产物过期）。

配套的四类检查（本轮用来定位「刷新后标签栏消失」同族问题）：

1. 状态来源：检查 `deriveLegacyUiSnapshot()` 和 React 各独立 store 的读写、
   初始化、切换、持久化与刷新恢复，不能只确认存在某条赋值语句。
2. DOM 所有权：查 legacy 写入目标是否由 React 同时管理；运行时验证写入时序和
   视觉结果，不把设计上不挂载的节点或初始化期间的空查询直接判为故障。
3. 动作入口：检查 UiAction 的实际派发链，包括菜单配置对象、间接回调和 runtime
   adapter。没有字面量 `dispatch({ type: ... })` 不等于没有入口。
4. 运行时空查询审计：无头浏览器里 hook `getElementById` / `querySelector`，
   驱动登录、任务、标签栏、输入、弹层、移动端与刷新，统计返回 null 的调用点。
   静态差集给候选，运行时命中给证据。

清理标识符前全仓检索（包含同文件引用、测试、脚本、文档、模板与动态字符串），
识别公共 API/扩展点。选择器另需在原生壳、窄屏、折叠、抽屉、弹层及 `?reactUi=0`
下实测；`?reactShell=0` 已没有回滚作用。删除后检查连带无用导入和空函数。
`--fail-on-found` 只表示发现候选，不表示确认故障，不挂 CI 卡口。
