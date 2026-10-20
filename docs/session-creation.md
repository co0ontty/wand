# 新建会话契约

普通新建会话（Web、macOS、iOS、Android 与 `session:create`）统一使用 `POST /api/sessions`。执行类型由请求中的 `kind` 明确指定，不再由 URL 区分。

## 请求

- `kind: "structured"`：结构化会话，保留 `provider`、`engine`、`runner`、`employeeId`、`overrideCli`、`model`、`thinkingEffort`、`mode`、`systemPrompt` 等已有选择语义。
- `kind: "pty"`：CLI 终端，保留 `command`、`provider`、`mode`、模型、终端尺寸等参数。
- 空白终端使用 `kind: "pty", shell: true`，不携带 provider、command 或模型身份。
- `cwd`、`workspaceId`、`workspaceTaskId` 表达运行位置与归属；不能用展示状态代替持久归属。
- 结构化首条输入可使用 `prompt`，PTY 首条输入沿用 `initialInput`。Web 主创建页继续通过现有 composer 在创建后交接首条输入，不在两个路径重复发送。

例如，创建不附首条输入的空白终端：

```json
{
  "kind": "pty",
  "shell": true,
  "cwd": "/path/to/project",
  "cols": 100,
  "rows": 30
}
```

`kind` 必须是 `structured` 或 `pty`。Pi CLI 与 Wand Agent 仍共享 `provider: "pi"`，但引擎分别为 `cli` 与 `sdk`；Wand Agent 仅支持 structured。自定义命令仍受管理员权限限制。员工候选、权限及引擎校验不因端点统一而放宽。

## 回执与错误

成功返回 `201` 和原有会话 DTO（包含 `id`）。结构化创建不等待首轮模型执行结束；后续执行结果由会话事件和状态表达。创建成功不等于首条消息已执行成功。

客户端必须区分明确拒绝、已接受与未知送达。网络中断、408、409、5xx、成功响应无法解析等不能直接当作“未创建”并自动重试。创建成功后刷新、导航或布局更新失败，继续使用已取得的会话 ID，不能再次创建。

当前普通创建协议没有持久请求回执账本；客户端内存中的未确认锁不是跨刷新、跨进程幂等保证。不要宣称仅靠本地提交锁即可保证 exactly-once。

## 交互语义

- 打开创建界面只预填，不启动执行。
- 工具、模型、思考与权限选择仅作用于本次创建，不顺带写全局默认。
- 普通新会话不强制建立任务；显式创建任务时保留已接受的任务绑定，后续会话明确拒绝后重试不重复建任务。
- 高权限模式需要明确确认；确认不修改全局设置。
- 创建期间防双击；失败保留输入；按钮与键盘提交使用同一校验。
- 原生端保留平台组件与布局，不要求像素一致。

## 不合并的接口

移除的仅是旧 `POST /api/commands` 和 `POST /api/structured-sessions` 创建方法。会话列表、详情、输入、排队、恢复与归档仍保持各自操作接口。

这是创建接口的不兼容变更：旧版原生客户端仍请求旧路径，新版客户端需要支持统一接口的服务端。部署必须协调四端更新与服务端切换；仅构建新版客户端不表示已安装旧版能够继续新建。既有会话及其输入/恢复接口不因本次创建端点迁移而被删除。

任务派发、团队运行、私聊/群聊消息拥有独立业务接受、归属和幂等契约，不替换为裸会话创建。PTY 与 structured 的执行 manager、运行所有权、恢复和生命周期仍然分离。
