---
version: alpha
name: Wand
description: Local AI task workspace with a warm paper surface and restrained terracotta actions
colors:
  background: "#faf7f2"
  surface: "#fffdfa"
  muted: "#f2ede5"
  foreground: "#1f1b18"
  secondary: "#57504a"
  border: "#e5ded3"
  primary: "#b8562f"
  danger: "#b24f45"
  success: "#4f7a58"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif'
  mono:
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, "Consolas", monospace'
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
omitted:
  - section: spacing
    reason: "Existing feature layout owns geometry; no independent global spacing scale is introduced."
  - section: components
    reason: "Component states are owned by react/ui and documented below, not generated from this file."
---

# Wand 产品设计规范

## Overview

Wand 是本地 AI 工具工作台，服务需要同时管理任务、目录、终端和 AI 执行的使用者。
主要工作是开始一项任务、跟进执行、确认结果。默认中文产品界面，保留 provider、模型、路径和代码原文；没有日本市场或监管业务的既定需求。

方向由用户指定的登录页延伸：像一张有秩序的工作桌。暖纸色承载任务，赤陶色标记下一步操作，深色终端保留运行现场。
标志性的表达是同一个 Wand 折线标记和克制的状态刻度，而非给每个模块设计一套卡片皮肤。
这是高频使用的工具界面，不使用营销大标题、装饰性指标、满屏空卡片、玻璃效果或不同模块各自的渐变。

Token ownership 使用 Model B：`src/web-ui/content/styles.css` 的 `:root` 为唯一运行时数值来源。
本文件镜像认可值；`src/web-ui/css/appica.css` 桥接 Appica，`react/styles/base.ts` 统一控件，feature 只负责业务布局。
不得把本文件另行生成一套互相覆盖的 CSS。

## Colors

background 对应 `--bg-primary`，surface 对应 `--bg-elevated`，muted 对应 `--bg-secondary`；
foreground/secondary/border 对应 `--text-primary` / `--text-secondary` / `--border-subtle`。
primary 对应 `--accent-solid`，danger/success 对应同名语义变量。
页面底、内容表面、浮层最多三级；状态配合文字和图标，不依赖颜色识别。
认证后工作台采用浅色；终端使用独立深色语义，登录既有系统深色分支保留。

## Typography

采用系统无衬线保障中文和离线启动，任务页标题 24px（窄屏 20px），正文与表单 14px，任务名 13–14px，辅助信息 12px。
路径、命令和技术标识用 `--font-mono`。标题以字重和间距建立层级，不引入需要下载的装饰字体。
长标题允许换行或提供完整 title；关键操作不能被截断。

## Layout

桌面侧栏沿用 296px / 56px 收起轨。页面包含标题与主操作、工具栏、结果摘要、独立滚动内容。
看板列以细状态分隔线区分，卡片直接放在页面上；空列提供短提示，不伸展成整屏占位卡片。
聊天正文默认铺满；宽屏（≥1280px）时独立会话顶栏右侧与任务标签栏同一位置各有一个「铺满 / 居中」
分段开关，居中态下正文、工具卡片与输入栏共用 940px 阅读列（`--chat-column-width`）。
该偏好属于设备本地（localStorage `wand-chat-width`），窄屏不显示开关也不收窄。
640px 以下工具栏换行，搜索独占一行，任务列表纵向显示；设置使用其既有 760px 断点。
页面外壳已有视口滚动契约；每个长表单由自身内容区滚动，操作栏始终可达。

## Elevation & Depth

静态任务卡片使用细边框；菜单与对话框使用统一浮层阴影。不要卡片套卡片。
悬停用背景或描边反馈，主界面不依赖持续动画。遵循 reduced-motion，避免为了表现层级移动按钮。
全局滚动条采用 CSS token，保留 forced-colors 的系统配色，滚动区域无须单独声明主题类。

## Shapes

控件 8px，卡片/菜单 12px，对话框 16px。状态圆点与计数可用圆形，普通操作不一律胶囊化。
图标统一使用 WandIcon/provider 既有标记，禁止增加另一套图标库。

## Components

按钮、下拉、弹窗、通知经 `react/ui` 使用 Appica；同类控件共享 hover、focus、disabled 和 busy。
搜索统一使用 WandSearchField：常显输入、非空清除、清除后恢复焦点、中文输入法期间不触发远程检索。
目录筛选复用 WandSelect 的可搜索变体，开窗宽度/碰撞/键盘由公共组件负责。
看板视图、详情与设置需保留导航上下文；详见 UX-CONTRACT.md。
新建任务分为立即打开工作区和记录待办两个业务入口，必须说明创建后是否执行。

## Do's and Don'ts

- 延续登录页的色彩与品牌，不把统一理解为重写终端。
- 提供清晰页面标题、可见搜索和有恢复动作的空结果。
- 异步操作保留已有内容和输入；只有服务端成功后才宣告成功。
- 不通过多层背景、巨大空占位、微小字号或不可发现的图标堆叠制造复杂感。
- 修改已存在的 CSS 规则，保留一条 token 到控件的映射链路。
