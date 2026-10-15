# Web 更新改为可恢复事务：设计提案

> 本文是排查后提出的架构与实施合同，**尚未实现、部署或发布**。现有行为见 [web-updates.md](web-updates.md)。范围只含 Server/Web；不合并 Render/terminald 生命周期，不改原生客户端更新协议。

## 1. 结论

不再让 npm 覆盖运行中的服务目录，再依靠 `catch/finally` 恢复。采用：

**稳定启动器 + 不可变版本目录 + 持久更新事务 + 原子版本指针 + 健康验证后提交。**

失败前后有两条明确承诺：

- 切换前失败：旧服务、旧程序及版本指针不动。
- 切换后、提交前失败：自动恢复上一份已验证版本，且验证旧服务真正恢复；不是只把文件拷回就报告完成。

更新执行器被杀、服务崩溃、机器重启也必须按事务恢复。无执行中的 JavaScript `finally` 是正常故障场景，不是需要人工删锁的例外。

## 2. 当前断点与证据

用户提供的第一行 `原生 Core 回合已全部完成，可以停止服务` 是排空成功的信息，**不是安装成功或报错**。真正的拒绝来自恢复安装器的锁检查。

| 现象 / 缺口 | 当前源码证据 | 影响与复现入口 |
| --- | --- | --- |
| 死锁主人退出后仍拒绝更新 | `src/deployment-lock.ts` 的 `acquireDeploymentLock` 对已存在目录直接拒绝；`src/npm-update-utils.ts` 的 `isGlobalUpdateLocked` 只检查目录存在 | 进程异常退出留下锁会持续阻断安装；隔离创建已确认退出 PID 的 owner 后仍拒绝 |
| 相同路径却有两套锁语义 | `scripts/recover-web-update.mjs` 的 `acquireRecoveryLock` 不使用共享锁及继承回执 | 有合法父锁也会报用户提供的原文；正常独立调用被其他更新持锁时也会报同一句，不能仅凭文案断言锁已死 |
| 没有写前事务，硬中断绕过回滚 | `src/npm-update-utils.ts` 的 `installPackageGloballyAsync` 在全局目录执行 npm；备份回执仅在安装成功后的 `finally` 中写入 | 已隔离实测：创建备份后 npm 改写当前包，再对本次进程组 SIGKILL，留下修改过的包、备份及锁，但没有回执，不能自动定位恢复事务 |
| 运行版本和包版本不一致时判断分裂 | `src/server.ts` 使用 `DISPLAY_VERSION` 检查更新；`restart-overlay/model.ts` 优先取 `packageVersion` | 隔离输入中实际运行版本匹配目标、manifest 版本不同，页面仍不就绪；当前本机两值一致，不能说这就是本机此次提示的原因 |
| 页面早于事务提交就宣告就绪 | `restart-overlay/repository.ts` 仅识别 `failed`，不等待 `completed`；`model.ts` 只比较实例/版本 | 隔离响应仍处于 `verifying` 时已经 `ready=true`，后续验证或提交失败无法阻止已经发生的刷新 |
| 状态无法判断更新器已死 | `update-helper.ts` 的 `readDetachedUpdateStatus` 只读 phase/message；状态主体在临时目录 | 存在旧 `installing` 文件就继续显示安装中；缺少 operationId、启动身份、恢复动作与可靠持久存储 |
| HTTP 已开始被卡片画成成功 | `browser/notifications.ts` 的 `showUpdateBubble` 在收到异步启动回执后添加 `is-success` | 仅启动 helper 时视觉上已进入成功态，实际安装可能随后失败；沿源码回执链可复现 |
| 原包备份不等于可用的旧服务 | `update-helper.ts` 的失败分支恢复文件后可直接记录“已恢复原安装”，未核对旧服务恢复健康 | 文件回滚后服务管理器启动失败，不能给出“旧版本已恢复”的功能保证；从回滚失败/旧服务启动失败入口注入验证 |

诊断脚本与记录：`output/architecture-stage2/web-update-transaction/{diagnose.test.mjs,diagnose.log,diagnosis.json}`。六项诊断断言通过表示**当前缺陷已被证实**，不是修复回归通过。

只读核对本机已安装服务与真实 Chrome：正式订阅下运行版本为 `4.92.0-debug.t10141514`，正式候选 `4.92.0`，`updateAvailable=false`、没有更新卡片或安装锁。旧更新记录已完成。查询时 npm Beta 候选是更高版本，Beta 订阅看到它属于真实更新，不是重复提示。

因此本轮不能还原用户那次冲突的 owner，也不能声称本机当前仍在安装失败。实际核对见 `installed-readonly.json`。已下载远端 master 恢复脚本，同样含上述独立目录锁；未删除任何真实锁或触发真实更新。

## 3. 单一更新负责人

```text
Web / 自动更新 / install.sh / update:repair / 本地 start.sh
                         │  提交或附着到 operationId
                         ▼
             独立 UpdateController（事务唯一写入者）
                         │
          ┌──────────────┴────────────────┐
          ▼                               ▼
   staging / releases              持久事务与版本指针
                                          │
                                          ▼
                          稳定启动器 ──→ 指定 Node + Server
                          不从待更新的 npm 包加载恢复代码

Render / terminald 独立运行：这一链路不停止或重注册它们。
```

- 各入口只提交安装意图，不能各写一套安装/锁/回滚。相同部署目标、相同制品的重试返回同一个 operationId；不同目标冲突返回明确的 409 和当前阶段。
- 推荐一个小型独立启动/更新运行时（例如独立 Rust 可执行程序），提供内核锁与子进程监督；不引入 Pi SDK、模型依赖或 Render 执行能力。设计的关键是职责和不变量，不能为了语言选择把它重新放回会被覆盖的 npm 目录。
- 普通 npm 包仍可承载 CLI 和分发资产，但不再直接替换在线 Web 的运行目录。新布局下的 prefix/部署归属由 release manifest 表示，不再靠目录层级推断。
- 服务管理器只注册稳定启动器；启动器监督真正的 Node Server。`MainPID` 将是启动器 PID，现有托管身份检测必须同步识别 launcher PID、child PID 和启动身份，不能继续要求两者相等。
- macOS 启动器驻留在现有 launchd Web job，更新任务由其独立工作进程执行；Linux 可使用现有独立 systemd 更新单元。只有收到真实 job ACK 才返回“已开始”，不能把 `spawn()` 返回 PID 当作可靠交接。
- 启动器自身升级是单独事务，有向后兼容的 journal 格式与自身回退；普通 Server 更新不顺手覆盖它。

### 建议目录

```text
~/.wand/runtime/
  bootstrap/                   # 稳定启动/恢复程序，不被 Server 安装覆盖
  releases/<releaseId>/        # 含完整包、Node 绑定及 release.json；就绪后不可变
  staging/<operationId>/       # npm 仅写这里，绝不写当前版本
  current -> releases/<id>     # 原子替换的运行指针
  last-known-good.json         # 最后一个已健康提交的 releaseId
  updates/<operationId>.json   # 持久事务和故障原因，不放系统临时目录
  update.lock                 # 固定 inode 的内核互斥，不 unlink 当作“解锁”
```

运行状态与日志保存在权限受限目录，不包含 token、密码或完整环境变量。system scope 注册的进程仍按原数据所有者运行，不扩大 Web 权限，不对整个安装执行 sudo。

## 4. 事务与写入顺序

```text
accepted → preparing → prepared → draining → switching → verifying → committed
                │          │          │           │           │
                └──────────┴──────────┘           └───────────┘
                  failed（旧服务不动）              rolling-back
                                                    │
                                         rolled-back / recovery-required
```

事务至少保存：schemaVersion、operationId、目标部署/原配置标识、旧 releaseId、新 releaseId、制品摘要、Node 绑定、phase、旧/新实例启动身份、更新器启动身份、失败原因、恢复结果、重试预算。

每次改变文件或生命周期之前，先写入可恢复的意图。持久写入采用：同盘临时文件 → 文件 fsync → rename → 父目录 fsync；指针切换后同样同步父目录。读 API 不修事务、不解锁、不修改运行事实。

1. **Accept**：取得部署互斥并创建持久事务；固定精确版本及来源，不在安装时再次解析漂移的 dist-tag。锁的作用域必须包括所有可写同一部署的配置实例。
2. **Prepare**：npm 安装到独立 staging，校验 registry integrity、包身份、精确版本、完整资产和 Node 兼容。依赖、下载、探测失败均不碰 current。制品 releaseId 绑定内容摘要，不能仅靠版本号认定相同包。
3. **Probe**：以无业务副作用的启动探测验证依赖和资产；不连接生产数据库写入、不注册 daemon、不执行启动命令/计划任务/模型。完整包成为不可变 release 后才进入切换。
4. **Drain**：真实 Core admission barrier 阻止新回合起跑，已提交新输入仍按现有队列持久化；等待回合完成。状态未知或超时取消切换。PTY/structured daemon 会话不因此停止。
5. **Switch**：先持久记录 pending 及旧新身份；停止旧 Server 并验证它确实退出，然后同盘原子替换 current，启动指定 Node 的 candidate。保留旧 release 和原启动参数，不能用 shell 默认 npm prefix/Node 猜测。
6. **Verify**：candidate 以 probation 模式启动，保持启动 admission fence，不运行后台自动更新、队列、计划任务或启动模型。验证同配置的新实例、releaseId/摘要、实际运行版本、HTTP/IPC、数据库可访问与关键 Web 资产。采用有界连续健康窗口，而不是一次 HTTP 200。
7. **Commit**：先持久写 `committed` 和 last-known-good，再确认 candidate 释放 admission fence。失败或启动器崩溃，由恢复逻辑依据 journal 和真实实例身份继续；不能靠 Web 页面决定提交。
8. **Rollback**：在 fence 内确认 candidate 安全退出，指针切回旧 release，按旧 Node/配置启动并验证健康；确认之后才写 `rolled-back`。恢复验证失败写 `recovery-required` 并保留全部恢复输入，绝不误报成功。

**跨重启的 fence 必须由持久 pending 状态及可信启动握手驱动。** 不能让旧 IPC drain 连接断开就自动把新 Server 的队列放行。已经提交并接收业务的新服务不属于“启动失败自动回滚”窗口；后续运行故障按正常安全排空处理，不能强杀有未知执行的实例。

## 5. 锁与崩溃恢复

- 使用所有更新入口共享的 OS 内核排他锁，文件 inode 固定。启动器退出后内核释放持有权；PID、时间戳或心跳不是解锁授权。不能以 TTL 到期、`kill -0` 失败或 `rm -rf` 粗暴顶掉正在写入的更新器。
- npm 子进程只能写该事务独有的 staging。它即使在父进程崩溃后继续运行，也没有 promote current 或写 journal 的权利；接管者隔离这个 staging，确认写者结束后才清理。
- supervisor 仅持锁/只写 journal 还不够：必须追踪真实 Server 的 PID + 启动时间/启动令牌及进程组或 cgroup。接管者先确认遗留实例，禁止起第二份同配置 Server。
- `updates` 下未终结事务在启动器启动时自动 reconcile：
  - prepare 中断：current 保持旧版本，标记失败；保留仍有写者的 staging。
  - 停旧服务后、切换前中断：按已保存的旧身份恢复旧服务。
  - 切换后、提交前中断：默认回上一份 last-known-good；candidate 状态不明时保留 fence、进入 recovery-required，不无条件发 kill。
  - commit 写入后中断：验证并续接同一 release；不再重复安装或开启第二事务。
  - rollback 中断：继续恢复同一旧 release，并再次验证，不能仅凭指针位置结束事务。
- 现有 `.wand-update-lock` 是兼容输入，迁移阶段新旧锁都需协调。确认旧 owner、子进程/写者及事务状态后才能归档旧锁；未知锁不猜测死亡。新旧更新器同时允许写当前安装会破坏内核锁的保证，迁移必须封住旧安装入口。

### 5.1 自动更新的极端故障合同

用户明确要求：**上述兜底同样适用于无人值守自动更新；人工移锁/清锁不能成为正常恢复步骤。** 以下是待实现的硬性验收要求，不是当前 Beta 的已有行为。

恢复必须由独立 supervisor 的启动、更新子进程退出及恢复任务事件自动触发；即使浏览器关闭、Web 未能启动，也不依赖用户再次点击更新。GET/状态轮询仍保持只读。启动前恢复、事务接管及更新安装必须使用同一互斥和写入者代次，不能让恢复动作与新安装同时修改 current。

| 极端情况 | 自动兜底必须做什么 | 禁止的捷径 |
| --- | --- | --- |
| 更新器异常退出，留下旧目录锁 | 结合事务、原启动身份及写者状态判断；确认无写者才自动归档兼容旧锁并恢复事务。新协议靠内核持有权，不依赖目录删除 | 单凭目录存在永远拒绝，或单凭PID不存在就删除 |
| owner退出但npm子进程尚活 | npm仅能写该事务独有的staging；隔离该代次，确认子进程退出再清理，不允许迟到结果promote | 杀所有npm/node进程、删除仍在使用的目录 |
| PID被复用、owner缺失/损坏、权限不足 | 启动时间/启动令牌/进程组与事务身份联合核对；身份不能确认就终结为recovery-required，保留旧版本/备份并明确说明阻塞 | 把EPERM、损坏回执或超时当成“已死”；请求自动sudo |
| 同一更新被自动轮询、手动入口或响应丢失重试重复触发 | 附着同一operationId；不同目标等待或明确冲突。重新核对实例身份和写入代次 | 嵌套抢同一锁；开启第二份同配置服务 |
| 下载、npm、初始化或健康检查超时 | 每阶段有持久deadline及整次恢复预算；切换前终结失败而旧服务不动，切换后进入安全回滚；恢复也受限 | 无限显示“安装中”、无限重试同一失败制品 |
| 任一写入/切换阶段SIGKILL或机器重启 | 按已持久化意图、实际指针及验证过的release身份自动续接或回旧版；不能依赖被杀进程的finally | 只处理可catch的异常；把重启后旧文件读到当作已恢复 |
| candidate启动失败、健康窗口内崩溃或Web资产不可用 | probation fence内停止已确认身份的candidate，切回last-known-good；旧服务健康验证后才标记rolled-back | 先释放队列/计划任务再验证；只复制文件就报回退完成 |
| 回滚自身中断，或旧版本也无法启动 | 有界续接同一回滚事务；预算耗尽进入recovery-required，保留恢复输入与原始失败原因。不能保证可用时如实提示 | 无限启动循环、删除唯一完整备份、假报“旧版已恢复” |
| ENOSPC、journal损坏或恢复输入不可读 | 接受更新前预检并预留恢复元数据空间；保留上一份可验证记录。无法可信恢复时拒绝切换/进一步写入，明确报告 | 覆盖最后一份有效记录、回写旧数据库快照抹掉新业务 |
| Node/npm prefix变化、旧服务注册缓存或跨实例锁 | 使用原部署manifest、Node绑定、scope和实际实例核对恢复；修复只限本事务目标 | 按shell默认prefix删另一套安装的锁或广泛pkill |

失败后的自动重试预算按目标releaseId持久化，重启不能清零；迟到子进程回执必须被已失效的写入代次拒绝。用户看见的终态是failed、rolled-back或recovery-required，不能永久保留失真的installing/完成提示。后两种失败仍保留候选及失败信息，不以修改订阅、关闭更新或隐藏通知冒充成功。

已提交的新服务若正在执行业务或送达状态不明，自动兜底不得强杀或重放输入。安全恢复无法证明时允许需要人工干预，但必须自动判定、终结等待并保留恢复输入；**自动化不等于无条件删锁，也不承诺磁盘/备份同时损坏后仍能恢复可用服务。**

## 6. 版本与页面只有一个真源

健康与更新检查使用同一不可变 `RuntimeIdentity`：`releaseId`、制品摘要、运行版本、实例启动身份。package.json 和 build-info 仍是构建输入，但发布时必须一致；本地 debug 制品也有完整身份，不能在页面比较时随意挑一种版本。

建议兼容 API：

```json
{
  "operationId": "opaque-operation-id",
  "phase": "verifying",
  "activeRelease": { "releaseId": "old-id", "version": "4.92.0" },
  "targetRelease": { "releaseId": "new-id", "version": "4.92.1" },
  "rollback": null,
  "error": null
}
```

- POST `/api/update` 返回 202 和 operationId。相同请求响应丢失后只能查询/附着，不能假定未开始就重发安装。
- `/api/update-status` 保留兼容字段，新增 operationId 查询和事务身份；状态必须跨 Server 重启可读。不要把“同版本的历史已完成记录”绑定为这次更新。
- 仅当**该 operationId 已 committed，且新实例实际 releaseId 匹配**，页面显示完成并刷新；verifying 不能提前完成，rolled-back 明确显示“更新失败，已回到旧版”。recovery-required 告诉用户真实恢复状态，不泛称成功。
- 通知卡片和设置按钮共用同一状态投影，异步“已开始”不能加成功样式。状态反馈在原按钮内，不新增硬切动画，遵循公共组件和 motion token。
- 提示根据 committed activeRelease 与候选比较；新候选晚于目标时仍允许正常提示。Beta/正式/本地 debug 顺序复用现有 comparator，不以关闭自动更新或修改订阅隐藏问题。
- 失败目标的自动重试预算按 releaseId 持久化，避免 Server 一重启就再次无限安装。手动重试允许新事务，仍保留失败原因；候选制品变了重新判断。
- 当前版本与前一版本的 Web 资产按摘要保留，避免长驻页面的迟到模块加载 404。刷新不清草稿或触发消息重发。

## 7. 数据与回滚边界

程序回滚**不等于**数据库回滚。当前项目要求迁移只加不删，但加列本身也不能保证旧代码理解新写入语义。

- 自动更新仅允许明确向后兼容、旧 release 可读写的迁移和数据格式；维护回滚兼容窗口及旧/新代码读取契约测试。
- live init 不再边运行旧 Server 边对生产数据做未知变更。生产迁移在旧服务退出、candidate fence 生效的维护阶段执行。
- 需要 SQLite 恢复输入时采用一致性 backup API，不能生拷贝数据库而遗漏 WAL。故障诊断备份不在已有新业务写入后自动覆盖生产库，避免抹掉用户数据。
- 不可逆或不兼容迁移不走无人值守更新，必须明确维护/恢复方案。磁盘损坏、备份同时损坏、权限丢失等无法承诺自动恢复；进入 recovery-required，保留证据而非假成功。
- GC 至少保留当前和上一份已验证版本，以及被事务/活进程/旧资产引用的版本。清理依赖 manifest 与真实使用状态，不匹配 `.wand-*` 前缀删除备份；先预检容量再接受安装。

## 8. 兼容迁移与实施顺序

这不是用户重装数据库。首次迁移需要可信 CLI 入口，后续 Web 不需额外提权。

1. **建立统一事务与 supervisor**：持久 journal、单一互斥、操作身份、制品身份和恢复状态；先在隔离 prefix 验证。不把这一阶段单独宣称为彻底修复，旧 in-place npm 尚未替换时仍存在硬中断窗口。
2. **迁移到版本目录**：验证正在运行的真实包和 Node，建立可用 old release；保护旧包的迟到导入。注册稳定启动器一次，保存原 scope/注册及 shim 恢复输入。旧包残缺时先建立已验证的 last-known-good，不能谎称可以回退。
3. **接入安装与 fence**：所有入口进入同一 controller，npm 只写 staging；加入 probation、健康提交、启动器 reconcile 和旧版健康验证。迁移过程中始终核实 Render/terminald PID 不变。
4. **接通 Web/API**：保留旧客户端字段和错误语义，统一 operationId 完成条件、版本提示和失败状态。`?reactUi=0` 下也走相同事务状态。
5. **验证后发布兼容引导器及 npm 包**：旧安装器不会因新包存在而自动修复；必须同时上线可下载的引导/恢复入口。没有排空协议的老版必须显式维护窗口，阻止新提交并核实执行结束；无法安全建立该边界时拒绝自动迁移。

服务注册涉及的现有授权在 CLI 维护入口完成，不给 Web 新增 sudo、自动审批或 daemon 强停能力。正常更新不调用完整 daemon/service 重装流程。各端原生包更新不在此次范围。

## 9. 必须通过的验收矩阵

| 故障注入 / 场景 | 必须满足 |
| --- | --- |
| 两个入口并发；POST 回执丢失后重试 | 一个真实事务；相同目标附着，不再重复安装；不同目标明确冲突 |
| registry、下载、Node、依赖、完整性、磁盘预检失败 | 旧包内容、current、旧服务 PID 均不变 |
| prepare / intent 落盘 / 停旧进程 / 指针切换 / candidate 启动 / commit / rollback 各点 SIGKILL | 重启后 journal 可解释、没有双实例；未提交恢复旧版，已提交续接，不残留永久忙状态 |
| 锁 owner 退出但 npm 写者尚活；旧目录锁无 owner；PID复用/EPERM | 自动识别可恢复与需要干预的状态；不删除live writer输入、不凭超时或PID不存在解锁 |
| 浏览器关闭、Web启动失败，无人工点击或状态请求 | supervisor仍自动恢复；人工移锁/运行恢复脚本不能算此项通过 |
| 超时、迟到子进程回执、同一失败目标重启多次 | 有限阶段/总预算、持久退避及写入代次阻断；不无限忙、不重放安装或模型输入 |
| journal损坏/ENOSPC、回滚自身再崩溃、旧服务启动失败 | 保留最后可验证恢复输入；有界续接或明确recovery-required，不假报可用 |
| 新版不能启动、HTTP 或资产故障、健康窗口内崩溃 | 自动回退，并实际验证旧版 HTTP/IPC/身份；旧版也不能启动则 recovery-required |
| candidate probation 期间新输入、排队和计划任务 | 不起跑模型；失败后队列由旧服务接续，不丢失、不重放未知送达 |
| migration 失败与旧版读取新 schema | 保留用户数据；旧版仍可读写；不使用旧 DB 快照抹新数据 |
| 同版本不同制品、debug/buildInfo 分歧、Beta 接正式再接新 Beta | 按制品身份验证；不假成功、不自动降级、不关闭订阅 |
| Web 重连/刷新、verifying、rolled-back、recovery-required、旧完成记录 | 只绑定本次 operationId；提示反映实际已提交版本与失败事实 |
| macOS launchd、Linux systemd、standalone 的真实注册及失败恢复 | scope/用户/Node 正确，manager 与 child 身份区分；Render/terminald 不中断 |
| 真实 registry 旧→新→再次更新 | 不能用目标 installer fixture 代替；证明外部用户实际能取得引导器与修复包 |

同时跑相关单测、真实浏览器、全量 check/test/build；实际托管故障注入先在隔离服务/配置完成，再对本机已安装服务做经授权的受影响流程验收。测试不调用付费模型、不安装原生设备、不发布未授权制品。

## 10. 本轮交付与待实施事项

本轮完成排查、隔离故障复现、真实安装态只读核对与此方案；没有改生产源码、安装锁、配置或服务生命周期。旧故障没有因本文被修复。

待实施的是第 2 节所有缺口及第 3–9 节合同，包含用户追加的第 5.1 节无人值守极端故障兜底；真实 macOS/Linux 托管回滚、断电/重启和真实 registry 更新均未进行新架构验收。详细过程与未实施边界同时记录在 `output/architecture-stage2/web-update-transaction/DELIVERY.md` 与架构工作日志。
