# Chat 模式测试问题发现

## 测试执行摘要

测试时间：2026-03-23
测试范围：Chat 模式核心功能
测试场景：创建贪吃蛇游戏项目

---

## 发现的问题

### 问题 1: JSON Chat 模式流式更新可能导致消息重复渲染

**文件：** `src/process-manager.ts:450-517`

**问题描述：**
在 `processJsonEvent` 函数中，同时处理两种流式事件：
1. `assistant` 事件：包含完整的消息内容
2. `content_block_start` + `content_block_delta`：增量流式更新

当两种事件混合出现时，可能导致 `assistantBlocks` 数组被重复填充。

**复现步骤：**
1. 启动一个新的 Claude 会话（JSON chat 模式）
2. 发送一个需要长回复的请求
3. 观察流式输出过程中的消息渲染

**代码问题：**
```typescript
case "assistant": {
  // Full assistant message — contains all content blocks
  const msg = event.message;
  if (msg?.content && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      // 这里会重复添加 blocks
      assistantBlocks.push(block);
    }
  }
  break;
}
case "content_block_start": {
  // 这里也会添加 blocks
  assistantBlocks.push({ ...event.content_block });
  break;
}
```

**严重程度：** 中

**建议修复：**
在 `assistant` 事件中检查 `assistantBlocks` 是否已经有内容，如果有则跳过。

---

### 问题 2: Chat 消息渲染时缺少错误处理

**文件：** `src/web-ui.ts:4609-4634`

**问题描述：**
`renderStructuredMessage` 函数在遍历 `msg.content` 数组时没有错误处理。如果某个 content block 格式异常，会导致整个消息渲染失败。

**严重程度：** 低

**建议修复：**
添加 try-catch 包裹每个 block 的渲染。

---

### 问题 3: 输入框在 Chat 模式下可能发送空消息

**文件：** `src/web-ui.ts:3928-3948`

**问题描述：**
`sendInputFromBox` 函数在输入为空时，如果 `appendEnter` 为 true，会发送一个纯 Enter 信号。这可能导致意外的终端行为。

**严重程度：** 低

---

### 问题 4: 会话恢复时可能丢失未保存的草稿

**文件：** `src/web-ui.ts:3176-3186`

**问题描述：**
`loadSessions` 函数在合并本地和服务器会话时，只保留 output 更长的版本。但本地的草稿（drafts）可能包含未发送的输入，这些不会被保存。

**严重程度：** 中

---

### 问题 5: WebSocket 断线重连时可能丢失消息

**文件：** `src/web-ui.ts:4172-4186`

**问题描述：**
WebSocket 断线后，重连间隔为 2 秒。在这期间如果有消息发送，可能会丢失。

**严重程度：** 中

**建议修复：**
实现消息队列，在断线时暂存消息，重连后重发。

---

## 已修复的问题

### 修复 1: 聊天恢复时页面闪烁
**状态：** ✅ 已修复
**修复内容：** 移除默认入场动画，仅在增量追加时添加 `.animate-in` 类

### 修复 2: Cmd+C 复制功能被拦截
**状态：** ✅ 已修复
**修复内容：** 检测选中文本，有选中时允许浏览器默认复制行为

### 修复 3: 流式更新导致全量重渲染
**状态：** ✅ 已修复
**修复内容：** 新增 `msgCount === existingCount && hash changed` 分支，仅更新最后一条消息

### 修复 4: JSON Chat 模式消息重复渲染 (P1)
**状态：** ✅ 已修复 (2026-03-23)
**修复内容：** `assistant` 事件只在 `assistantBlocks.length === 0` 时处理

### 修复 5: 会话恢复丢失草稿 (P2)
**状态：** ✅ 已修复 (2026-03-23)
**修复内容：** 使用 localStorage 持久化草稿，键名 `wand-draft-{sessionId}`

### 修复 6: WebSocket 断线消息丢失 (P2)
**状态：** ✅ 已修复 (2026-03-23)
**修复内容：** 添加 pendingMessages 队列（上限 100 条），重连后自动 flush

### 修复 7: 消息渲染缺少错误处理 (P3)
**状态：** ✅ 已修复 (2026-03-23)
**修复内容：** renderStructuredMessage 和 renderContentBlock 添加 try-catch

### 修复 9: 空消息发送 Enter (P3)
**状态：** ✅ 已修复 (2026-03-23)
**修复内容：** sendInputFromBox 只在 value 非空时发送 Enter

### 修复 10: 会话 ID resume 机制
**状态：** ✅ 已实现 (2026-03-23)
**修复内容：**
- claudeSessionId 从 JSON 事件中提取并持久化
- UI 显示会话 ID 前 8 位
- 会话结束后显示恢复按钮（↻）
- 点击恢复按钮运行 `claude --resume <sessionId>`

---

## 待修复问题优先级

| 优先级 | 问题 | 影响范围 | 状态 |
|--------|------|----------|------|
| - | - | - | 全部已修复 ✅ |

---

## 测试建议

1. **自动化测试：** 为 Chat 模式的消息渲染添加单元测试
2. **E2E 测试：** 使用 Puppeteer 模拟完整的用户交互流程
3. **压力测试：** 模拟长时间、多轮对话场景
4. **边界测试：** 测试超长消息、特殊字符、快速连续输入等场景
