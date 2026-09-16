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

## 样式归属与后续视觉方向

先清理失效实现，再调整保留组件。登录页是视觉基准：纸色底、暖中性色、赤陶色
主操作、细分隔线、克制的圆角和明确的文字层级。

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
