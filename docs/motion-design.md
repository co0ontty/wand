# 动效与交互规范（Wand）

本文件是 **Wand 所有端动效与交互动效的唯一规范**。任何涉及动画、展开/收起、状态反馈、
页面切换的改动都必须符合这里的要求；实现入口见「实现对照表」，**页面不要自己拼动画**。

> Agent 摘要版（自动生效）：仓库根 `AGENTS.md` §「动效与交互（强制）」；
> 跨项目的通用约定在 `~/.pi/agent/AGENTS.md`。

## 0. 三条总则

1. **不跳页**：能用「就地展开」表达的，就不要跳详情页、不要弹新的全屏层。
   只有「内容量本身需要一整屏」时才允许导航。
2. **不位移**：按钮、输入框、图标在状态变化前后 **位置与尺寸不变**，只换内容与形态。
   任何"按下后按钮跑到别处"的实现都算 bug。
3. **可预期**：动画表达「从哪来、到哪去」。收起是展开的倒放，展开从触发点长出。
   没有方向含义的纯装饰动画不加。

时长/曲线统一从 `WandMotion`（`android/app/.../ui/theme/Theme.kt`）取，页面不写字面量：

| 场景 | 取值 |
| --- | --- |
| 按压反馈 | `press` 110ms |
| 颜色 / 小元素切换 | `fast` 150ms |
| 展开 / 收起 / 位移 | `normal` 240ms，进 `emphasized`、出 `exitEasing` |
| 图标变形 | `morph()` 200ms |
| 标签指示条 | `indicator()` 260ms（后缘延后 `indicatorTrailDelayMillis` = 70ms） |
| 旧内容退场 | `quickExit` 90ms（比进场快，避免两层同时全亮） |

`reduceMotionEnabled()` 为真时，所有组件的入场/位移动画退化为瞬时；
「颜色/文字」这类无位移的表达可以保留。

## 1. 搜索框展开

**要求**：点击右上角搜索按钮 → 该位置直接展开成输入框，光标自动定位、键盘自动弹出，
**不跳转页面**；收起时同一段动画倒放。清空与收起不要并排出现两个 ✕。

**实现**：`WandInlineSearchField` + `WandMorphIconButton`（放大镜 ⇄ ✕，`rotationDegrees = 0`）。
字段展开动画由调用方用 `AnimatedContent`（横向位移 + 淡入）承担，见 `HomeTopBar`。

**案例**：首页顶栏搜索（会话 / 任务共用同一个查询词；任务模式下同时过滤看板）。
**不要**：用一整页 SearchScreen、或者弹出带搜索框的弹层来承载「搜一下」。

## 2. 加号点开就地展开面板

**要求**：点击加号 → **从加号原位**展开操作面板；关闭时自然收回加号，不弹底部弹层、
不换页。面板出现在触发按钮的同一侧，触发按钮本身不移动。

**实现**：`WandInlinePanel(visible, growFrom)` + `WandInlinePanelAction`，
触发按钮用 `WandMorphIconButton`（＋ ⇄ ✕）。
底部输入栏里的 ＋ 向上展开（`growFrom = Alignment.Bottom`，面板排在输入行**上方**，
输入行位置不动）；列表卡片里的展开向下长（`Alignment.Top`）。

**案例**：聊天 / PTY 输入栏的「添加附件」；看板任务卡的详情展开。
**关闭路径**：再次点 ＋、系统返回键（`BackHandler`）、选中任一动作、发送消息。

## 3. 提交状态反馈

**要求**：点击提交后，按钮**原地**依次显示 加载 → 完成 → 结果，全程同一个位置、
同一个尺寸，禁止用 Toast/弹窗/整行替换来表达结果。

**实现**：`SendPhase` / `SendEvent` / `sendActionVisual()`（`ui/SendFeedback.kt`，纯逻辑）
+ `WandInPlaceSwap` + `SubmitMorphButton`（`screens/ChatScreen.kt`，internal 复用）。
时间常量：`SEND_SENT_DWELL_MS` 720ms、`SEND_FAILED_DWELL_MS` 1500ms；
失败态停留更久（要能读到错误），完成态只是「确认一眼」。

状态优先级（`sendActionVisual`）：本次提交结果 > 会话常态。所以「刚发出去」不会被
立刻覆盖成「停止」。

**案例**：聊天结构化会话（HTTP ack 驱动 Sending → Sent）、PTY 输入栏（本地发送完成即 Sent）。

## 4. 图标变形

**要求**：形态相关的两个图标之间要**连贯变形**，不能一帧硬切：
菜单 ⇄ 关闭、播放 ⇄ 暂停、发送 ⇄ 停止、放大镜 ⇄ ✕。

**实现**：`WandMorphingIcon` / `WandMorphIconButton`（交叉淡入 + 反向旋转 + 缩放；
Compose 没有路径级 morph，硬做需要 AnimatedVectorDrawable 且要求两侧 path 数一致，
不可维护）。**必须让同一个组件实例承载两个状态**——写成 `if/else` 两个分支会让图标瞬切。

**案例**：顶栏放大镜 ⇄ ✕、输入栏 ＋ ⇄ ✕、发送 ➜ ⇄ 停止 ■（回合进行中自动变形）。

## 5. 标签指示条

**要求**：切换顶部标签时，指示条先被「拉向」新位置、再自然收回，有跟随感，
不是每段自己换底色。

**实现**：`WandSegmentedTrack`（`slideEdgeFractions` 纯几何 + 前后缘错开延迟）+
`WandChoiceStrip`（所有分段控件的唯一入口）。
原理：移动方向上 **前缘先走、后缘晚一拍**，中间态指示条比一段更宽 → 视觉上被拉长再收回。

**案例**：首页「会话 / 任务」、新建任务面板的「启动会话 / 仅建分组」、看板状态筛选、
会话类型（结构化 / PTY）。

## 6. 按钮变步进器

**要求**：点击「加入」后按钮就地展开成数量选择器（− / N / ＋），数量归零或取消时
自动恢复成原按钮。

**状态**：本项目当前**没有计数型动作界面**（没有「加入 N 个」这类入口），
所以暂不落地实现，避免留下永远走不到的死组件。出现这类界面时按下述契约实现：

- 组件放 `WandMotionKit`，命名 `WandStepperAction`；收起态是原按钮，展开态是 `− N ＋`；
- 展开/收起复用 `WandInlinePanel`；N 归零时自动收起（不需要用户再点一次关闭）；
- 归零收起必须与规则 3 一致：值本身要能表达结果（"0" → 回到按钮），不用 Toast 提示。

## 7. 列表项就地展开详情

**要求**：点击列表项 → 详情在**当前页**展开，其他内容顺势下移，不跳转。

**实现**：卡片内 `WandInlinePanel`（`growFrom = Alignment.Top`）+ 列表项 `Modifier.animateItem()`
（下方条目位移有动画）。展开态要给「比收起态更多的信息」（更长正文、全部会话、
完整标签），否则展开没有意义。详情页仍保留入口（展开后的「打开完整任务页」）。

**案例**：看板任务卡（点击卡片就地展开全部会话 + 完整描述 + 「打开完整任务页」）。

## 8. 列表 / 视图切换

**要求**：同一位置切换列表或视图（会话 ⇄ 任务、会话切换）时，内容交叉淡入淡出，
不做整屏硬切、不整屏重入场；旧内容退场快于新内容进场。

**实现**：`AnimatedContent` + `fadeIn(tweenEnter()) togetherWith fadeOut(tweenExit())`
（注意 `togetherWith` 的左侧是**进场**内容，写反会看到两层对调错位）。
页面级导航另见 `WandApp.kt` 的 `singlePaneNav` / `taskSessionTransition`。

**案例**：首页「会话 / 任务」切段。

## 实现对照表

| 规则 | 组件（`ui/components/WandMotionKit.kt`） | 已落地位置 |
| --- | --- | --- |
| 1 搜索就地展开 | `WandInlineSearchField`、`WandMorphIconButton` | `HomeChrome.HomeTopBar` |
| 2 加号就地展开 | `WandInlinePanel`、`WandInlinePanelAction` | 聊天/PTY 输入栏附件、看板任务卡 |
| 3 提交反馈 | `WandInPlaceSwap` + `SendFeedback.kt` + `SubmitMorphButton` | 聊天输入栏、PTY 输入栏 |
| 4 图标变形 | `WandMorphingIcon`、`WandMorphIconButton` | 顶栏搜索、附件 ＋、发送/停止 |
| 5 标签指示条 | `WandSegmentedTrack` | `HomeModeTabs`、`WandChoiceStrip` |
| 6 按钮变步进器 | 待出现界面的组件 | —（本项目暂无计数型动作） |
| 7 列表就地展开 | `WandInlinePanel` | `TaskBoardCard` |
| 8 视图切换 | `AnimatedContent`（页面侧） | 首页会话/任务 |

## 自检清单（改 UI 时逐条过）

1. 有没有出现「点一下跳到另一个页面/全屏弹层」而本可以就地展开的？
2. 触发按钮在动画前后位置、尺寸是否完全一致？（截图对比）
3. 展开/收起是否是同一段动画的正反放？从触发点方向长出？
4. 状态反馈是否留在原地（没有 Toast 承担结果）？
5. 图标是否是**同一个实例**在变形，而不是两个分支切换？
6. 指示条是否前后缘错开（拉伸），而不是两段各自换底色？
7. `reduceMotionEnabled()` 下是否仍有位移/缩放动画残留？
8. 时长/曲线是否取自 `WandMotion`，而不是页面里写死数字？
9. 抽屉/弹层之外的关闭路径（返回键、发送、下拉刷新、切换筛选）是否会留下「停在半开」？
10. 有没有为「暂时用不到」的规则写死组件？（不允许：确认死代码直接删）
