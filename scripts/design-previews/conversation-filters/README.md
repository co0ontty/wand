# 对话列表：任务状态与工作区筛选（四端设计稿）

状态：用户已确认设计并授权实现；本目录仍仅为设计预览，生产实现位于各端源码。原有主仓、三个原生子模块的混合改动均保留。

## 最新确认调整（取代下方旧面板布局）

用户要求打开后无需滚动才能看到第三个选项。当前生产实现采用方案 1：任务状态、工作区、归档范围横向三列下拉，工作区搜索在自身下拉中；活动开关保持紧凑。主面板无长滚动选项列表，所有三个入口和应用/取消同屏可见。Web 复用 Ant Select 与现有 Popover，原生端使用原生菜单/搜索子浮层。320/390px Web 实际组件已验证三个入口同排、无父层滚动、子层搜索不关父层及逐层 Escape。

本目录旧四端展示图保留为历史方案，不作为最新长面板验收依据。最新实际 Web 组件截图见 `output/conversation-filters/web/narrow-320.png`、`narrow-390.png`，验证入口 `node scripts/verify-conversation-filters.mjs`。原生端最终布局需分别构建并核对，不把 Web 截图称为原生验收。

## 原推荐方案（历史）

- 搜索和筛选入口同一行。默认按钮为「筛选」，有条件时为筛选图标 + 生效维度数。固定宽度，不因数量与文字切换移动搜索框。
- 共用锚定面板：任务状态单选、工作区单选且可搜索；点击「应用筛选」生效并关闭，取消/外点/Escape 丢弃本次未应用选择。面板内「重置」只重置草案，列表旁「清除」立即恢复筛选且保留搜索文字。
- 下方一行简短条件摘要，超长省略但完整值可达。任务状态和工作区取交集，搜索在交集内检索。
- 具体任务子行显示「状态 · 工作区」；员工行只表达身份与匹配数，不把多个任务揉成一个员工状态。筛选不改变当前打开的会话或草稿、不创建任务、不启动执行。
- 展开/收起保持原列表层级；演示默认展开前两位员工，其他行可点击展开。示例数据计数为 4 个员工对话 / 8 条关联会话，待验收 + Wand 为 2 个对话 / 2 条会话。

## 四端映射

| 端 | 布局 | 正式组件方向 |
|---|---|---|
| Web | 56px 导航轨 + 288px 列表，搜索右侧固定筛选按钮 | 现有 Search、Ant Popover/Radio，共享 Portal 和关闭协议 |
| macOS | 同 Web 的信息层级，不另加工具栏 | SwiftUI 原生搜索与锚定 Popover，保留系统键盘行为 |
| iOS | 手机搜索 + 44pt 入口；面板限高、内容滚动、底部操作固定 | SwiftUI 原生控件；不跳页、不默认全屏弹层 |
| Android | 与 iOS 相同语义，48dp 入口 | Material 原生控件与锚定面板 |

当前 HTML 中原生端是布局模拟，不是 SwiftUI/Compose 渲染或真机截图。头像用示例字标，不替换现有身份资源。浅色稿不代表已完成深色、大字号或原生验收。

## 数据与边界（正式落地须遵守）

- 状态沿当前工作树 `src/task-types.ts`、`task-board-agent.ts`：待立项、等待认领、执行中、待验收、待归档、已归档；历史 done 沿既有投影映射，不另立“已完成”假状态。
- 「全部状态」「未关联任务」是筛选选项，不是新业务状态；关联数据未加载/失败不能归为未关联。待验收为 AI 验收阶段，待归档为人工确认阶段，不能从运行结束推断。
- 工作区用稳定 ID 与真实关联，不按目录字符串/名称猜测。全部工作区包含未分配，明确未分配才进入对应项；已删或失效选择保留提示并允许清除。
- 员工下至少一条会话同时匹配状态和工作区才保留该员工；不能用 A 会话匹配状态、B 会话匹配工作区拼出假命中。子行仅显示匹配会话，统计使用同一投影并去重；不拿示例数据推断生产总量。
- 保留现有只看活动会话能力，与业务阶段正交。预览示例仅含运行/非运行，不模拟真实队列和权限请求。
- 对话归档与任务归档并不等价：正式实现保留原有对话归档范围，在面板低频区域呈现，不可拿任务「已归档」替代未绑定任务会话的归档。此稿重点展示两个新增维度，未模拟全部历史归档数据。
- 切换筛选不导航、不清草稿。切换服务器清理失效维度；本机页面往返保留当前筛选，搜索不进 URL。
- Web/Mac 保留当前隐藏群聊的入口政策；移动端保留群聊，真实群任务按关联任务过滤。本稿不恢复桌面隐藏功能。
- 初载/失败/真实空态应区分；预览实现搜索空态与筛选空态，不模拟服务错误和加载。

## 产物与验证

运行：

```sh
node scripts/design-previews/conversation-filters/build.mjs
node scripts/design-previews/conversation-filters/verify.mjs
node scripts/design-previews/conversation-filters/verify.mjs --reduce
```

输出 `output/design-previews/conversation-filters/`：

- `index.html`：离线交互稿，CSP 禁止连接网络，主题仅用内存，不写生产设置。
- `four-platforms-default.png`：四端默认态。
- `four-platforms-filtered.png`：四端待验收 + Wand 交集态。
- `four-platforms-panel.png`：四端与 iOS 面板展开态。
- `verification.json`：默认动效 Chrome 验证通过：四个模拟端的组合筛选、工作区搜索、清除/取消/Escape/外点、空交集、入口几何稳定，以及 390/320px 预览页和浮层水平不溢出。

**TASK-214 已修复并复测**：原预览未调用 `installReactUiStyles()`，缺失现有公共减动效规则，导致全局 duration blanket 使浮层 left/top 量测不稳定。接入已有样式安装器后 `--reduce` 完整通过（`verification-reduced.json`），不需修改生产公共样式或禁用对齐生命周期。历史失败截图 `debug-failure.png` 保留。预览验证仍不代表四端生产验收完成。

原生端真实触控/键盘/Dynamic Type/VoiceOver/TalkBack、深色主题、真实 API 与归档组合均留待方案确认后的实现验收。无需为本轮设计稿构建或部署客户端。

源码核对入口：`src/web-ui/react/conversations/sidebar.tsx`、`macos/Wand/CommunicationsViews.swift`、`ios/Wand/ConversationViews.swift`、`android/app/src/main/java/com/wand/app/ui/screens/ConversationScreens.kt`、各端 AGENTS 与 iOS apple-design 技能。
