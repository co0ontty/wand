# 对话列表：任务状态与工作区筛选

用户先确认四端设计，随后要求三个选项打开即同屏可见。本轮采用方案 1：不挤占搜索输入，搜索同行保留固定筛选入口；打开后「任务状态 / 工作区 / 归档范围」横向三列下拉，活动筛选为紧凑开关。取代历史预览中的纵向长单选面板。

## 行为契约

- 状态、工作区、归档、活动和搜索取同一条会话的交集；不能用同员工不同会话分别满足条件后拼出假命中。
- 状态读取 `GET /api/tasks` 的 `tasks[].boardTaskStatus`，由服务端真实 `wand_tasks.status` 只读投影。旧 board `done` 映射待验收，不能用 workspace task `active/done` 或运行结束推断业务阶段。
- 默认全部状态、全部工作区、全部归档范围。未关联任务只用于明确 standalone 且没有 workspaceTaskId；缺少任务状态/关联加载失败是未知。真实工作区按稳定 ID；synthetic/global 为未分配，系统调用的未知目录不冒充真实项目。
- 会话归档包括 session.archived 与所属容器真实 archived，不从 boardTaskStatus 推断；归档对象不进入活动筛选。
- 原生端一次共享请求携带 `includeArchived=1`，完整结果供对话筛选，原工作区/首页使用派生活跃投影。活跃后代所需归档祖先保留，父链防环；没有过滤时保留原任务与计数，过滤时仅扣除实际移除成员。失败和 unchanged 不清掉成功快照。
- 面板有独立草案，应用才生效；取消、父层外点与关闭丢弃草案。重置只重置草案；列表清除恢复默认筛选但不清搜索、不换会话、不触碰 composer 草稿。
- 三个入口始终同排可见，选择菜单自身可滚动；工作区搜索在自己的选择浮层。子菜单搜索/选择不误关父层，Escape/返回先关子层。长值省略但完整值可访问。
- 列表状态标在具体任务/会话行；员工父行提供身份与匹配数，不合成员工“总任务状态”。保留桌面隐藏群聊与移动群聊既有政策。

## 实现入口

- Web：`src/web-ui/react/conversations/list-filters.ts`、`list-filter-controls.tsx`、`list-filter-panel.tsx`、`sidebar-sessions.ts`、`sidebar.tsx`、`state.ts`；样式在 `shell/sidebar-styles.ts`。选择器面板按需分块，未打开不加载 Select 运行时，bundle 预算通过，不提高硬上限或基线。
- Server：`src/server-workspace-routes.ts` 的任务目录只读投影与 revision 版本。
- Android：`ui/screens/ConversationFilters.kt`、`ConversationFilterControls.kt`、`ConversationScreens.kt`；完整与活跃数据由 `TaskListState` 持有。
- iOS：`Wand/ConversationListFilters.swift`、`ConversationViews.swift`；完整与活跃数据由 `WorkspaceStore` 持有。
- macOS：`Wand/CommunicationsViews.swift`、`CommunicationsStore.swift`、`WorkspaceModels.swift`；完整与活跃数据由 `WorkspaceStore` 持有。

## 验证与交付事实

本机报告：`output/conversation-filters/`，续接任务 **TASK-217**，会话 `8b618c37-4313-4a39-bef4-1c280b19faea`。

- 业务实现阶段主仓全量：4078 项，3964 通过、114 按配置跳过、0 失败；最终横向布局后 37 项相关回归、类型检查、check/build 与 bundle 预算通过。
- `node scripts/verify-conversation-filters.mjs` 使用真实生产 Web 组件、隔离数据。普通/减动效、组合筛选、计数、清除保留草稿、嵌套菜单搜索/选择与逐层 Escape、320/390px 三字段同排、第三字段可操作、父面板无滚动均通过。不是已安装服务功能验收。
- Android 定点 JVM 和 Kotlin 编译通过；iOS 纯筛选 8 项 XCTest 通过；macOS 完整 App 宿主本轮相关 40 项 XCTest 通过（横向布局前），最终横向原生布局三端均构建通过。原生菜单、字体放大、VoiceOver/TalkBack、键盘与真实触控仍未运行验收，不用源码检查或 Web 截图冒充。
- 最终横向版：Android/iOS `4.106.0-debug.10290918`，macOS `4.106.0-beta.202610290918`。APK、签名 IPA、ZIP/DMG 已部署到 `~/.wand/<platform>/`；`scripts/verify-conversation-filter-delivery.mjs` 核对已安装服务更新接口及实际下载字节/大小/SHA256，三端通过。未安装或启动用户设备，未 push/tag/正式发布。
- **当前安装服务尚无 boardTaskStatus 投影**（92 条任务检查）。尚未重启/安装新服务，Web 新界面与原生任务状态筛选完整生效仍需安全更新服务并完成真实流程验收。不得把本地构建或更新包可下载称为已上线。

## 已记录的边界

- **TASK-214 已修复待验收**：历史预览未安装现有 React 公共样式导致减动效浮层量测异常；接入 `installReactUiStyles` 后复测通过，没有修改生产公共动效。
- **TASK-218**：Mac 两个既有工作区测试的三处断言与未改动的旧目录逻辑不一致；完整 99 项运行曾暴露。本轮新筛选测试及接口/快照回归通过，未删除或放宽旧测试。
- **TASK-219**：全量测试与 Xcode 重编译并行时 150ms 子进程测试偶发缺少初始 stdout，单独及后续全量通过，作为稳定性问题记录。
- **TASK-220**：状态检查出现的无明确本轮时间戳的历史服务提示，待独立核对，未强杀/重启 daemon。

最终安装服务验收需遵守 Core 排空屏障，通过 `~/start.sh` 更新，不使用 `--restart-daemons`；状态不明或排空失败取消，不强停执行。原主仓及三个子模块已有混合工作均保留，未自动提交。
