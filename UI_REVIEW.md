# Wand Console UI 问题审查报告

> 审查时间：2026-03-22
> 审查方式：Playwright 浏览器自动化测试 + 代码审查

---

## 已修复

### 1. 消息列表闪烁问题
**严重程度：高**

**问题描述：** 每当有新的终端输出时，`renderChat()` 会用 `innerHTML` 整体替换 `#chat-output` 的内容，导致整个消息列表 DOM 重新构造。当 Claude 快速输出时（例如持续的 thinking 消息），页面会产生明显闪烁。

**根本原因：** `web-ui.ts` 第 4090 行直接使用 `chatOutput.innerHTML = ...` 替换全部内容，且 `renderChat()` 被频繁调用（WebSocket 消息推送间隔可达毫秒级，HTTP 轮询每 1.6 秒一次）。

**修复方案：**
- 增量 DOM 更新：比较前后消息数量，仅追加新消息而非全量替换
- 内容变化检测：用输出长度 + 消息数量作为变化依据，跳过无意义的重复渲染
- `requestAnimationFrame` 批量渲染：合并同一帧内的多次 `renderChat()` 调用
- 会话切换时重置渲染状态，确保新会话完整重新渲染

**文件：** `src/web-ui.ts`

---

## 待修复 / 建议改进

### 2. 语言属性错误
**严重程度：低（无障碍）**

**问题：** `<html lang="en">`，但界面几乎全部为中文内容。

**建议：** 改为 `<html lang="zh-CN">`。

---

### 3. 图标按钮缺少无障碍标签
**严重程度：低（无障碍）**

**问题：** 多个图标按钮（关闭按钮、刷新按钮等）没有 `aria-label` 或 `title` 属性，屏幕阅读器无法识别。

**示例：**
- 侧边栏关闭按钮 `×`（class: `btn btn-ghost btn-sm`）
- 文件浏览器刷新按钮 `↻`（class: `btn btn-ghost btn-icon`）
- 消息关闭按钮 `×`（class: `btn btn-ghost btn-icon`）

**建议：** 为所有图标按钮添加 `aria-label` 属性。

---

### 4. HTTPS 访问提示位置误导
**严重程度：中等（用户体验）**

**问题：** 顶栏右侧显示"请使用 HTTP 访问"警告，但配置中 `https: true` 且服务运行在 HTTPS 模式。这条提示仅在 `config.https` 为 `false` 时有意义，在 HTTPS 模式下反而造成困惑。

**位置：** `src/web-ui.ts` 渲染逻辑中根据 `config.https` 条件显示。

**建议：** 仅当 `config.https === false` 时显示该提示，或将提示改为"当前使用 HTTPS 安全连接"。

---

### 5. 会话列表无分页或虚拟滚动
**严重程度：低（性能）**

**问题：** 如果历史会话较多（> 50 个），侧边栏会话列表会渲染所有项，可能影响性能。

**建议：** 实施分页或虚拟滚动。

---

### 6. 移动端可穿戴设备提示（可选）
**严重程度：低（UX）**

**问题：** 界面为桌面端设计，在小屏幕移动设备上可能体验受限。顶栏折叠功能存在但交互不够流畅。

**建议：** 移动端侧边栏打开/关闭动画可以更平滑；考虑为移动端提供专用的底部导航。

---

## 非问题（已确认）

### 7. 新会话自动出现消息
**用户反馈：** 创建新会话后，Claude 会自动输出一系列"(thinking with high effort)"消息。

**确认结果：** **这不是前端 bug。** 这是 Claude Code 的预期行为。检查 `~/.claude/settings.json` 发现 `effortLevel` 设置为 `"high"`，Claude Code 在该模式下启动后会立即开始高强度思考，持续输出 thinking 状态信息。

如不希望自动思考，可将 `effortLevel` 改为 `"medium"` 或 `"low"`。

---

### 8. 浏览器 SSL 证书警告
**问题：** 使用 `https://localhost:8443` 访问时浏览器显示证书无效警告。

**说明：** 这是自签名证书的正常行为。如需消除警告，可使用 `mkcert` 或 `local.https` 等工具安装受信任的本地证书，或将 `config.json` 中的 `https` 改为 `false` 并使用 `http://` 访问。

---

## 代码质量备注

- `web-ui.ts` 是一个约 4500 行的巨型单文件组件，建议后续拆分为多个模块（侧边栏组件、聊天组件、设置组件等）
- `renderChatMessage` 使用字符串拼接生成 HTML（XSS 风险较低，因为输入来源为本地 PTY 输出，但仍建议使用 `textContent` 而非 `innerHTML` 注入纯文本）
- 缺少自动化测试（`package.json` 中无 test 脚本）
