# Claude PTY 样本与回放计划

这份文档对应任务拆解里的 A2。目标不是马上补齐完整测试框架，而是先把 **样本来源、分类、预期产物、回放接口** 固化下来，避免后续改 `ClaudePtyBridge`、`message-parser`、`ProcessManager` 时继续靠手工盯终端。

---

## 1. 为什么现在先做这个

当前 Claude 会话链路同时依赖三层输出语义：

1. **原始 PTY 输出**：terminal 视图事实源
2. **`ConversationTurn[]`**：Claude chat 视图主模型
3. **`ChatMessage[]` fallback**：`/api/sessions/:id?format=chat` 的兜底解析结果

这些表示都来自同一份 PTY 文本，但解析路径不同：

- `src/process-manager.ts`
  - 挂接 PTY `onData`
  - 调 `bridge.processChunk(chunk)`
  - 根据 bridge event 更新 `record.messages`、`pendingEscalation`、`currentTask` 等
- `src/claude-pty-bridge.ts`
  - 检测 session id
  - 检测 permission prompt
  - 输出 `output.raw` / `output.chat` / `chat.turn`
- `src/message-parser.ts`
  - 在结构化消息缺席时，从 full output 派生简单 chat message

这意味着一旦 Claude CLI 输出细节变化，现在最容易出问题的是：

- 权限 prompt 误判 / 漏判
- `ConversationTurn[]` 边界漂移
- fallback parser 和 bridge 结果不一致
- resume 相关 session id 绑定错误

所以样本集的价值不是“有测试更好”，而是把 **兼容性证据** 固定下来。

---

## 2. 样本覆盖范围

至少覆盖下面 5 类。

### 2.1 普通问答

**目标**
- 验证 user -> assistant 的基本 turn 边界
- 验证纯文本回复不会被误识别成工具/权限

**必须观察的结果**
- raw output 连续可显示
- `ConversationTurn[]` 至少有 1 个 user + 1 个 assistant
- fallback `ChatMessage[]` 也能得到合理对话
- 不产生 `pendingEscalation`
- 不产生 `currentTask`

### 2.2 工具调用

**目标**
- 验证 tool_use / tool_result 相关 turn 是否被 bridge 正确维护
- 验证 UI task 标题更新不会污染消息结构

**必须观察的结果**
- raw output 正常流式增长
- `chat.turn` 能形成包含 tool block 的 assistant turn
- `currentTask` 会更新并在完成后清空或切换
- fallback parser 即使无法还原 tool block，也不能把工具日志误判成用户输入

### 2.3 权限请求

**目标**
- 验证权限 prompt 检测边界
- 验证 approve / deny / approve_turn 后的 blocked 状态清理

**必须观察的结果**
- bridge 发出 `permission.prompt`
- `ProcessManager` 写入 `pendingEscalation`
- UI 能收到 `status.permissionRequest`
- 解决后 `permissionBlocked=false`
- 同一份文本不能因为宽泛 regex 导致普通自然语言被误判

### 2.4 resume

**目标**
- 验证 Claude session id 捕获与恢复资格判定
- 验证真实对话出现前后，session id 是否被过早绑定

**必须观察的结果**
- 能捕获 `claudeSessionId`
- 只有在满足最小对话信号后才允许绑定/展示 resume
- `ProcessManager` 的 `shouldAllowResume()` / UI resume 展示条件与样本预期一致

### 2.5 异常退出

**目标**
- 验证 bridge / ProcessManager 在非正常结束时能正确收尾
- 避免遗留 blocked/task/responding 状态

**必须观察的结果**
- `onExit()` 后能 finalize 当前响应
- permission blocked 被清空
- task debounce timer 被清掉
- UI 最终收到 ended 状态并能回落到静态快照

---

## 3. 样本文件格式建议

建议在后续实现时新增独立目录，例如：

```text
docs/optimization-plan/samples/
  README.md
  normal-chat-001.raw.txt
  tool-use-001.raw.txt
  permission-001.raw.txt
  resume-001.raw.txt
  exit-error-001.raw.txt
  manifest.json
```

其中：

### 3.1 `*.raw.txt`
保存**尽量原始**的 PTY 输出片段：
- 保留 ANSI / 光标控制字符原貌
- 不手工“清洗”成阅读友好文本
- 如果必须脱敏，只替换敏感路径、token、用户名，不改控制流结构

### 3.2 `manifest.json`
每个样本一条元信息，建议字段：

```json
[
  {
    "id": "permission-001",
    "category": "permission",
    "source": "real-session",
    "command": "claude",
    "notes": "工具调用前出现文件写入授权",
    "expect": {
      "hasConversationTurns": true,
      "hasPermissionPrompt": true,
      "hasTask": false,
      "shouldCaptureSessionId": false
    }
  }
]
```

关键原则：
- **样本文本**保存原始事实
- **manifest** 保存期望与来源说明
- 不把预期写死在样本文本注释里，避免混淆输入与断言

---

## 4. 回放时需要同时验证什么

同一份样本至少要能驱动 3 种验证视角。

### 4.1 Bridge 视角

对 `ClaudePtyBridge.processChunk()` 分块喂入样本，观察：

- 发出的事件序列
- 最终 `getMessages()`
- 最终 `getClaudeSessionId()`
- 最终 `isPermissionBlocked()`
- 最终 `getCurrentTask()`

这层主要验证：
- 语义事件有没有漂
- chunk 边界变化是否影响结果
- detection window 是否过宽/过窄

### 4.2 Fallback parser 视角

对完整 raw output 调 `parseMessages(output)`，观察：

- 是否得到合理的 `ChatMessage[]`
- 是否把工具日志/权限文本错误识别为正常对话

这层主要验证：
- fallback 是否仍可作为兼容兜底
- 其适用范围是否应该继续收缩

### 4.3 ProcessManager / resume policy 视角

对样本对应的结构化 messages 和 session id 条件，验证：

- `shouldBindClaudeSessionId()`
- `shouldAllowResume()`
- `shouldDisplayResumeAction()`
- `shouldBackfillFromStoredHistory()`

这层主要验证：
- resume 相关判定不再凭感觉
- UI / storage / runtime 对“可恢复”的认知一致

---

## 5. 推荐的最小回放接口

第一版不用上完整测试框架，也不要先做复杂 fixture runner。最低可行做法：

1. 新增一个内部脚本或轻量测试入口
2. 读取样本文本
3. 按固定 chunk size 或真实 chunk 序列回放给 `ClaudePtyBridge`
4. 输出结果摘要或断言失败信息

建议后续优先支持两种喂入模式：

### 5.1 整块喂入
- 快速验证“文本总体是否还能解析”
- 适合普通问答、异常退出

### 5.2 小块喂入
- 每次 16~128 字符，模拟真实 PTY streaming
- 适合权限检测、task 发现、session id 捕获
- 能暴露 rolling window / partial token 边界问题

如果两种模式结果不一致，优先视为 bridge 边界存在风险。

---

## 6. 样本来源规则

样本最好来自真实运行，而不是手写拼接。建议来源优先级：

1. **真实 Claude 会话 PTY 日志**（最佳）
2. 真实日志脱敏后的片段
3. 仅在无法获取真实样本时，才允许手工构造最小片段

### 脱敏规则
- 路径替换成 `/workspace/demo` 之类稳定占位符
- 用户名替换成 `user`
- token / 密钥全部删掉
- 不要改行序、提示词结构、控制字符分布

如果为了“可读性”重写了原始文本，这份样本就不再适合用来做兼容性回放。

---

## 7. 每类样本的预期断言

| 类别 | raw output | `ConversationTurn[]` | fallback `ChatMessage[]` | permission | session id | task |
|---|---|---|---|---|---|---|
| 普通问答 | 必须保真 | 必须有 user/assistant | 应有合理问答 | 无 | 可无 | 无 |
| 工具调用 | 必须保真 | 应保留 tool block | 可弱化但不能误判 | 视样本而定 | 可能有 | 应可见 |
| 权限请求 | 必须保真 | 可有或无新增 turn | 不应把 prompt 当正常回复 | 必须命中 | 可无 | 可无 |
| resume | 必须保真 | 必须能支撑最小对话判定 | 可作为辅助 | 无 | 必须命中 | 可无 |
| 异常退出 | 必须保真 | 应完成收尾 | 至少不崩 | 结束后应清空 | 保持已有结果 | 结束后应清空 |

---

## 8. 先不要做的事

当前阶段不建议一上来：

- 直接为所有样本写完整单测矩阵
- 把样本系统和 CI 强绑定
- 同时重写 fallback parser 与 bridge
- 先发明新的消息模型再收样本

顺序应当是：

1. 先定样本格式
2. 先收真实样本
3. 先能回放并看结果
4. 再用样本驱动 B1/B2 的收敛

---

## 9. Phase B 将直接依赖这份文档的点

后续进入 B1 / B2 时，这份样本集会直接用于验证：

- `src/process-manager.ts:60` 附近的 `PROMPT_PATTERNS` 是否过宽
- `src/claude-pty-bridge.ts:198` 附近 `detectPermission()` 的窗口检测是否稳
- `src/claude-pty-bridge.ts:404` 附近 `isRealChatInput()` 对单字符输入过滤是否会误伤
- `src/server.ts:738` 的 fallback `parseMessages(snapshot.output)` 是否仍只在兼容场景触发
- `src/web-ui/content/scripts.js:7119` 附近 chat 渲染 fallback 是否会把旧 output 覆盖结构化消息

---

## 10. 完成定义

A2 真正完成时，至少要满足：

1. 仓库里已有明确样本目录与命名规则
2. 每类样本都有来源说明与预期结果
3. 至少存在一个可执行的最小回放入口
4. 能同时观察 bridge、fallback parser、resume policy 三类结果
5. 后续修改 parser / permission / resume 逻辑时，不需要再靠人工回忆“之前大概是什么样”
