# Wand UX Contract

## Product context

本地 AI 工具工作台；默认中文说明，技术标识原文。日期按浏览器本地时区显示，日期输入保留 YYYY-MM-DD，不做 UTC 日期偏移。
可访问性目标为 WCAG 2.2 AA；本文件规定行为，不代表已经完成所有平台认证。

## Business-context sources

| 领域 | 权威依据 | UI 结果 |
| --- | --- | --- |
| 任务容器与目录归属 | docs/task-first-rollout.md；server-workspace-routes / server-workspace-task-routes | 工作会话属于任务，目录作为分组 |
| 归档与留存 | src/wand-task-sync.ts 的 archiveBoardTask | 归档同步完成关联工作任务，保留会话；操作前说明 |
| 鉴权 | src/server-settings-routes.ts；tests/settings-config.test.ts | 管理设置/明文敏感值依服务端授权，403 不假装成功 |
| 执行 | src/session-registry.ts；docs/client-logic-analysis.md | PTY 与 structured 各自执行，输入协议不由 UI 设计改变 |
| 设计方向 | 用户要求与 docs/web-sidebar-design.md | 以登录页作为全站视觉基准 |

无计费、支付、法律声明修改范围。

## Visual contract

DESIGN.md 镜像 `content/styles.css` 规范值；Appica adapter 和共享组件引用语义 token。禁止平行主题源。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | src/web-ui/react/ui/select.tsx | DESIGN.md + 组件契约 | authored plain / searchable | popup、键盘、窄屏 |
| Date | task-board-host.tsx 既有 date-only 字段 | 服务端 YYYY-MM-DD | native 平台日历 | 不承诺统一操作系统弹出层 |
| Form | 各 feature Host + Controller | 对应 API | 工作区创建 / 待办创建 / 就地保存 | 输入保留、失败恢复、重复提交 |
| Scrollbar | src/web-ui/content/styles.css | DESIGN.md | 原生终端几何保留 | computed style |
| Toast | wandOverlay + react/ui/toast.tsx | 共享通知服务 | success/info/warning/error | live region |
| CRUD | workspaces controller / taskBoardRepository | task-first-rollout.md + wand-task-sync.ts | 立即工作 / 记录待办 / 归档 | 浏览器完整流程 |
| Search | react/ui/search-field.tsx | 本契约 | 本地即时 / 远程 300ms | clear、IME、取消、无结果 |
| Dialog | react/ui/dialog.tsx + wandOverlay | 本契约 | modal / confirmation | Escape、焦点、输入保留 |
| 聊天内容宽度 | chat-width-toggle.tsx + chat-width.ts | DESIGN.md + 本契约 | 铺满（默认）/ 居中 | 顶栏与标签栏同状态、≥1280px 才出现、刷新后不跳变 |

## Flow ledger

| 操作 | 提交中 | 成功去向与反馈 | 失败恢复 |
| --- | --- | --- | --- |
| 侧栏新建任务 | 禁止重复提交与关闭 | 打开新任务的工作会话，提示创建结果 | 留在表单，保留目录/工具/名称，提示原因 |
| 看板新建任务 | 单一 mutation 锁 | 留在当前看板；提示已创建。选择处理中且有描述时按既有 API 首次派发 | 表单内显示错误并保留输入；已创建但派发失败不得伪装成全部失败 |
| 文件保存 | 保留内容，显示保存状态 | 留在编辑器 | 编辑内容保留，可重试 |
| 设置保存 | 分组独立提交 | 保持当前分组，成功提示 | 当前字段值不丢失 |
| 归档任务 | 确认对象与影响后提交 | 回到所属视图；归档中仍能查到记录 | 保留任务与错误反馈 |
| 看板搜索 | 本地即时过滤 | 结果计数；无结果提供清除筛选 | 不对空结果伪造请求错误 |
| 文件搜索 | 300ms 防抖，取消上次请求 | 同一文件面板显示结果 | 保留输入；远程失败不得显示成“没有匹配文件” |
| 关闭看板创建草稿 | 确认是否放弃未保存名称/描述 | 放弃或继续编辑 | 继续编辑时内容完整 |

## Navigation and dataset state

看板/列表/概览/甘特图共享同一任务数据。视图、查询、目录和筛选在同一标签页 sessionStorage 恢复，
不写 URL：这是本地控制台，查询可能包含机器路径，非分享型检索；不承诺跨标签页同步。
任务详情返回原视图。刷新期间保留已有任务；入口由 controller 保持 `view=taskboard` 路由兼容。
本轮维持现有完整任务集 API 与客户端过滤，不增设假分页；大量任务虚拟化须由单独性能证据驱动。
看板设置中文 document.title，弹层不覆盖父页面标题。窄屏保留全部操作，工具栏和列表允许自然换行。

## Resilience and feedback

成功反馈以服务端结果为准，mutations 禁止重复提交，不自动重试有外部副作用的派发。
只读失败提供重新加载，已有快照仍可查看；错误不得被空列表代替。
对话框使用公共组件。草稿关闭提示默认聚焦继续编辑；归档提示默认取消。
`reactUi=0` 的原生 confirm/prompt 是仓库明确保留的回滚路径，产品正常路径不得新增此调用。
原生日期/文件选择由操作系统拥有；其 popup 不套自建假控件。不会因此更换技术栈。

## Verification and migration

类型/行为测试、构建、包体预算和真实浏览器共同验收，静态审计不能替代运行时。
本轮优先任务发现、创建、详情返回、搜索和归档，并复核设置、文件编辑、Shell 的视觉一致性。
未触及的原生端、外部 provider 调用和完整多语言行为不能凭本轮截图宣称合格。
