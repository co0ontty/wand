# Chat 模式修复计划

## 评审结果

**评审人：** Team Lead
**评审时间：** 2026-03-23
**评审结论：** 通过，按优先级执行修复

---

## 修复任务分配

### 任务 1：修复 JSON Chat 模式消息重复渲染（P1）

**负责人：** @tester
**预计工时：** 2 小时
**截止日期：** 2026-03-23

**问题描述：**
在 `process-manager.ts` 的 `processJsonEvent` 函数中，`assistant` 事件和 `content_block_start` 事件会同时添加 blocks 到 `assistantBlocks` 数组，导致消息重复。

**修复方案：**
```typescript
case "assistant": {
  const msg = event.message;
  // 如果已经有 blocks（来自流式更新），跳过完整消息
  if (msg?.content && Array.isArray(msg.content) && assistantBlocks.length === 0) {
    for (const block of msg.content) {
      if (block && typeof block === "object" && "type" in block) {
        assistantBlocks.push(block);
        this.appendBlockToOutput(record, block);
      }
    }
  }
  break;
}
```

**验收标准：**
- [ ] 流式输出时消息不重复
- [ ] 完整消息和增量消息只处理一次
- [ ] 单元测试通过

---

### 任务 2：实现 WebSocket 断线消息队列（P2）

**负责人：** @tester
**预计工时：** 4 小时
**截止日期：** 2026-03-24

**问题描述：**
WebSocket 断线期间发送的消息会丢失。

**修复方案：**
1. 在 `state` 中添加 `pendingMessages: string[]` 队列
2. 修改 `postInput` 函数，在 WebSocket 断开时将消息加入队列
3. WebSocket 重连后，发送队列中的消息
4. 添加超时机制，避免队列无限增长

**验收标准：**
- [ ] 断线期间消息不丢失
- [ ] 重连后消息按序发送
- [ ] 队列有上限（如 100 条）

---

### 任务 3：修复会话恢复丢失草稿（P2）

**负责人：** @tester
**预计工时：** 1 小时
**截止日期：** 2026-03-23

**问题描述：**
`loadSessions` 函数在合并本地和服务器会话时，本地的草稿（drafts）可能包含未发送的输入，这些不会被保存。

**修复方案：**
在 `state.drafts` 中持久化草稿，即使会话被覆盖也保留草稿内容。

**验收标准：**
- [ ] 会话恢复后草稿保留
- [ ] 刷新页面后草稿保留（考虑 localStorage）

---

### 任务 4：添加消息渲染错误处理（P3）

**负责人：** @tester
**预计工时：** 1 小时
**截止日期：** 2026-03-24

**修复方案：**
在 `renderContentBlock` 函数中添加 try-catch：

```typescript
function renderContentBlock(block, role) {
  try {
    if (!block || !block.type) return "";
    switch (block.type) {
      // ...
    }
  } catch (e) {
    return '<div class="render-error">消息渲染失败</div>';
  }
}
```

---

### 任务 5：修复空消息发送 Enter（P3）

**负责人：** @tester
**预计工时：** 0.5 小时
**截止日期：** 2026-03-24

**修复方案：**
在 `sendInputFromBox` 函数中，当输入为空且 `appendEnter` 为 true 时，不发送任何内容。

---

## 执行顺序

1. 任务 1（P1）- 立即执行
2. 任务 3（P2）- 紧接着执行
3. 任务 2（P2）- 需要更多测试
4. 任务 4（P3）- 有时间再执行
5. 任务 5（P3）- 有时间再执行

---

## 测试计划

每个修复完成后需要：
1. 运行 `npm run check` 类型检查
2. 运行 `npm run build` 构建
3. 手动测试修复场景
4. 更新 TEST_FINDINGS.md 状态

---

## 进度追踪

| 任务 | 状态 | 完成日期 |
|------|------|----------|
| 任务 1 | 进行中 | - |
| 任务 2 | 待开始 | - |
| 任务 3 | 待开始 | - |
| 任务 4 | 待开始 | - |
| 任务 5 | 待开始 | - |
