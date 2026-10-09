---
version: 1
slug: "src-web-ui-react-issues-task-board-host-tsx"
primary_target: "src/web-ui/react/issues/task-board-host.tsx"
related_targets: ["src/web-ui/react/issues/task-board-views.tsx"]
---

# Web 任务看板

Mode: Operate。扩展当前暖色 Ant 工作台；参考 dashi-taskboard 的扫描层级与列内滚动，保留任务语义、右键、拖拽与所有视图。仅 Web。

## Direction contract

THESIS: 首屏可扫读任务状态与标题，搜索、筛选和排序组成紧凑操作带。

OWN-WORLD: 使用 Wand 暖色表面、语义 token、现有 Ant 控件；列用次级底面，卡片用轻边界，状态与计数分开呈现。

STORY: 先选目录和视图，再筛选/排序，展开卡片查看正文及全部会话，菜单保留原动作。

FIRST VIEWPORT: 顶部标题与新建同行；视图一行，目录/搜索/排序一行；筛选摘要可清除；三列占剩余主区且各自滚动。窄主区控件整齐换行，状态列横向滚动并露出邻列，操作不依赖悬停。

FORM: 用户指定的参考看板结构，继承现有视觉系统；无需 concept seed。卡片展开沿用 Ant Collapse，状态列滚动时列头不离开视野；减少动态效果沿用公共 token。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
