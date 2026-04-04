# 排查清单

这份清单按故障类型组织，目标是让后续排查时能直接照着执行，而不是重新通读整套代码。

---

## 1. 会话恢复异常排查

### 现象
- Resume 按钮不出现
- 按 session 恢复失败
- 按 Claude session id 恢复失败
- 恢复后聊天记录缺失或错乱

### 排查顺序
1. 检查会话是否存在 `claudeSessionId`
   - `src/storage.ts`
   - `src/process-manager.ts`
2. 检查是否有真实会话内容，而不只是空壳 snapshot
   - `messages`
   - `output`
3. 检查 Claude 历史文件是否仍存在
   - `ProcessManager` 的历史扫描逻辑
4. 检查原 command 是否以 `claude` 开头
5. 检查 resume 后旧会话 `resumedToSessionId` 是否回写成功
6. 检查前端 Resume UI 用的是哪套条件

### 要记录的证据
- session snapshot
- `claudeSessionId`
- 历史文件路径
- 恢复命令
- 恢复前后新旧 session 关系

---

## 2. 权限审批卡死排查

### 现象
- Claude 明明在请求权限，但前端没出现审批 UI
- 点了允许/拒绝无效
- 会话卡在 blocked 状态

### 排查顺序
1. 检查 PTY 原始输出里是否真的出现权限提示文本
2. 检查 `ClaudePtyBridge.detectPermission()` 是否命中
3. 检查 `ProcessManager` 是否把结果挂到 `pendingEscalation`
4. 检查 `/api/sessions/:id/approve-permission` 或 `/resolve` 是否被调用
5. 检查 PTY 是否实际收到确认输入
6. 检查 `lastEscalationResult` 是否更新

### 要记录的证据
- prompt 原始文本
- scope / target 推断结果
- pendingEscalation 内容
- resolve 请求参数
- resolve 后 session snapshot

---

## 3. chat / terminal 不一致排查

### 现象
- terminal 里有内容，chat 没有
- chat 里消息顺序或边界不对
- 历史会话与实时会话渲染不同

### 排查顺序
1. 看 raw output 是否完整
2. 看 `ConversationTurn[]` 是否存在
3. 看是否触发了 `message-parser.ts` fallback
4. 对比：
   - `snapshot.output`
   - `snapshot.messages`
   - `/api/sessions/:id?format=chat` 返回值
5. 检查 WebSocket 收到的是 `output.raw` 还是 `output.chat`
6. 检查前端当前视图是 terminal 还是 chat

### 要记录的证据
- 同一 session 的 raw output
- 同一 session 的 messages
- fallback 解析结果
- 当前前端视图状态

---

## 4. WebSocket / polling 竞态排查

### 现象
- 切换会话后内容闪回
- 断线重连后状态倒退
- 某些 UI 先显示新数据又被旧数据覆盖

### 排查顺序
1. 确认首屏是否同时触发了：
   - `refreshAll()`
   - `startPolling()`
   - WebSocket subscribe
2. 记录同一 session 的三类来源到达顺序：
   - REST snapshot
   - WS init
   - WS 增量事件
3. 检查前端是否有版本号/时间戳/哈希用于防止旧数据覆盖新数据
4. 检查断线时 `pendingMessages` / `messageQueue` 行为
5. 检查 reconnect 后是否重复绑定监听器

### 要记录的证据
- 网络时序
- selected session 变化
- WS init 消息
- polling 返回快照
- UI 最终渲染结果

---

## 5. 配置异常排查

### 现象
- config 文件被“自动改动”
- 设置页修改未生效
- 某些值来源不清楚

### 排查顺序
1. 确认字段属于：
   - `config.json`
   - `app_config`
   - 数据库密码覆盖
2. 检查 `ensureConfig()` 是否发生 merge + write back
3. 检查 CLI `config:set` 与设置页 `/api/settings/config` 是否覆盖同一字段
4. 检查实际生效值优先级：
   - DB password vs config.password
   - defaultCwd / shell / defaultMode 是否已持久化写回

### 要记录的证据
- 当前 config.json 内容
- SQLite app_config 对应值
- 启动时传入 configPath
- 设置页提交内容与返回值

---

## 6. 持久化不一致排查

### 现象
- 会话列表和详情不一致
- 日志文件与数据库记录不一致
- 重启后显示异常

### 排查顺序
1. 对比三层状态：
   - 内存 snapshot
   - SQLite row
   - `~/.wand/sessions/<id>/` 日志目录
2. 检查最后一次完整写入是否成功
3. 检查是否只走了 metadata 更新，没有落完整 messages
4. 检查异常退出时是否跳过了某些 flush

### 要记录的证据
- DB 行数据
- messages.json
- pty-output.log
- 当前进程内 session snapshot

---

## 7. HTTPS / 证书 / PWA 异常排查

### 现象
- 浏览器频繁提示证书问题
- Service Worker 注册失败
- 页面升级后自动刷新异常

### 排查顺序
1. 检查 `config.https` 是否开启
2. 检查证书文件是否存在且可读
3. 检查 `cert.ts` 是走 openssl 还是 fallback 生成
4. 检查 `/sw.js` 是否能成功 fetch
5. 检查 `controllerchange` 是否触发了意外 reload
6. 检查缓存版本是否变化过快

### 要记录的证据
- 证书路径与文件状态
- 浏览器 console
- Service Worker 注册状态
- `sw.js` 响应内容

---

## 8. 优先观察指标建议

后续如果开始真正动代码，建议先补下面这些观测点：

- Claude 历史扫描耗时
- JSONL 解析失败次数
- 权限 prompt 识别次数 / 误判样本
- WebSocket init 与 polling 覆盖顺序
- 完整 session 持久化耗时
- 日志写入失败次数
- resume 成功率 / 失败原因分类

这些观测点会直接决定后续优化优先级是否需要调整。
