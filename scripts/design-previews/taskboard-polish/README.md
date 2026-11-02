# 任务面板：参考 dashi 后的紧凑布局预览

参考项目：https://github.com/chuspeeism/dashi-taskboard 。本机既有 demo 为 `output/dashi-taskboard/`，本轮恢复在 `http://127.0.0.1:47823`，通过 ego-browser 实际查看概览和看板。

本预览直接使用当前源码中的 `TaskBoardHost`、看板、概览、列表、甘特、Drawer 与公共 Ant/Wand 控件；使用固定 DEMO 数据，不是生产任务或验收结论。所有请求均由预览中的内存适配器截断，写入返回拒绝；CSP 禁止联网，主题与看板偏好仅保存在预览内存，不修改用户偏好。

## 已采用的取舍

- 卡片只显示子任务数量，取消卡片内的子任务内容与展开入口；完整子任务仍在任务详情中查看。
- 卡片分为编号/优先级、标题、必要属性、执行者/计数。已选工作区不在每卡重复，默认迭代与零评论隐藏；规划阶段不重复标注未验收。
- 执行者显示一位身份及其真实阶段，其余人数通过公共 Popover 查看。完整会话在原位展开区可打开、移动和拖拽。
- 工具栏将筛选、显示和归档放在同一动作组，窄宽度按职责换行。
- 概览交付行保留独立的摘要区与固定宽度的“查看交付”，直接展开现有 Drawer 的交付验收区。
- Mac 使用相同信息取舍，以原生控件和布局适配宽度，保留旧系统回退。

## 构建与查看

```sh
node scripts/design-previews/taskboard-polish/build.mjs
```

输出：`output/taskboard-dashi-polish/index.html`，可离线打开，或由已安装 Wand 的 `/api/local-file/` 入口预览。使用 `?view=taskboard&boardView=board&directory=preview-workspace` 可查看工作区筛选下的精简卡片。

## 验证与范围

- `board-checks.json`：9 项看板验证。阶段筛选、Escape、标题展开前后几何、完整执行者、四个会话拖拽入口；1440/1024/640/390/320px 无页面横向溢出。
- `view-checks.json`：11 项视图验证。交付直达验收、详情/评论正常渲染、1440/390/320px 交付按钮宽度、四视图可达、重复信息收敛、深色与减动效。
- 截图与结果均在 `output/taskboard-dashi-polish/`。预览适配器初次错误返回评论数组导致详情崩溃，已按真实分页 DTO 修正并重新验证；不是修改生产接口。
- Web 执行 `npm run check`、`npm run build` 与 bundle 预算检查；原生 macOS 已构建 Universal Binary，Beta ZIP/DMG 和更新接口的大小/SHA 结果见 `macos-beta.json`、`macos-update-check.json`。
- macOS Beta 仅放入本地分发目录，没有安装或启动。HTTP 下载 GET 会清理历史构建包的问题已有 TASK-360，本轮只核对更新元数据及本地分发文件，不以此冒充实际 HTTP 下载流验证。
- 服务没有重启，运行中的 Web 尚未替换；这些结果证明当前源码与真实组件预览，不冒充生产功能验收或原生界面验收。

本轮保留主仓和 macOS 原有未提交改动，未提交、推送或打 tag。
