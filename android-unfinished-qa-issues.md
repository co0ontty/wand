# Android QA Unfinished Issues

日期：2026-06-20

依据：对照上次 Android 模拟器验收建议，检查当前 `android/` 代码状态。本文只列还没有完成或仍需复测确认的项。

## 明确未完成

| 优先级 | 问题 | 当前状态 | 建议修复 |
| --- | --- | --- | --- |
| P1 | `<think>...</think>` 原文泄漏 | 未看到针对原始 `<think>` 标签的解析或过滤。`ChatBlocks.kt` 里的 `replyPreview()` 仍直接拼接 `ContentBlock.Text`，普通文本渲染也会直接走 `MarkdownText(block.text)`。 | 在数据进入 Android 渲染层前把 `<think>...</think>` 转为 `ContentBlock.Thinking`，或在 `ChatBlocks.kt` 增加兜底分段；折叠预览必须排除 thinking 内容。 |
| P2 | 模型/思考深度弹层被键盘遮挡 | `ModelThinkingChip()` 仍使用普通 `DropdownMenu`，没有隐藏键盘，也没有基于 IME inset 调整位置。 | 点击模型 chip 时先隐藏软键盘，或改成支持 `imePadding()` / 可滚动的 bottom sheet。 |
| P2 | Codex 会话的 `全权限` chip 仍有误导 | `ModeChip()` 对 Codex 设置了 `enabled = false`，但 `ControlChip()` 仍显示下拉箭头，外观仍像可展开控件。 | Codex 场景隐藏箭头并做禁用视觉，或点击后给出“Codex 固定全权限”的说明。 |
| P2 | Quick Commit 发射区布局仍需调整 | `QuickCommitSheet` 已有 `navigationBarsPadding()` / `imePadding()`，但右侧发射区仍是固定宽度、`fillMaxHeight()` 的竖向按钮；未看到针对此前底部拥挤/按钮压迫感的布局重构。 | 将发射区改成更稳定的横向操作区，或限制高度并增加底部安全留白；重新在手势导航设备上截图验收。 |
| P3 | 键盘打开时 `回到底部` 浮层仍可能遮挡 | FAB 显示条件仍是 `scrollMode == ChatScrollMode.Manual`，没有检查输入框焦点或 IME 可见状态。 | 输入框聚焦/IME 可见时隐藏该 FAB，或按键盘高度重新定位。 |
| P3 | 附件菜单两项图标相同 | `ComposerActionsMenu()` 中“从相册选择”和“从文件选择”仍都使用 `WandIcons.attach`。 | 相册入口换图片/相册图标，文件入口换文件/文件夹图标，并补充清晰的语义描述。 |

## 部分完成但需要复测

| 优先级 | 问题 | 当前状态 | 复测/后续 |
| --- | --- | --- | --- |
| P0 | 展开历史后点 `回到底部` 跳到空白区 | 已看到明显修复：`followsLatest` 被拆成 `ChatScrollMode.PinLatestTurn / StickToBottom / Manual`，`回到底部` 会先收起历史并滚到 `collapsedBottomIndex`。 | 需要重新安装当前构建到模拟器验证。重点测：展开历史 -> 点 `回到底部`，确认不会停在 `chat-bottom`/pin spacer 造成空白。 |
| P3 | 历史折叠入口文案过密 | 已新增 `InlineHistoryChip()` 和 pinned context bar，折叠入口比之前清晰。 | 建议在长会话上复测横竖屏和窄屏，确认 chip 文案不截断、不挤压用户气泡。 |

