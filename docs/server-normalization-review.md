# 服务端接口归一化复查（2026-11-03）

> 历史记录：结论、数字、界面尺寸和验证结果仅对应标题日期的实现。本文件不定义当前开发要求，也不证明当前版本已验收；后续任务须按最新需求和实际源码重新判断。

首轮只整理了路由索引与三处局部重复，不能代表服务端深层逻辑已经审完。本轮从路由继续追到分发管理、任务结果绑定、归档策略与 Git 执行入口，按行为边界处理重复。

## 已落地

| 功能 | 原来的重复/分叉 | 本轮共同入口 | 保留的边界 |
| --- | --- | --- | --- |
| 评论结果总览、轮次块、工具、单块 | 四份任务归属及结果范围校验；总览与详情使用不同执行任务 | `task-comment-dispatch.ts` 的 `readCommentResult` | 评论归属、automationId、执行任务、用户轮次、requestId、冻结指纹全部校验；分页预算保留；总览专有 still_running 和 sessionId 响应保留 |
| 普通结构化消息与队列立即发送 | 接受状态、回执附带、异常映射各写一份 | `server-session-input-routes.ts` 的 `respondToStructuredInput` | 接受后失败仍是 503/INPUT_DELIVERY_UNCONFIRMED；各接口原有冲突码差异保留；PTY 与立即接受接口仍按各自契约处理 |
| 批准、拒绝、自动批准 | 三份执行归属选择和 Codex 限制 | 同文件的权限路由声明与共享分派 | 真实 owner 判断、manager 的 this 绑定、错误文案及领域错误暴露策略保留 |
| DMG / IPA 最新版本 | 相同的本地优先、无有效本地版本再回退 GitHub | `DistributionManager.localOrGitHub` | APK 是本地/远端比较选择，macOS Beta 是仅本地，两者不纳入该策略 |
| 三平台分发配置刷新 | 三份 enabled、目录、固定文件刷新 | `DistributionManager.refreshConfig` 的字段映射 | 只刷新实际提供的字段；非法 enabled 不覆盖；目录默认值、空固定文件语义保留 |
| 文件目录的 Git 标记 | 路由自建 exec/promisify/shell 入口 | 现有 `runGitRawAsync` | Git 解析及可选装饰降级不变；统一取得环境、超时、有界输出和禁止凭据交互 |
| 任务可归档 | 读取投影与写入入口各持有资格规则 | `taskArchiveEligible` | 投影用请求快照；写入仍读实时会话、排队评论、活跃团队。没有以缓存替代写入裁决 |

本轮相对于第二轮开工基线：6 个源码文件，新增 161 行、删除 263 行，净减 102 行。首轮改动和其他未提交工作均保留，没有提交、推送或修改客户端源码。

## 确认的行为缺陷

评论执行被分配到派生任务时，原总览按父任务 workspaceTaskId 比较而返回 unconfirmed_legacy；同一评论的块详情按 executionTaskId 比较却可读取。临时 HTTP 夹具已经复现旧总览失败、详情成功，并验证归一化后四个接口一致。

该缺陷的真实已完成派生任务复验尚缺样本；本轮查询 Wand 项目已存在的带冻结结果评论，未找到能复现的样本。未调用模型制造执行记录，不把夹具通过写成生产场景通过。记录在任务 `9ceaa78b-3c94-4661-b4c3-c4d4158cf6ed`。

## 没有强行合并的相似代码

- 会话历史数据库分页与运行态消息分页：数据来源、游标和预算语义不同。
- workspaceSessionSummary、taskSessionSummary、sessionBase：标题策略、engine 取值、默认字段与暴露范围不同，复用整个 DTO 会改变客户端合同。
- read model 与归档写入：共用规则，但不共享跨请求事实缓存。
- provider 的原生历史恢复：已有 StructuredResumeSpec 统一流程；各 provider 的 ID 校验与 cwd 来源是必要差异。
- settings 管理员与 about 公共视图：字段权限不同，不能把管理员配置直接复用到公共回包。
- Pi 原生 TUI、通用 structured tmux 和 PTY：事件观察、停止、恢复与进程所有权不等价，不合并执行实现。

运行时的 `directoryLatestMtime` / `directoryBytes` 在 structured-tmux-host 与 pty-tmux-backend 存在相同实现，属于进一步精简机会；已建任务 `b28d68c1-04a0-4ca7-86a7-d33ba8ea527a`，需按 Server/terminald 独立生命周期单独验证，本轮未动运行时所有权及 GC 删除策略。

## 验证范围

- `npm run check`、`npm run build`：通过。
- 223 项临时 HTTP、分发文件夹具、归档规则对照：通过。覆盖接受前拒绝/接受后失败、重复发送、父子任务归属、无效范围/指纹/用户轮次、分发配置缺省/部分/非法值，以及任务接受/排队/会话忙/团队忙组合。
- Web、Android、iOS、macOS 的相关调用及解码处已核对；无需协议适配。未构建客户端或进行设备/视觉验收。
- 原始证据在本机 `/tmp/wand-server-deep/`，不含连接码或 token；未恢复仓库自动化测试套件。
- 已通过 `~/start.sh` 部署 `4.109.0-debug.t11032043`；6 个修改模块的已安装 JS 与构建产物 SHA-256 一致，Render/terminald 保持原进程。
- 已安装真实服务：23 个更新、输入拒收、权限拒收、评论结果缺失、Git 目录读取响应与部署前一致；5 个真实任务的列表/详情可归档判断一致。
- `git diff --check` 通过。以上不等于缺少样本的派生任务结果场景通过；整体精简也未宣称覆盖所有运行时实现。
