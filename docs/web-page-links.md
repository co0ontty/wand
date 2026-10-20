# Web 精确定位链接

URL 是导航和结果筛选的状态来源；直接访问显式 URL 时不合并本机上次的会话/筛选。旧根地址保留本地恢复兼容，恢复后写成可分享的明确地址。浏览器后退/前进只读取地址，不再调用 `history.back()` 来实现应用内关闭，避免与下一次导航竞争。

## 地址契约

均使用根路径查询参数，兼容既有链接与反向代理；不引入依赖服务器重写的新 pathname。

| 目标 | 例子 / 参数 |
| --- | --- |
| 会话 | `/?view=workspace&session=<稳定会话ID>`；既有 `?session=…` 仍有效且不再消费后删除 |
| 工作区 | `/?view=workspace&workspace=<ID>` |
| 工作任务/窗口/窗格 | `/?view=workspace&workspaceTask=<ID>&window=<窗口ID>&tab=<窗格ID>&session=<会话ID>`；工作任务、看板任务是不同实体，不混用 ID |
| 看板任务详情 | `/?view=taskboard&task=<看板任务ID>`；`view=issues` 兼容 |
| 看板结果 | `boardView=dashboard/board/list/gantt`、`q`、`directory=<工作区ID>`、`sort=manual/priority/due/updated`、`filters`、`display`、`queue`、`zoom`、`hideCompleted`、`boardCollapsed`、`expandedTask` |
| 对话/通讯录 | `view=chats/contacts`、`conversation=<ID>`、`conversationTask`、`conversationRun`、`chatFilter=all/active/archived`、`chatActivity`、`chatQuery`、`directoryTab=employees/presets`、`directoryQuery` |
| 工作区侧栏 | `sidebar=tasks/chats`、`sidebarMode=full/folded/active`、`sidebarQuery`、`workspaceView=directory/recent` |
| 团队 | `view=teams`、`teamPage=employees/teams`、`team=<ID>`、`teamQuery`、`teamFilter=all/running/attention` |
| 历史群聊 | 既有 `view=teamchat&run=<ID>` |
| 定时/全局日历 | `view=schedules/calendar`、既有 `range=month/week`、`scheduleQuery`、`scheduleFilter`、`scheduleDate=YYYY-MM-DD`、`scheduleExpanded`；独立页面另支持 `scheduleView`、`scheduleRange` |
| 设置 | 既有 `settings=<栏目>` / `settings=directory`，`settingsNested=environment`；与底层工作页共存 |

布尔值为 `true/false`；`filters`（statuses/priorities/labels）、`display`（body/mainStatuses）、`boardCollapsed`、`scheduleExpanded` 为 URL 编码后的 JSON，标签、中文和目录不依赖分隔符猜测。搜索词逐次替换当前历史项，离散视图/目标/筛选变化创建历史项。省略筛选使用确定性默认值，不读取本地上次选择。

## 分享、安全与失败

- 页面、任务、会话及窗口均有复制链接入口；账户菜单可复制当前页面。复用公共按钮/菜单实现，不另造浮层。
- 复制只保留 `src/web-ui/page-route.ts` 白名单导航参数，丢弃登录票据、token、URL 用户名/密码、fragment、未知参数和原生壳专用标志。搜索词和目录本身可能包含私人信息，分享前需自行确认内容。
- 不改服务端鉴权；实体仍经已有 API 授权读取。目标不存在/已删除/无权访问时显示失败与返回入口，不自动打开另一个会话。未知参数提示忽略并提供返回工作区入口。
- 请求中的实体关系必须一致：会话属于任务/工作区，窗口属于任务，窗格属于窗口。恢复请求有代次校验，用户后续选择使旧恢复失效；URL 恢复不提交新的布局或执行请求。
- 保存窗口布局仍由原有任务布局 owner 负责；链接只引用稳定窗口/窗格 ID，不把完整布局、草稿、消息或凭据塞进 URL。

## macOS

原生任务详情、结果筛选、对话/工作任务/会话新增复制 Web 精确链接，参数与 Web 共享语义、过滤凭据；URL 在浏览器打开并继续要求登录。Mac 当前原生工作任务是会话标签列表，没有 Web 同款分屏或地址栏，本轮不宣称原生注册/接管所有 HTTP 链接或具备浏览器历史栈。Mac 构建与实际界面验收独立记录，不能用 Web 通过代替。

## 回归入口

- `tests/web-ui-task-board-history.test.ts`：兼容链接、历史恢复、凭据过滤。
- `tests/web-page-navigation.test.ts`：实体关系、无效目标、窗口/窗格、迟到恢复失效。
- `tests/web-url-browser.test.ts`：实际 React 页面详情、搜索、视图、新标签、历史、设置和侧栏；以 `WAND_URL_BROWSER=1` 启用，`WAND_PLAYWRIGHT_MODULE` 可指定本机 Playwright 安装。
- `tests/settings-navigation.test.ts`：设置与底层目标共存。
- macOS `TaskBoardTests.testDesktopPageLinksKeepStableTargetsAndStripCredentials`。

以上测试不需要真实模型。最终已安装服务的交付验收与本地资产覆盖开发验证必须分别报告。
