# Wand PTY 终端显示链路侦察报告

## 1. 链路图

```
node-pty (socket fd)
    ↓
ProcessManager.start() → pty.spawn()
    ↓ (onData event)
    ├→ rec.ptyBridge.processChunk() [Claude 模式]
    │  └→ ClaudePtyBridge (src/claude-pty-bridge.ts:216)
    │     ├→ rawOutput 累积 (line 221)
    │     ├→ emit "output.raw" (line 225)
    │     ├→ detectPermission (line 236)
    │     └→ parseChatResponse (line 241)
    │
    └→ rec.output 累积 [非Claude/deprecated] (line 944)
       
    ProcessManager → emitEvent(output)
        ↓ (WebSocket broadcast)
        
WsBroadcastManager.emitEvent (src/ws-broadcast.ts:101)
    ├→ OUTPUT_DEBOUNCE_MS (16ms) 合并 chunks (line 119-123)
    └→ broadcast() → ws.send() (line 182)

浏览器 (WebSocket)
    ↓ (接收 output 事件)
    
syncTerminalBuffer() (src/web-ui/content/scripts.js:5321)
    ├→ normalizeTerminalOutput()
    ├→ wandTerminalWrite() [ANSI SGR 过滤] (line 5216)
    │  └→ widePadAnsi() [CJK 宽度对齐] (line 5219)
    │     └→ state.terminal.write()
    │
    └→ maybeScheduleResyncForChunk() [检测原地重绘] (line 5314)
        └→ IN_PLACE_REDRAW_RE 检测 (line 5313)
           
state.terminal.write() 
    ↓ (WTermLib.WTerm, 打包自 @wterm/dom)
    
wterm-entry.js WTerm.write (line 7)
    ├→ SGR_RE 过滤 (line 4: 剥除 SGR 4/24 underline)
    └→ super.write(data) → BaseWTerm.write()
        └→ WASM grid 更新 + DOM render

softResyncTerminal() (line 5263)
    ├→ resetTerminal() (line 5265)
    │  └→ state.terminal.write("\x1bc") [ANSI RIS 重置] (line 5256)
    └→ wandTerminalWrite(state.terminal, terminalOutput) [replay]
        └→ ensureTerminalFit() (line 5275)
```

## 2. 补丁清单

| 位置 | 做什么 | 原因 | 仍有效 | @wterm/dom 替代 | 删除风险 |
|------|--------|------|--------|-----------------|----------|
| **scripts/wterm-entry.js:4-13** | SGR_RE 剥除参数 4/24 (underline) | 消除下划线样式渲染（原因未注明，推测是样式冲突） | 是 | 否（write() 无内置 SGR 处理）| **高** - 影响全局输出样式 |
| **scripts/wterm-entry.js:18-23** | reset() 改写 | 官方 WTerm 无 reset()，早期 no-op | 是 | 否（无 reset，但有 init/setup） | **中** - 可用 bridge.init() + renderer.setup() 替换 |
| **scripts/wterm-entry.js:25-42** | remeasure() 改写 | 官方无 remeasure，自动计算容器大小+resize | 是 | 否（无 remeasure 方法）| **中** - 逻辑拆分为容器观察 + resize 调用 |
| **scripts/wterm-entry.js:44-46** | viewport getter | 暴露 element 供外部布局查询 | 是 | 否（无此属性）| **低** - 仅供选择器查询 |
| **scripts/bundle-wterm.js:10-25** | stripUnderlinePlugin (esbuild) | 在打包时删除 renderer.js 的 underline 检测代码 | 是 | 否（硬编码打包时的改写） | **高** - 打包入口，删除需重新组织 |
| **src/web-ui/content/scripts.js:5216-5220** | wandTerminalWrite() 包装 | 封装 widePadAnsi() CJK 宽度补偿（write → pad → write） | 是 | 否（无内置 CJK 支持） | **中** - widePadAnsi 无法在官方 API 中应用 |
| **src/web-ui/content/scripts.js:5248-5258** | resetTerminal() ANSI RIS | 使用 \x1bc (ANSI RIS) 替换无法工作的 reset()；旧代码是 no-op | 是 | 否（官方无 reset）| **低** - RIS 是 VT 标准，但破坏输出历史 |
| **src/web-ui/content/scripts.js:5263-5277** | softResyncTerminal() | 组合 resetTerminal + replay，处理 CSI 光标定位残留问题 | 是 | 否（需要自定义编排） | **高** - 核心稳定性机制 |
| **src/web-ui/content/scripts.js:5284-5289** | softRefreshCurrentView() | 同步刷新终端+聊天视图状态 | 是 | 否（业务层面组合） | **低** - 纯业务调用 |
| **src/web-ui/content/scripts.js:5314-5319** | maybeScheduleResyncForChunk() | 被动检测原地重绘 CSI 序列（H/f/A-D/J/K），触发 softResync | 是 | 否（需自实现观察） | **中** - 删除会导致菜单交互时 DOM 残留 |
| **src/web-ui/content/scripts.js:11078-11114** | ensureTerminalFitWithRetry() | Android WebView 恢复后容器尺寸延迟问题；混合 rAF 和 setTimeout | 是 | 否（官方无 retry 机制） | **中** - 移除会破坏 Android 适配 |
| **src/web-ui/content/scripts.js:11134-11137** | ensureTerminalFit() 内调 remeasure() | 强制重新测量字符宽高、容器尺寸，驱动 resize | 是 | 否（remeasure 无替代） | **高** - 影响所有尺寸变化反应 |
| **src/web-ui/content/scripts.js:10948-10963** | startTerminalHealthCheck (5s timer + 30s 完整 resync) | 兜底：5s 轻量级 fit，30s 完整 buffer replay（解决长时间连接后的鬼影问题） | 是 | 否（主动式健康检查，官方无）| **低** - 冗余兜底，可删除但需加速心跳 |
| **src/claude-pty-bridge.ts:663-709** | scheduleAutoApprove() | 延迟 350ms 发送 \r，等待 CLI 交互菜单渲染完整 | 是 | 否（PTY 交互层面，与渲染无关） | **低** - 仅影响权限提示流程 |
| **src/pty-text-utils.ts** | stripAnsi/isNoiseLine/hasExplicitConfirmSyntax | 共享 ANSI 剥离与 Permission 检测逻辑（server 和 browser 各用一遍） | 是 | 否（业务逻辑，不是渲染） | **低** - 现有逻辑无异议 |

## 3. 官方 API 调研

@wterm/dom v0.1.8 的公共 API（根据 import 推断）：

| 接口 | 官方提供 | 备注 |
|------|--------|------|
| **WTerm.write(data)** | ✓ 有 | 原生接收字符串 → WASM grid；无内置 SGR sanitize |
| **WTerm.reset()** | ✗ 无 | 我们自造 resetTerminal() = write("\x1bc") |
| **WTerm.remeasure()** | ✗ 无 | 我们自造，计算容器大小 + 调 resize() |
| **WTerm.resize(cols, rows)** | ✓ 有 | 直接可用，改变 WASM grid 尺寸 |
| **WTerm.cols / rows** | ✓ 有 | 可读，用于容量推断 |
| **WTerm.element** | ✓ 有（推断） | 容器元素引用（we expose via viewport getter） |
| **bridge.init(cols, rows)** | ✓ 有 | 初始化 WASM 状态（内部方法） |
| **renderer.setup()** | ✓ 有 | 重置渲染器（内部方法） |
| **renderer 的 SGR 处理** | ✗ 无专门 API | 硬编码 strikethrough/underline，我们打包时删除 underline |
| **ResizeObserver / autoResize** | ✗ 无 | 官方无自动尺寸适配，我们手工 resize handler |
| **内置事件系统** | ✗ 不清楚 | 暂无事件暴露 |

**关键发现**：@wterm/dom 是 低级图形库，无终端逻辑：
- 不负责输入解析、权限、chat parsing
- 仅提供 write/resize 的底层 WASM grid + DOM 渲染
- 所有"终端协议"层面的工作（reset、softResync、健康检查）均需上层自实现

## 4. 清理建议（按风险从低到高）

### 🟢 低风险（可立即删除或收敛）

**4.1 删除冗余的 5s 健康检查**
- **位置**：src/web-ui/content/scripts.js:10948-10963
- **为什么安全**：30s 完整 resync 的兜底仍在；5s 轻量级 fit 仅是预防性的，且被其他事件处理（resize、permission change）覆盖
- **删除后**：加快 ensureTerminalFit 调用频率（从事件驱动改为 2-3s），或改成观察型触发
- **补偿**：需加速 resize observer 响应或增加事件驱动的 fit 检查

**4.2 简化 softRefreshCurrentView()**
- **位置**：src/web-ui/content/scripts.js:5284-5289
- **为什么安全**：纯聚合调用，无业务逻辑；可内联到调用方
- **删除后**：调用处直接做 softResyncTerminal() + resetChatRenderCache() + render()
- **补偿**：无

**4.3 合并 maybeScheduleResyncForChunk() 到 syncTerminalBuffer()**
- **位置**：src/web-ui/content/scripts.js:5314-5319
- **为什么安全**：仅供 syncTerminalBuffer 调用，可内联
- **删除后**：减少函数调用层级，逻辑同步化
- **补偿**：保留 IN_PLACE_REDRAW_RE 正则作为内联条件

---

### 🟡 中等风险（需补偿或重构）

**4.4 用 ResizeObserver 替代手工 resize handler**
- **位置**：src/web-ui/content/scripts.js (多处 resize handler)
- **为什么有风险**：需确保 resizeObserver 和 event handler 不冲突，且兼容 visualViewport（iOS）
- **删除**：移除 window.addEventListener("resize") + visualViewport.addEventListener("resize")
- **补偿**：
  ```js
  resizeObserver = new ResizeObserver(() => ensureTerminalFitWithRetry("observer"));
  resizeObserver.observe(container);
  ```
- **还需**：保留 visualViewport handler（iOS PWA 键盘弹起），仅合并 window resize

**4.5 用 write("\x1bc") 替代 reset()**  
- **位置**：scripts/wterm-entry.js:18-23
- **为什么有风险**：RIS 会清空滚动历史和光标位置，可能影响某些长连接会话的 replay 逻辑
- **删除**：去掉自定义 reset()，改为在 resetTerminal() 处直接用 \x1bc
- **补偿**：确认没有代码依赖 reset() 保留光标位置（目前仅 softResyncTerminal 调用，预期行为就是完全刷新）

**4.6 拆分 remeasure() 为官方 API 调用**
- **位置**：scripts/wterm-entry.js:25-42
- **为什么有风险**：需暴露 _measureCharSize 或改为容器观察模式
- **删除**：去掉 remeasure() 改写
- **补偿**：
  ```js
  // 外部调用改为：
  const measured = terminal._measureCharSize?.();  // 若可用
  if (measured) {
    const newCols = Math.floor(containerWidth / measured.width);
    terminal.resize(newCols, newRows);
  }
  // 或：用 ResizeObserver 监听容器，自动调 resize()
  ```

---

### 🔴 高风险（需谨慎或保留）

**4.7 underline SGR 过滤（stripUnderlinePlugin）**
- **位置**：scripts/bundle-wterm.js:10-25 + scripts/wterm-entry.js:4-13（两处互补）
- **为什么有风险**：
  - 打包时和运行时双层过滤（冗余但互补）
  - 删除需确认 renderer.js 输出的 underline 在浏览器中不显示或显示异常
  - 如果 @wterm/dom 的新版本修复了 underline 样式，删除这两处才能启用
- **删除**：
  ```js
  // 删除 bundle-wterm.js 的 stripUnderlinePlugin
  // 删除 wterm-entry.js 的 SGR_RE 过滤
  ```
- **补偿**：
  - 与 @wterm/dom 维护者确认 underline 样式在现代浏览器中是否正常
  - 若删除后页面样式异常（文本全带下划线或无故抖动），恢复其中一处过滤

**4.8 softResyncTerminal() 及其相关链路**
- **位置**：src/web-ui/content/scripts.js:5263-5277 + 5251 + 5313 + 多处调用
- **为什么有风险**：
  - 是当前解决"DOM 残留/错位"的核心机制
  - 删除会导致 Claude permission 菜单交互时出现"内容跑到顶部"的问题
  - 需要 @wterm/dom 提供 "discard DOM cache" 或 "soft reset" 的官方 API 才能完全替代
- **建议**：**保留**，不删除；但可优化触发策略：
  - 改为 ResizeObserver 驱动而非 5s 轮询
  - 改为权限提示出现/消失时立即触发（而非被动检测 CSI 序列）
  - 减少 reset() 调用（目前每次 replay 都重置，可改为增量模式）

**4.9 ensureTerminalFitWithRetry()**
- **位置**：src/web-ui/content/scripts.js:11078-11114
- **为什么有风险**：
  - Android WebView 特定问题（resume 后容器尺寸延迟）
  - 删除会使 Android 应用恢复时显示错乱
  - 官方 @wterm/dom 无此机制，需上层实现
- **建议**：**保留**；改进方式：
  - 与 resize observer + visualViewport 事件整合（去重复检查）
  - 改为固定 3 次 rAF 尝试（而非最多 8 次混合）

---

## 总结

**可安全删除**（3 项，低风险）：
1. 5s 健康检查 → 改为事件驱动
2. softRefreshCurrentView() → 内联调用
3. maybeScheduleResyncForChunk() → 内联逻辑

**需要重构**（3 项，中风险）：
1. 用 ResizeObserver 替代手工 resize handler
2. 用 \x1bc 替代 reset()（需验证 replay 行为）
3. 拆分 remeasure() 为容器观察 + resize 调用

**应当保留**（2 项，高风险）：
1. underline SGR 过滤（待官方修复）
2. softResyncTerminal() 及其触发链路（核心稳定机制）
3. ensureTerminalFitWithRetry() （Android 兼容性）

**@wterm/dom 的缺陷**：
- 无 reset() → 我们用 \x1bc 补
- 无 remeasure() → 我们手写容器观察+resize
- 无 SGR 过滤 → 我们打包+运行时双层删除 underline
- 无事件系统 → 我们在应用层完全自建

官方库应考虑暴露这些API，或更新文档说明 callback hook 位置。

