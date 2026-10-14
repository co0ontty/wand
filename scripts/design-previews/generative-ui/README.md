# Wand Generative UI 视觉 Demo

用户要求只看 Demo 图片。本目录仅用于效果展示，不接入生产入口、不实现生成协议或模型调用，不修改真实会话。

## 生成图片

在仓库根目录运行：

```bash
node scripts/design-previews/generative-ui/capture.mjs
```

使用现有 esbuild 与本机 Chrome，不安装新依赖。临时 HTTP 服务仅监听回环地址、只接受 GET，截图完成后关闭；页面 CSP 禁止 connect-src。产物位于 `output/generative-ui-demo/`。

- `wand-generative-ui-demo.png`：200 日活，试算月成本 ¥2,460。
- `wand-generative-ui-adjusted.png`：实际键盘调整滑块到 500 日活，试算月成本 ¥5,700。
- `wand-generative-ui-mobile-check.png`：390px 窄屏检查；面板结果与操作可向下滚动到达，不是原生客户端截图。
- `evidence.json`：隔离浏览器检查记录。

## 来源与范围

复用当前源码的 WandUiProvider、ShellTopbar、MemoryUiAdapter、ChatMessage、WandButton、WandSelect、WandIcon、WandBrandMark、PlushAvatar，以及已安装的 Ant Slider/Statistic/Progress。只新增面板和隔离预览宿主的几何样式；左侧会话列表为静态虚构 fixture，不是另一套正式侧栏实现。参考现有截图 `output/sidebar-ux/after-desktop.png`，并与当前主题、顶栏源码核对。

图片为真实 Chrome 对此预览的截图，不是已上线功能截图，不是图像模型生成。人员对话、时间、用户规模、缓存率、成本和预算均为演示内容。单次模型调用 ¥0.04、固定服务费 ¥300、月预算 ¥3,000 都是假设，不是任何供应商的报价，也不是 Generative UI 的开发成本。

“暂存演示参数”仅切换当前页本地反馈，不保存数据库；发送和附件未接入。仅保留本地滑块、选项、重置和暂存反馈；导航不执行真实业务。更新通过 React 状态驱动，无定时演示动画。沿用主题与 reduced-motion，不改变 DESIGN.md 的系统约定。

## 已检查

- 桌面 1440×1000 的两种数据状态；200→500 的真实键盘滑块交互。
- 重置、本地暂存反馈、共享 Select 的 Escape 关闭。
- 390×900 无横向溢出，滚动后操作按钮可达。
- 浏览器运行时异常为零；生产 API 请求与模型调用均为零。
- 早期 JSX 闭合笔误及 Ant 两字按钮文本自动插空导致的截图脚本定位问题已修正，最终脚本运行通过。

这不是安装态功能验收。本轮未全量构建、部署、重启或实施后端。没有对现有整体产品做无障碍认证；窄屏只验证该预览的布局与可达性。

## 性价比判断

目前是“值得小投入验证，但不宜直接投入完整平台”。对反复调参、方案比较和信息收集，价值来自少问几轮、少等模型、减少文本到表单的手工转换；单纯将文本包装成卡片的收益较低。它不会让模型本身更聪明，也不能替代业务权限与数据校验。

建议下一步最多投入一个 3–5 人日原型周期，选 1–2 个真实高频任务验证使用频率、节省的问答轮次和完成时间，再决定是否投入报告中估算的 15–25 人日 Web MVP。尚无真实使用数据，不给出伪精确的节省金额或回本时间。
