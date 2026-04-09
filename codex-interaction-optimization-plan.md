# Codex 交互展示与处理链路优化计划

## 目标

围绕当前 `wand` 中与 Codex provider 相关的会话创建、输入发送、输出解析、聊天展示、浏览器端交互体验和异常处理链路做一轮完整优化。最终目标不是单点修补，而是形成一条稳定闭环：

1. 浏览器中可以新建 Codex 相关会话。
2. 输入后能稳定送达 PTY。
3. 输出能被正确区分为终端流和聊天语义。
4. 聊天视图不会把 Codex UI 噪音、边框字符和状态行误识别成正文。
5. 会话状态、排队、停止、结束后的输入限制和错误提示一致。
6. 真实浏览器操作下，至少能完成一次新建对话并得到正常响应。

## 当前代码现状与主要问题

### 1. Provider 能力与前端入口存在不完全对齐

现状：

- 前端已支持在新会话弹窗中选择 `Codex` provider。
- 前端会强制把 Codex 限定为 `PTY` 会话，且模式固定为 `full-access`，这一点在 UI 上已有约束。
- 后端 `ProcessManager` 中对 `codex` 会自动追加 `--dangerously-bypass-approvals-and-sandbox`。

问题：

- 目前“Codex 只能 PTY，不支持 structured”虽然有基本限制，但仍需要系统性检查整个前后端链路，确认没有遗留的 structured 假设渗透到 Codex 分支。
- 输入、消息解析、视图切换、权限按钮、恢复逻辑等位置，仍可能存在默认按 Claude 设计的分支，导致 Codex 体验不完整或提示不准确。

### 2. Codex PTY 输出已经开始做解析，但鲁棒性还不够

现状：

- `src/message-parser.ts` 已新增 `parseCodexMessages()`。
- `src/pty-text-utils.ts` 已扩展 ANSI 清洗和噪音过滤。

问题：

- 目前 Codex 聊天提取依赖 `›` 作为用户输入起点，这对理想输出有效，但真实 TUI 输出经常夹杂状态行、提示行、工作中标记、重绘残片和半帧内容。
- 现在的过滤规则仍偏静态，容易出现两类问题：
  - 把 Codex 的状态说明误当成 assistant 回复。
  - 在用户输入刚回显、assistant 尚未稳定输出时，错误切分 turn。
- `stripAnsi()` 对全屏 TUI / cursor movement 做了基础清洗，但还没有形成“面向 Codex TUI 重绘”的稳定抽象，后续需要专门针对 Codex 输出样本做增量归一化。

### 3. 前端聊天展示对 Codex 仍偏“Claude 结构化输出思维”

现状：

- 前端支持 `terminal` / `chat` 双视图。
- PTY 会话也支持 `format=chat` 的 fallback 解析。

问题：

- Codex 本质上仍是 PTY 透传，但用户需要的是“可读的对话体验”。当前 fallback chat 的准确性会直接影响体验。
- 当前聊天视图中的文案、状态、按钮能力更多围绕 Claude / structured session 设计，Codex 会话需要更明确的差异化策略：
  - 什么时候应该默认保留终端视图。
  - 什么时候 chat 视图可以作为主要阅读视图。
  - 会话信息栏中哪些按钮对 Codex 无意义，应隐藏或替换提示。

### 4. 输入链路需要做 Codex 场景专项梳理

现状：

- `/api/sessions/:id/input` 会统一进入 `processes.sendInput()`。
- `sendInput()` 会根据 `view !== "terminal"` 自动补 `\n`。
- 前端同时支持 composer 输入和 terminal interactive 模式。

问题：

- Codex 在 chat 视图下发送输入时，自动补换行本身没错，但要验证是否会和 Codex TUI 的输入回显、选择菜单、半输入态冲突。
- 当前排队逻辑、结束态拒绝输入、错误提示是否对 Codex 表意清晰，还没有经过真实浏览器链路验证。
- Codex 不支持 Wand 的权限批准接口，前端与后端虽然已有部分限制，但仍要检查界面是否出现误导性控件或错误提示。

### 5. 缺少基于真实浏览器操作的回归闭环

现状：

- 代码中已有大量 WebSocket、轮询、会话状态和 UI 更新逻辑。
- 但当前还没有将“创建 Codex 会话 -> 输入 -> 收到响应 -> 终端与聊天显示一致”作为一个真实浏览器场景固定下来。

问题：

- 仅靠读代码或本地 API 调用无法暴露前端视图切换、DOM 渲染、输入框状态、会话选择、滚动跟随、状态栏显示等一系列真实问题。
- 这轮优化必须建立真实浏览器验证路径，并把它纳入验收标准。

## 优化原则

1. 不把 Codex 硬改成结构化 runner，而是在 PTY 模式上提供更可靠的聊天提取与展示。
2. 前端行为必须显式区分 `Claude structured`、`Claude PTY`、`Codex PTY` 三类体验，不再默认共享同一套模糊假设。
3. 优先修复“输入发出去了但用户不确定是否成功”、“输出到了但聊天视图读不懂”、“会话结束了但 UI 还允许继续发”的体验断点。
4. 任何展示层优化都要以真实浏览器链路验证为准，而不是只看接口返回。
5. 不重置用户已有修改，只在当前脏工作区基础上增量推进。

## 分阶段执行计划

### 阶段一：链路盘点与样本采集

目标：把 Codex 相关路径补齐到“可以系统调试”的状态。

执行项：

1. 盘点后端与前端所有 `provider === "codex"`、`sessionKind`、`view`、`input`、`resume`、`permission` 相关分支。
2. 为 Codex PTY 输出准备真实样本采集方式：
   - 启动一个 Codex 会话。
   - 发送若干典型输入。
   - 保存原始 PTY 输出片段与解析后的 chat message 对照。
3. 明确浏览器端的关键路径：
   - 新建 Codex 会话。
   - 输入一条普通文本请求。
   - 等待响应。
   - 在 terminal/chat 间切换验证。
   - 会话结束后再次输入验证错误提示。

交付物：

- 一份 Codex 输出样本集合。
- 一份会话链路检查清单。

### 阶段二：Codex PTY 文本归一化与消息解析强化

目标：让 PTY fallback chat 对 Codex 输出更稳定。

执行项：

1. 强化 `stripAnsi()`：
   - 补足对 Codex TUI 常见 cursor movement / clear / redraw 残留的规整。
   - 控制换行折叠策略，避免把多段回复压成错误块。
2. 强化 `isNoiseLine()`：
   - 扩展对 Codex 标题栏、模型栏、目录栏、提示栏、Working 状态行、菜单项、边框残片的过滤。
   - 减少误伤正文的规则，避免“只要像提示就删掉”的过度过滤。
3. 重写或分层优化 `parseCodexMessages()`：
   - 将“识别用户输入起点”“识别 assistant 正文”“忽略临时状态行”拆开。
   - 增加对不完整 turn 的容忍度，避免前端轮询期间反复抖动。
   - 如果 assistant 尚未输出稳定正文，允许只保留 user turn，而不是拼出伪回复。
4. 为解析器补充针对 Codex 样本的最小测试或可重复验证脚本。

验收标准：

- 对真实 Codex 样本，聊天视图不再出现明显的 UI 噪音文本。
- 一轮用户输入最多解析成一个 user turn，不出现反复拆裂。
- assistant 回复能在响应逐步完成时保持稳定累积。

### 阶段三：前端 Codex 体验专项收敛

目标：让浏览器里的 Codex 会话行为一致、可预期。

执行项：

1. 梳理新会话弹窗：
   - 选中 Codex 时，显式提示“仅支持 PTY，会以 full-access 启动”。
   - 禁止 structured 的交互状态要更明确，避免用户误解为 bug。
2. 梳理会话页工具栏和输入区：
   - 隐藏对 Codex 无意义的权限批准类动作。
   - 在 Codex 会话中明确当前是 PTY 驱动、chat 为解析视图。
   - 输入框 placeholder、提示文案、发送行为按 Codex 场景校正。
3. 梳理终端视图和聊天视图切换策略：
   - PTY 原始输出仍保留 terminal 作为真源。
   - chat 视图作为阅读优化层，必要时提示“解析视图可能省略 TUI 控件文本”。
4. 梳理结束态与失败态：
   - 会话停止/失败后，输入框、发送按钮、错误提示要同步到位。
   - 对 `SESSION_NOT_RUNNING`、`SESSION_NO_PTY` 等错误给出前端可理解提示。
5. 梳理消息排队与重入：
   - 检查重复点击发送、切换会话、WebSocket 延迟时是否会造成重复提交或错位展示。

验收标准：

- 从 UI 上能够明确区分 Codex 会话和 Claude 会话。
- Codex 会话中不会出现误导性的结构化/权限操作入口。
- 输入、发送、结束态行为在浏览器里符合直觉。

### 阶段四：浏览器真实交互验证与回归

目标：建立必须通过的浏览器验收流程。

执行项：

1. 启动本地服务并通过 Playwright 打开页面。
2. 在浏览器中真实执行：
   - 新建 Codex 会话。
   - 输入一条测试消息。
   - 等待 Codex 返回内容。
   - 检查 terminal 视图有输出。
   - 切到 chat 视图检查解析结果可读。
3. 继续执行至少一个补充场景：
   - 再发一轮消息，验证多轮 turn。
   - 或停止会话后再尝试输入，验证禁止与错误提示。
4. 如有必要，保存 `output/playwright/` 下的截图或快照，作为这轮优化的验收证据。

验收标准：

- 必须在真实浏览器中成功完成一次 Codex 会话新建与响应返回。
- 输入后浏览器端能看到正常响应，而不是只有会话创建成功。
- terminal 与 chat 两个视图至少有一个是稳定可读，另一个不应出现严重错乱。

## 具体改造清单

### 后端

1. `src/pty-text-utils.ts`
   - 继续增强 ANSI/TUI 清洗。
   - 补齐 Codex 特有噪音识别规则。

2. `src/message-parser.ts`
   - 重构 Codex 解析逻辑。
   - 将解析规则从“简单按前缀切分”升级为“按 turn 与状态行分类切分”。

3. `src/process-manager.ts`
   - 审查 Codex provider 在 `start()`、`sendInput()`、停止态、恢复逻辑中的一致性。
   - 确认错误码与状态落盘对前端足够友好。

4. `src/server-session-routes.ts`
   - 审查 Codex 与 structured session 的接口边界。
   - 统一错误返回语义，避免前端难以判断是 provider 限制还是会话已结束。

### 前端

1. `src/web-ui/content/scripts.js`
   - 新会话弹窗中明确 Codex 的模式限制和能力边界。
   - 优化 Codex 会话的输入提示、视图切换和结束态。
   - 校正 chat fallback 展示说明。

2. `src/web-ui/content/styles.css`
   - 为 Codex 会话补充必要的视觉标识和状态样式。
   - 确保聊天视图中解析块的可读性，不和终端视图风格混淆。

## 风险点

1. Codex TUI 输出可能随版本变化，解析规则不能写得过于脆弱。
2. 过度过滤噪音会误删 assistant 正文，尤其是短句、列表项、命令输出摘要。
3. 前端如果把 chat 视图当作单一真相源，可能掩盖 PTY 真正状态，因此 terminal 必须保留为可信底层视图。
4. 真实浏览器验证时，若本机 `codex` 命令或依赖环境异常，需要把“产品问题”和“本机工具环境问题”分开记录。

## 建议执行顺序

1. 先完成 Codex 输出样本采集。
2. 再改 `pty-text-utils.ts` 和 `message-parser.ts`。
3. 然后收敛前端 UI 行为与错误提示。
4. 最后用浏览器做端到端验证，并基于真实现象继续微调。

## 完成定义

当以下条件同时满足时，视为本轮工作完成：

1. 浏览器中可以新建 Codex 会话。
2. 发送输入后能收到正常响应。
3. 聊天视图不再被明显 TUI 噪音污染。
4. 会话停止或结束后，输入行为和错误提示正确。
5. 至少完成一次基于真实浏览器的验收并保留必要证据。

## 当前执行进度

截至本轮结束，已经完成的优化：

1. Codex PTY fallback chat 解析已重构为面向真实 PTY transcript 的规则，不再只依赖最终屏幕缓冲。
2. `server-session-routes.ts` 的 `format=chat` 已优先读取会话 `pty-output.log` transcript，再做 Codex 解析，避免 assistant 回复因 TUI 重绘从最终屏幕消失。
3. 前端 `scripts.js` 中已增加 Codex 专用解析分支，和后端规则对齐。
4. PTY 终端刷新与滚动行为已做收敛：
   - 减少不必要的全量 redraw。
   - 修复手动滚动后被自动拉回底部的问题。
   - 修复终端 resize handle 绑定到错误 DOM 节点的问题。
5. Codex 输入发送链路已做专项调整：
   - 发送时保留 `terminal` 视图上下文，避免视图切换导致 delayed Enter 发错视图。
   - 增加 Codex prompt readiness 等待逻辑，避免首条消息过早打到启动 splash。
6. Codex/PTY 浏览器验收脚本已补充，能自动创建会话、发送输入、切换视图并检查 PTY 滚动状态。
7. 本地后台服务启动方式已固定为后台持久进程 + 日志文件：
   - 服务地址：`http://127.0.0.1:3212`
   - 日志文件：`/tmp/wand-logs/wand-e2e.log`

## 当前剩余阻断项

当前还未完全通过的点不在基础解析能力，而在浏览器验证环境仍有旧会话残留输入队列污染：

1. 页面初始化后，旧 PTY 会话的内存 `pendingMessages` / reconnect flush 仍会尝试向已停止的旧 session 补发输入。
2. 这些旧 session 的重放请求会污染浏览器控制台和当前验证流程，导致新的 Codex 会话验证被干扰。
3. 目前已经确认：
   - 新脚本内容已正确下发到页面。
   - 前端运行时缺失的 `isNoiseLine` / `stripAnsi` helper 已补齐。
   - 真实新建的 Codex 会话仍可创建成功。
4. 下一轮应优先继续收敛：
   - 页面初始化后的旧 `pendingMessages` 清理逻辑。
   - reconnect 后对“已停止 / 非当前选中 session”的 pending flush 防抖或丢弃策略。
   - 验证脚本中的会话环境清理，确保只验证当前新建 session。

## 已验证事实

1. `npm run check` 在上述改动后可通过。
2. 后台服务已多次按后台模式成功启动并写日志。
3. 浏览器中可以稳定打开页面、登录并拉起新会话弹窗。
4. 新建 Codex PTY 会话在浏览器中可成功创建。
5. 样本级 Codex transcript 解析已能从真实 `pty-output.log` 中提取：
   - user: `reply with exactly: codex-ok`
   - assistant: `codex-ok`
6. 当前浏览器端剩余问题已收敛到“旧 session 待发消息重放污染验证环境”，而不是基础 PTY 解析或视图渲染全面失效。
