# 服务端逐文件复查（2026-11-03）

## 范围与判定口径

本会话累计逐段阅读 `src/server*.ts` 44 个文件，第三轮开始时共 11,060 行；下表按文件记录职责、重复点和处理边界。第一、二轮已读的文件继续沿用其阅读和验证证据，本轮补读未覆盖段落。不是根据文件名、行数或克隆检测就认定审完。

这是 HTTP 装配层及直接关联业务的审查，**不是整个 src/、全部存储仓库、provider adapter、Render 或四端运行态的全量审计**。表中的「保留」表示未找到值得本轮合并的同义处理，不表示无缺陷或所有接口都已实机验收。接口注册表达式数量也不是展开动态路由后的接口总数。

本轮使用已安装的 `code-simplifier`；保留对外合同，避免为了减行数引入通用 CRUD 框架。已有未提交工作保留，未自动提交、推送或修改原生端。

## 逐文件结论

下列文件均在 `src/`。关联的非 server 文件见后表。

| 文件 | 实际检查内容、结论及处理 |
| --- | --- |
| `server.ts` | 从 PATH/存储初始化、所有路由挂载、WS 事件、后台更新到失败回滚和 close 全段检查。认证前挂载、body parser 顺序、Core 排空、持久宿主断连有时序约束。PTY/structured 事件扇出中间有专属记账与排队动作；不把它们改成一个无差别回调。失败启动和正常退出不能简单同序处理；APNs/灵动岛还通过 storage.onClose 释放。保留。 |
| `server-ai-team-routes.ts` | 成员候选/绑定、团队定义、直接建卡开工、运行详情与批准/拒绝/回复等。已有 action 统一六种运行操作；成员与员工校验共用头像/候选解析，但领导人数、来源锁定不同。直接建卡失败回滚不能混入既有任务派发。保留。 |
| `server-apns-routes.ts` | 订阅/灵动岛注册和撤销四路。PUT 用应用 bearer，DELETE 用只能撤销自身的设备能力；token 长度、topic、租约、错误文案不同。保留共同限流 router，不用表驱动掩盖授权差别。 |
| `server-app-connect.ts` | HMAC 连接码、转发头、LAN 选址、连接 origin、头像人设与本地头像映射。请求 URL 与连接码允许来源不同；头像两角色已经共用 buildRole。保留。 |
| `server-asset-routes.ts` | vendor、CSS、JS、模块目录、入口页、头像完整检查。本轮统一五类 JS 的内容类型和 hash 缓存响应；app.js 仍 private，其他 public；getter 在请求时调用并保留旧 hash 选择。模块目录不可替换旧字节，头像文件校验保持独立。 |
| `server-attention-routes.ts` | 会话与团队运行投影后交给 collectAttentionItems；字段集合刻意小于会话 DTO。已有规则归属，保留。 |
| `server-auth-routes.ts` | 本机票据签发/撤销、消费、密码/应用登录、改密、登出和探测。票据单次消费、主体有效期与密码限流各有状态。复用现有 auth/cookie/limiter；不合并为一个认证路径。 |
| `server-conversation-organize-routes.ts` | scope 校验、预览确认 token、作业读取和取消。作业化归类与老标题直接整理的 ID 限制/确认语义不同。保留。 |
| `server-conversation-routes.ts` | 六类会话写操作已有 post 包装和统一 receipt；relay 错误处理与 HTTP 有不同回执语义。保留。 |
| `server-daemon-maintenance-routes.ts` | 状态与管理员明确 confirmInterrupt 的强更。冲突回包带真实维护状态；不能并入普通 Server restart。保留。 |
| `server-decision-routes.ts` | 有界决策专用能力与普通登录 fallback、状态、evaluate。与另外两类决策请求共同使用 responseAbortController，权限和 DecisionError 映射仍在本文件。 |
| `server-diagnostics.ts` | 有界环形事件、请求 finish/close 去重、导出并发、session 数量限制及字段白名单。属于已有未提交工作；不把它的响应记录与推理取消混用。保留。 |
| `server-dingtalk-routes.ts` | install/auth/groups/plans/connections/bindings 注册与安全错误映射。已用局部 route 统一；unknownDelivery 与外部连接状态保留。未发送消息或安装连接器。 |
| `server-employee-im-routes.ts` | 管理员/员工存在检查、凭据只写投影、保存、测试发送。已集中前置守卫，测试发送的未知送达 502 不改。保留。 |
| `server-employee-routes.ts` | 内置员工锁、固定头像的局部编辑、候选、HR 草稿、默认配置、旧知识接口、归档恢复删除。候选已单一 parseEmployeeAgents；全量创建与部分更新不同，提示词读投影不可回写。保留。 |
| `server-feedback-routes.ts` | 公共加密入口、认证客户端转发、管理员报告读取。不同 payload 上限、频率和存储失败分类是必要差异，保留。 |
| `server-file-routes.ts` | 全段路径/目录/Git 装饰、预览/Range 下载、静态站相对资源、增删改文件、搜索、recent paths。第二轮改用 runGitRawAsync；Range 已共用 streamFileWithRange。真实路径、symlink、读写权限与预览大小限制不可合并成简单 exists 检查。 |
| `server-github-routes.ts` | connector CRUD、绑定、仓库/issue/PR 代理。已有 githubJson、repoPath、分页与安全错误入口；写 payload allowlist 各异，保留。没有调用外部写 API。 |
| `server-history-routes.ts` | 各 provider 历史查询和删除；修改流程已经统一，列表空值兼容与 cwd/原生 ID 来源保留。 |
| `server-knowledge-routes.ts` | 归属、输入、revision 校验与五类读取/修改。已有 handle 统一 no-store 和错误；知识库领域异常不同于普通 bodyObject，保留。 |
| `server-local-model-routes.ts` | status、download/initialize/cancel、LAYA 设置及错误中间件。下载/初始化已循环注册；取消拒绝命令参数、设置只许 enabled，不与推理端点混合。保留。 |
| `server-local-preview-routes.ts` | loopback host/port、重定向、过滤凭据和安全头、流式 body、超时与上下游错误。其断开销毁 upstream 与决策 AbortController 不同；保留。 |
| `server-mission-routes.ts` | inbox、mission、attempt diff、review 评论/发送/解决。领域错误映射已集中；缺省 commentIds 与空数组不同，保留。 |
| `server-notifier.ts` | WS attach 前后稳定回调、系统/团队/live/conversation 通知；已有单一通知出口，保留。 |
| `server-pi-defaults-routes.ts` | 用户级 Pi 设置发现/解析/保存；和会话级设置共用 catalog/selection，但默认偏好与会话权限不同。保留。 |
| `server-pi-recommendation-routes.ts` | 真实 owner/CLI 能力、每会话互斥、候选发现、模型等待上限、迟到结果复核。本轮只统一断开取消与监听释放；timer、owns 和会话复核仍归本接口。 |
| `server-request.ts` | 文本、body、header、proxy、错误响应等共享工具。strict 对象检查、默认值和 query 数组规则各有明确契约。无新增全局路由包装器。 |
| `server-resume-routes.ts` | 五类 structured 原生恢复已有 StructuredResumeSpec；provider ID 格式、历史 cwd、恢复调用保持独立。保留。 |
| `server-scheduled-task-routes.ts` | list/calendar/activity/run/detail/create/update；failure 已统一404/409/400。权限依赖装配，定时任务状态归 service。保留。 |
| `server-session-context.ts` | 共享依赖、Pi 设置能力、sessionResponseDTO。上下文复用已经存在；运行事实由 registry 提供，保留。 |
| `server-session-history.ts` | 历史分页及消息预算；不等同 live 快照工具读取，保留。 |
| `server-session-input-routes.ts` | structured、队列、PTY、权限输入。第二轮统一两种 structured 回执/异常处理和三种权限操作；接受后失败/不明送达以及 PTY 两包协议保持原义。 |
| `server-session-lifecycle-routes.ts` | PTY/structured 创建、Pi 设置、模型/模式、恢复、归档、批量及删除。创建执行方式不同；归档写状态与恢复可能重启不同；Claude 按原生 ID 恢复有额外历史文件与命令校验。保留。 |
| `server-session-list-routes.ts` | live/history 列表、分页、工具、图片、Pi 执行、完成已查看。第一轮统一工具快照选择；只读列表仍不写“已查看”。 |
| `server-session-routes.ts` | 系统调用只读守卫、各子族顺序和公共导出。导出是兼容入口，不按死代码删除。 |
| `server-session-worktree-routes.ts` | worktree 查询/合并、quick commit、message、tag、push、多 worktree merge。第一轮统一五路 session/cwd 校验；Git 锁、源分支和生成式提交的调用边界保持独立。 |
| `server-settings-routes.ts` | 全段 about/admin 配置、环境预览、偏好事务、模型、OpenRouter、证书。本轮统一版本信息和模型 payload；公共 about 仍去除磁盘目录，管理员配置/敏感环境权限不扩散。配置写入回滚与运行态 commit 不动。 |
| `server-storage-cleanup-routes.ts` | 管理员 status/preview/run。GET dry-run 与 POST 真清理、busy 互斥和固定范围检查均保留；没有触发真实清理。 |
| `server-task-routes.ts` | 任务 DTO/快照、默认候选、里程碑、创建/编辑/工作流、归档/绑定/派发。第二轮归档规则已有统一；本轮统一团队与单执行者派发的项目迁移校验，保留各自原调用时机。里程碑创建/编辑也已统一按最终名称和归属查重，修复组合编辑的漏判和误拒。 |
| `server-team-dispatch-routes.ts` | plan 的断开取消与 start 的名单/项目校验。本轮共用 responseAbortController；建议与实际开工不合并，unknown delivery/错误脱敏不动。 |
| `server-update-routes.ts` | 公开四平台更新/下载、iOS OTA、管理员更新、CLI 更新、自动更新设置。第一轮共享更新 payload；渠道/版本比较、下载源/哈希差异保留，升级锁和确认不动。 |
| `server-user-memory.ts` | 操作白名单、成功回执、epoch、私有员工隔离及查看/开关/清空/刷新。不是知识库 CRUD；不能共享一套写入策略。保留。 |
| `server-vault-routes.ts` | 扩展状态、vault/item CRUD、使用记录、密码/TOTP、安全报告。同样返回 item 的三个入口有不同写副作用；已有 storage 真源，保留。 |
| `server-workspace-routes.ts` | 全段工作区 CRUD、task 创建、布局校验、标题整理、目录分组、任务详情/归档/删除/worktree。独立会话合成目录现在复用 task 分组的 syntheticGroupForCwd；筛选、排序、名称、最早创建/最近活动和分页隐藏成员不变。列表与 task DTO 标题/engine 合同不同，不合并整个 DTO。 |

## 直接关联模块

| 文件 | 结论 |
| --- | --- |
| `express-async.ts` | 新增 responseAbortController，只处理响应断开取消及显式 dispose；三个调用方在 finally 释放。正常已结束响应不 abort，Pi 的主动超时仍可操作 controller。 |
| `distribution-manager.ts` | 第二轮统一 DMG/IPA 本地优先回退策略和三平台配置刷新；APK 版本竞争、macOS Beta 本地专属策略仍独立。 |
| `task-comment-dispatch.ts` | 第二轮四类结果共享归属/冻结范围校验，修复总览与派生任务详情分叉；真实派生任务完成样本验收仍缺。 |
| `task-archive-policy.ts`、`task-read-model.ts` | 资格谓词单一；写入实时读取与请求快照投影保持不同事实来源。 |
| `git-utils.ts` | 文件路由已采用现有 Git 环境/超时/缓冲入口，解析未改变。 |
| `pty-tmux-backend.ts`、`structured-tmux-host.ts` | 相同目录字节/mtime 递归统计仍待独立归一化；生命周期与执行实现不合并。已有任务，无重复建卡。 |
| `middleware/api-scope.ts`、`auth.ts`、`web-ui/scripts.ts` | 核对当前权限映射、认证边界及请求时 hash 资产选择；本轮无编辑。 |

## 未闭环事项（任务面板为真源）

- `b1e6fc8b-629a-4fe3-819c-333364735cfb`：里程碑组合编辑查重已修复；临时 HTTP 和已安装真实服务复验通过，证据已回填，未代人工归档。
- `9ceaa78b-3c94-4661-b4c3-c4d4158cf6ed`：派生任务评论结果四接口代码已修，仍缺真实已完成样本验收。
- `b28d68c1-04a0-4ca7-86a7-d33ba8ea527a`：运行时目录统计重复，待独立处理与验证。

## 本轮验证

本轮增量涉及 8 个源码文件，新增 79 行、删除 104 行，净减 25 行；新增共同入口替换重复规则，并修复一处组合编辑缺陷，不以删行数代替收益。

- `npm run check`：通过；`~/start.sh` 内的构建、安装、排空及重启：通过。首次部署因本轮 check 正持有构建锁安全退出，待 check 完成后正常重试，没有移除锁或强停进程。
- 30 项临时对照：通过。覆盖设置/模型 DTO、五类 JS 响应、取消监听释放、目录分组、派发非法项目、决策成功/失败及里程碑组合编辑的旧漏判/误拒。没有恢复仓库测试套件，没有调用真实付费模型。
- 已安装版本 `4.109.0-debug.t11032058`，8 个修改模块的安装 JS 与构建产物 SHA-256 全部相同；Render PID 5044、terminald PID 62828 保持原进程。
- 14 组真实服务检查：通过。包含 about、模型、受限管理入口/无效业务请求、任务目录以及五类资产的无 hash、旧 hash、当前 hash；验证 app.js private 与其他 public 的长缓存仅用于匹配字节。前后对照排除构建版本和模型后台发现的 claudeVersion/opencodeVersion/refreshedAt/revision，其余业务字段一致。
- 真实里程碑写入流程：通过。用本轮临时创建的记录验证重名组合拒绝、拒绝不写入、合法组合迁移、自身同名更新；最后删除这些临时记录并查验无残留，未修改用户既有里程碑。
- Web、Android、iOS、macOS 调用及解析合同已核对：字段/路径保持兼容，里程碑沿用现有400校验错误；无客户端代码改动，未构建/安装客户端，未宣称原生视觉或触控验收通过。
- `git diff --check` 和44文件记录覆盖核对：通过。

本机证据：`/tmp/wand-server-by-file/`（基线、verify.mjs、check.log、build.log、deploy.log、live.py、live-milestone.py）。逐文件阅读不等于逐接口运行验收。此前缺样本的派生任务评论结果和未处理的运行时目录统计仍未闭环，不把本轮通过扩大为整个服务端已经精简完毕。
