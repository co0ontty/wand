# Worker Mac 归类与侧栏只读审查 (mac-audit)

Status: succeeded
Model: openai-codex/gpt-5.6-luna
Routing: policy=task_first; selected via user; thinking=high; captain remains final judge; user: openai-codex/gpt-5.6-luna | fallback: anthropic/claude-fable-5 (warning: not probed (lazy fallback)) | fallback: anthropic/claude-fable-5-1 (warning: not probed (lazy fallback))
Fallback models: anthropic/claude-fable-5, anthropic/claude-fable-5-1
Tools: bash, read, write
Requests: 19
Tokens: 1065326

## Output

## 结果摘要

确认 1 个侧栏展示缺口，另有 2 个归类生命周期风险：

1. **未绑定会话不在“工作区 → 任务 → 会话”树中展示**  
   `sidebarDirectoryGroups` 明确丢弃 `standaloneSessions`；`WorkspaceListView.taskGroupBlock` 也只渲染 `group.tasks`。它们被移到 MainShell 下方独立的 `SidebarColumn`，因此不是全局不可见，但目录层级中无法回看/管理未分组会话。  
   - 证据：`macos/Wand/WorkspaceModels.swift:702-732`、`macos/Wand/WorkspaceListView.swift:387-415`
   - 复现：存在 `TaskDirectoryGroup.standaloneSessions` → 打开工作区树 → 只能在下方“会话”区找到，目录节点无直属会话。
   - 影响：归类前后的未分组会话不能在同一目录上下文中展示；搜索/活动筛选分属两套投影。
   - 最小修复：在目录节点下渲染直属会话折叠组，或明确给目录节点显示“直属会话 N”并提供原位展开；同时纳入选择/归档/删除集合。

2. **归类范围切换时旧作业仍会继续，但共享 `busy` 状态可能阻塞新范围**  
   `reset()` 在 busy 时只递增 revision，不取消旧作业；`prepare()` 又以 `!busy` 为前提，因此切换目录后不能立即发起新范围查询，只显示“前一次范围仍在后台整理”。这是有意避免重复提交，但关闭/重开时仍依赖旧 Task 的取消完成。  
   - 证据：`TaskBoardPickers.swift:23-39`
   - 复现：开始归类 → 切换目录/范围 → 立即再次点归类。
   - 影响：用户无法确认新范围是否已执行；旧任务完成时仍会调用 `onChanged()`（`87-98`），可能刷新当前新范围列表。
   - 建议：保留旧作业后台继续，但把前端观察 Task 与作业生命周期彻底分离；新范围应允许独立 preview，旧作业只按 token/job 查询。

3. **TaskBoard 持久化的旧 workspace ID 未做有效性清理**  
   `workspaceFilter` 从本地状态恢复，之后直接作为归类目标；工作区列表异步加载后没有校验该 ID 是否仍存在。  
   - 证据：`TaskBoardView.swift:478-490`、`TaskBoardView.swift:201-204`、`269-273`
   - 复现：选工作区 A → 删除 A → 重开看板。
   - 影响：界面可能显示“项目”但实际组织目标仍为已删除 ID，预览为空或误报无会话。
   - 最小修复：`loadSupporting()` 后若 `workspaceFilter` 不在 `workspaces`，清空为全部目录并持久化。

## 已确认正常

- preview → confirm 使用 token；未知 start 回执只按同一 token 查询，不生成新 token：`WandAPI.swift:597-614`
- active job 会复用并继续查询：`TaskBoardPickers.swift:41-46`
- 结果含 created/reused/updated/moved/unassigned/refused 等字段：`TaskBoardModels.swift` 归类结果模型。
- 看板任务区分 `titleSource`，旧服务端缺字段按 user 处理：`TaskBoardModels.swift` `WandBoardTask.init`.
- 归档会话被拆到每个任务自己的折叠区，恢复入口保留：`WorkspaceListView.swift:760-829`。
- 任务父子关系通过 `parentTaskId` 与完整任务树解析，不混淆 `workspaceTaskId`：`TaskBoardModels.swift`。

## 限制

- 未运行 XCTest、App 或真机；不能据源码判定视觉与实际点击体验通过。
- 本轮只读审查，无文件修改。

```json
{
  "result_summary": "发现一个确认的侧栏层级展示缺口：直属/未绑定会话被从工作区树投影移除，只在下方独立会话区展示；另有归类观察任务切换与持久化 workspaceFilter 失效的生命周期风险。",
  "evidence_refs": [
    "macos/Wand/WorkspaceModels.swift:702-732",
    "macos/Wand/WorkspaceListView.swift:387-415",
    "macos/Wand/TaskBoardPickers.swift:23-39,87-98",
    "macos/Wand/TaskBoardView.swift:478-490,201-204",
    "macos/Wand/WandAPI.swift:597-614",
    "macos/Wand/TaskBoardModels.swift"
  ],
  "confidence": "高（源码路径与行号已核对）；未做运行时验证",
  "disagreements": [
    "直属会话并非完全不可见：MainShell 的独立 SidebarColumn 仍会展示它们；问题是没有出现在目录层级中。"
  ],
  "next_questions": [
    "产品是否要求未绑定会话必须嵌入对应目录节点，而不是允许独立会话区展示？",
    "旧归类作业完成后触发的 onChanged 是否会覆盖用户已切换范围的最新列表？",
    "工作区删除后是否已有上层逻辑清理持久化 workspaceFilter？"
  ]
}
```
