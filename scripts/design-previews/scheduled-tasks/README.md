# 全局日历设计预览 · 月／周横条与执行热力图

独立交互设计稿，**没有接入正式 Web/Mac 页面**。任务、员工、执行记录、时钟均为明确示例；不调用真实计划、API 或 AI 模型。前三版源码/HTML/截图/验证分别保留在 `output/design-previews/scheduled-tasks/revision-{1,2,3}/`。

## 查看

- 列表：`http://127.0.0.1:8797/`
- 全局月日历：`http://127.0.0.1:8797/?view=calendar`
- 全局周时间轴：`http://127.0.0.1:8797/?view=calendar&range=week`
- 同刻／部分重叠／密集日程核对：`http://127.0.0.1:8798/`，规则、来源与语义边界见 [`OVERLAP-DESIGN.md`](OVERLAP-DESIGN.md)。独立启动 `node scripts/design-previews/scheduled-tasks/serve-overlap.mjs`，验证 `node scripts/design-previews/scheduled-tasks/verify-overlap.mjs`。
- 原 `layout=calendar` 链接仍兼容。
- 离线：`output/design-previews/scheduled-tasks/Wand-scheduled-tasks-preview.html`，同样支持以上查询参数。

```sh
node scripts/design-previews/scheduled-tasks/serve.mjs        # 仅监听回环8797
node scripts/design-previews/scheduled-tasks/serve.mjs --build
node node_modules/typescript/bin/tsc --noEmit -p scripts/design-previews/scheduled-tasks/tsconfig.json
node --test --import tsx scripts/design-previews/scheduled-tasks/{agenda,execution,calendar}-model.test.ts
node scripts/design-previews/scheduled-tasks/verify.mjs
node scripts/design-previews/scheduled-tasks/verify-calendar.mjs
```

最终命令使用 `.nvmrc` 的 Node24.21.0。两个浏览器验证顺序运行，避免同时写同一预览产物；测试清理仅关闭自己的临时静态服务器连接。

## 全局范围与入口

日历是工作台主导航的独立“日历”入口，不属于员工详情。页面与浏览器标题明确为“全局日历”，范围为“全部员工”；进入时清空列表遗留的搜索/状态，不继承某个员工上下文。窄屏由页头“工作台主视图”入口直达，同样不需要打开员工资料。

默认混排当前工作台全部有权任务与已提供执行，不按员工分栏、分组或设独立页面。头像只标识单条事件的实际执行/计划归属，颜色表示状态。全局页移除单员工下一任务大卡，把空间留给日历；原定时列表仍保留顶部下一项完整详情。点击横条看的是任务/执行快照，不是员工资料。通用关键词搜索仍可用，但不是员工专属日历或独立员工过滤器；正式接入也不意味着扩大跨账号/私聊/知识权限。

## 用户本轮要求与实现

1. **执行记录默认收起，只看最新一次**：任务原位展开后只显示最新触发的时间、状态、当次目录及会话入口。点击“执行情况”才出现近12周的 GitHub 式日期方格；不是默认堆历史列表。
2. **热力图显示执行事实**：按实际 `claimedAt` 日期聚合，完成、失败、运行/等待、未知、跳过、同日混合分别表达。颜色深浅只取已提供的当日次数；空白表示“未提供记录”，不等于没执行或成功。点一天查看当日记录，方向键/回车可操作，Escape先收热力图再收外层。
3. **按附件设计日历主体**：月格直接显示“头像＋时间＋内容＋状态”的横条，不用圆点或默认下方日程列表替代。支持周视图，横条按日期与确切时刻定位；条高固定用于阅读，**不代表执行时长**。同位近时刻用横向分栏避免遮盖。
4. **实际记录与未来计划分开**：实色条是已提供执行，虚线条是预计安排；暂停/取消不生成未来条，已有执行仍保留。未来重复计划复用 `nextScheduledTime()`，不把单个 nextRunAt 当成全部日程，也不按今天的规则回填过去。已知执行压掉同次重复预测，跨日补跑按实际触发日显示。
5. **点击横条原位看详情**：复用公共 WandPopover/Portal。旧执行展示所选那次快照，预计条默认展示最近一次记录；完整执行情况继续折叠。浮层内点击/键盘只影响所属浮层，不穿透触发底层日期选择；外点、Escape、编辑等关闭路径仍可用。

## 组件与布局

- Ant Calendar 持有月日期矩阵，`fullCellRender` 只定制日期格与横条；月/周切换沿公共 StretchTabs。Ant Calendar 没有周时间轴 API，周视图仅补时间几何，继续使用相同 CalendarEntry 与 WandButton。
- 日历横条通过公共 PlushAvatar 的原生22px参数显示身份；其他照片/旧头像路径复用现有 avatarFaceParts/Ant Avatar。没有改生产头像、重画另一套模型或添加依赖。
- 热力图没有现成 Ant primitive，日期格复用 WandButton/Tooltip 与主题语义色；不引入图表库。日历详情、日期选择、焦点和弹层关闭沿原生组件/公共 owner。
- 定时列表保留两行任务与顶部下一项完整内容；全局日历直接铺日历画布。全局主视图、月/周局部交叉淡入淡出，退出层在动效完成后 `hidden`/`inert`，不让隐藏画布持续渲染。减动效即时切换。
- 窄屏保持横条可读宽度，让日历画布自己横向滚动并提示，不挤成点点；文档本身没有横向溢出。粗指针日期/横条保留44px触控。
- 示例有50条已提供历史、同日多次、失败/未知/跳过与改期；并不宣称这50条覆盖了12周全部执行，也不虚构完成率或真实回复。

原 taste-skill 的应用/重设计分支继续适用，项目系统字体、五主题、Wand组件、Portal和motion规则优先；不复制参考图中的账号、会议内容、水印、系统栏、订阅或农历等无关信息。

## 验证与证据

`verification.json` 为列表/热力图验证，`calendar-verification.json` 为月/周验证；另有25项纯模型测试，覆盖日历时区、DST、跨年、暂停/取消、历史/预测去重、确切分钟与同位分栏。最新截图包括 `scheduled-calendar-month.png`、`scheduled-calendar-week.png`、`scheduled-calendar-record.png`、各窄屏日历、`scheduled-expanded.png`、`scheduled-heatmap.png` 与日钻取。

主流程使用真实 WebGL；几何中间帧另用支持的 SVG 回退浏览器隔离 GPU 编译/竞争，仍保留完整开合、真实中间帧断言和原 motion token，不调整时长换通过。浏览器驱动回车包含完整原生 Return 文本，不为测试重写按钮默认行为。

## 剩余（待安排）

原方案已获准开始接入，Web真实只读接口与页面的代码及隔离回归进行中，本会话未做安装服务激活或最终核对；不能将本目录的设计验证当生产交付。真实幂等/请求代次、409/未知回执、失败恢复、存储和精确会话导航仍归生产 owner。新增密集重叠策略先保留在独立核对稿；Mac须同步落地并单独构建，当前无原生/Beta/设备/发布。真实大数据、设备/VoiceOver、Safari和高负载GPU帧率未作认证，不把隔离Chrome设计稿说成生产双端交付。历史覆盖范围在正式接入时仍须真实分页/元数据支持，不能从空白猜结果。
