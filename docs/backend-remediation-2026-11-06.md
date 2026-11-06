# 后端整改记录（2026-11-06）

本轮授权：只改源码、隔离验证和 Git 提交/push；不打 tag、不部署、不重启实际 Wand/客户端，不调用真实付费模型。真实服务最终验收尚未通过：需要部署新版本，本轮尚未获得部署/重启授权。

## 输入与基线

完整阅读 `output/dot-backend-review-2026-11-06/Wand_后端架构与清理报告_2026-11-06.txt`；DOCX 可读，64474 字节，SHA-256 `173885fc58796289f009c7ba108eaff66b4901f3ce1b1ae7970772bca9ba43c5`。
`HEAD`、`master`、`origin/master`、`git ls-remote origin refs/heads/master` 初始均为 `17354e6fc647a4146954cc12f8a3eea28454ecd7`。各子模块工作区干净；保留既存未跟踪 `.wand-build-lock-reviewed-2026-11-04T22-49-42-252Z/`，不纳入提交。

## 第一批：S1/S2

修改 `src/server-auth-routes.ts`、`src/auth.ts`、`src/ws-broadcast.ts`。

- S1 保留有效 app token 优先和失败后的密码回退；实际提供错误密码的混合请求累计失败，纯 stale token 不累计；仅成功管理员密码认证重置密码桶，有效低权限 token 登录不重置。
- S2 AuthService 提供单 token / 全量撤销通知；WS 固定握手选中的认证来源，单 token 撤销只断其所有 socket，全量撤销包含 Bearer socket。消息入口、心跳及业务发送出口校验有效性，清空撤权后的队列与延迟 resync，避免关闭与消息到达竞争。Cookie 校验复用内存认证缓存。
- 不改 token 存储格式、权限配置、daemon 生命周期或输入交付协议。

验证（Node 24.21.0，临时 SQLite、回环随机端口、计数式输入 fixture，无执行器或模型）：

- `node_modules/.bin/tsx output/dot-backend-review-2026-11-06/security-fixture.mts --baseline`：基线复现通过；第 11 次混合失败仍 401；logout 后同 token 两 socket 共发生 2 次输入、2 次 resize；TTL 后仍 1 次输入；全量撤销后 Cookie/Bearer 共 2 次输入。
- 同 fixture 不带 `--baseline`：修复隔离检查通过；上述未授权输入/resize 全为 0，不同 token 仍可输入；密码变更撤权后输入为 0；纯 stale token 重试和混合正确密码兼容通过。
- fixture 初次启动因误用 `createAppToken` 导出失败，改为真实 `generateAppToken` 后才完成上述复现；未触及实际服务。
- `npm run typecheck`、`npm run check`、`npm run build`、`git diff --check`：通过。
- fixture 保存在本机报告目录，非恢复 `tests/` 套件。所有凭据均为 fixture 合成值，未输出真实凭据。

### 独立复核补修

首批提交 `cd1b3c9df09018b773f6f82e99343fe9e84d1272` 后，监督新增三项失败：低权限 token 可重置密码桶、同步快照准备跨 TTL 后 missing-session 仍发送、batch 第一帧后跨 TTL 仍发后两帧。

- `src/server-auth-routes.ts`：重置只位于实际管理员密码验证成功分支。
- `src/ws-broadcast.ts`：所有 direct send 收敛到 `sendAuthorizedFrame`，在序列化/快照准备后、每帧实际进入传输层前校验；协议 ping 同样补末端检查。不承诺撤回已进入传输层的帧。
- `tsx /tmp/wand-security-review/review.mts`：15/15 通过，含上述三项。证据 `/tmp/wand-security-review/fixed.log`。原隔离 HTTP/WS fixture 复跑通过。
- 人工时钟跨界只证明精确边界，未证明生产存在同等大小窗口。manager 单独全量撤销的基线失败不等于生产改密漏洞；生产改密原本已有显式 disconnectAll。

提交 SHA 与远端核对在本会话逐批报告；不在本文件写自身提交 SHA，避免自引用。

## 第三批：C1/C2/C3 契约核对

- C1 仍存在 Web 请求和 UI，但 `src/server*.ts` 没有 Prediction / MCP Apps 路由；不是可直接删除的死代码。阻塞选择：A 恢复已有能力（需要明确模型费用授权、可用 Codex 协议及面板安全/回收契约）；B 完整退役（需明确批准移除 UI/客户端契约）。本轮未擅自接入付费执行或删除产品入口。
- C2 两入口确实共享 StructuredSessionManager.sendMessage；通用入口额外承担 expectedQuestionId、异步接受/202、Pi autoResources、PTY 恢复、not-sent 重试，结构化入口承担同步结果和独立 conflict 映射。未发现可以确定为接口漂移的证据，保留两种外部语义，不为减少行数改写输入交付机制。
- C3 修改 `scripts/capture-structured-cli-fixtures.ts` 和 `src/structured-qoder-adapter.ts`：保留历史录制能力，明确标注 legacy stream-json，不宣称代表生产 ACP；Qoder 从默认真实录制列表移出，须显式 `--only=qoder --legacy-qoder --record`；输出标记 `validatesProductionAcp: false`。
- `tsx scripts/capture-structured-cli-fixtures.ts --record --only=qoder`：预期在 spawn 前拒绝（退出 1），检查通过；未运行任何 provider CLI。ACP 真实录制未运行（无付费模型授权）。

## 第四批：Q1 窄查询 / Q2 初始基线

修改 `src/storage/sessions-repository.ts`、`src/session-registry.ts`、`src/server.ts`。

- 启动发现改用只取 running PTY ID 的 SQL，仍包含 archived 但 running 的旧 owner；ownerOf 的存储兜底改为 SELECT 1，不加载消息也不触发旧消息迁移。保留 structured → PTY → storage 优先级。
- `tsx output/dot-backend-review-2026-11-06/query-fixture.mts`：通过；临时 SQLite 固定 80 会话、2 running（其中 1 structured）、包含 archived running，历史从每会话 0 到 20,000 字符。旧发现加载消息 80 次，窄查询 0 次；旧发现 49.892/81.453 ms，新查询 0.044/0.154 ms；80 次 owner 查询旧 4.348/8.049 ms，新 0.515/0.444 ms。缺失会话返回 null。
- 这是单进程合成微基准，不是全服务启动收益；maxRSS 是同一进程累计峰值（约 113–132 MiB），不能据此声称节省了多少内存。
- Q2 记录 40/500 turn 简单文本的投影、二次 enrich、cache hit 与无关设置写入：500 turn 依次约 0.337/0.251/0.081/0.197 ms。简单文本二次 enrich 等价，但尚不足以覆盖跨 turn 决策、迟到结果、图片/compact/窗口边界；本轮不据此删除 enrich 或重写缓存。A2 同样没有生命周期基线支持拆整层；只通过本批窄 repository 查询减少读取面。
- 本批 `npm run typecheck`、`npm run check`、`npm run build` 通过；文档末尾空行导致首次 `git diff --check` 失败，修正后重跑通过。

## 第五批：K1 统一写入与受支持调用方

修改 `src/storage/knowledge-repository.ts`、`src/storage/employees-repository.ts`、`src/server-employee-routes.ts`、`src/employee-knowledge-cli.ts`、`src/employee-knowledge-types.ts`、`src/web-ui/react/knowledge/repository.ts`、`src/web-ui/react/agents/employee-knowledge.tsx`。

- EmployeeRepository 保留兼容方法，但委托 KnowledgeRepository 创建/删除；不再直接写 employee_knowledge。旧读 DTO 增加 revision，保持按创建时间倒序、正文 Unicode 搜索、去重与配额。
- 旧单条 DELETE 接受 `{revision}`，缺失/过期 revision 返回明确 409；CLI legacy capability 分支同样转交 `--revision`，不跳过版本检查。权限/员工选择不变。
- 旧批量 DELETE 接受 `{entries:[{id,revision}]}`。事务内先验证整份快照再删除；任何条目冲突整批回滚；提交前新增加但不在快照中的知识保留，响应返回真实剩余列表，不冒充清空。空快照不删任何条目；缺快照不执行。
- Web `EmployeeKnowledge.clear` 现在传入已读取的 `view.entries`，namespace 不匹配不提交；共享 repository 序列化 id/revision。更新确认说明，不改变控件或动效。普通 Web 单条删除原本已走新 API 并携带 revision。
- 本机已检出 Android：`android/app/src/main/java/com/wand/app/data/WandApi.kt:184–199`；iOS：`ios/Wand/KnowledgeLibrary.swift:84–123`；macOS：`macos/Wand/KnowledgeLibrary.swift:84–123`，均走 `/api/knowledge`，删除已携带 revision，未发现旧知识删除/清空调用，无需为本批改客户端或构建原生包。此为源码兼容核对，不是原生运行验收。
- 未知历史客户端仍可能调用旧无 revision 删除，安全契约是返回 409、保留数据，需读取并提交 revision；不静默采用服务端最新版本代删，也不宣布旧 API 退役。

验证：`tsx output/dot-backend-review-2026-11-06/knowledge-fixture.mts` 通过。临时数据库和回环 HTTP，真实新旧路由、Web repository、CLI 子进程：旧读→新改→旧删 409；新旧正常添加/删除；Web 普通删除和清空快照；新增条目保留；整批冲突原子性；跨员工拒绝；Unicode 搜索；重复正文；200 条配额；旧/新 capability CLI 正常删除；修改后旧 capability 迟到写入被拒；员工删除后写入被拒。未读取任何真实员工知识或聊天。

本批 `npm run typecheck` 初次发现 Web 调用方缺 snapshot 参数，修正真实组件调用后 `typecheck`、`check`、`build` 全通过，`git diff --check` 通过。真实安装服务 / 浏览器按钮 / 原生运行验收未运行，受本轮未部署限制。

## 第六批：D1/D2 直接依赖清理

- 仅移除 Wand 的 `pi-agent-browser-native` 直接依赖；manifest/lock 共删除 65 行、3 个安装位置，不改全局 Pi 或用户独立扩展。仓库源码、脚本、CI、文档及三个 bin 名无消费者；本机资源配置无该包和 Wand node_modules 路径引用；对 12 项已配置扩展包做有界源码核验（1,199 文件），无候选引用。未读取私人聊天、知识正文、auth.json 或 models.json。
- 解除该包 Node >=24.21.0 与 Wand >=22.19.0 的直接声明冲突；不提高 Wand 最低版本。未声称整个传递闭包已全面通过最低版本验证。
- `npm uninstall pi-agent-browser-native --ignore-scripts --no-audit --no-fund`：移除 3 包；`npm run typecheck`、`npm run check`、`npm run build`、`git diff --check` 通过。
- `npm pack --ignore-scripts --pack-destination output/dot-backend-review-2026-11-06/packed-d1 --json`：通过。随机 `/tmp/wand-d1-production.*` 中干净 `npm install --omit=dev --no-audit --no-fund <tgz>`：安装 214 包成功。npm 报告 node-pty/esbuild/@google/genai/protobufjs 四项安装脚本尚未 allow；未批准、绕过或重试脚本执行。
- packed CLI `--help`、server/storage/auth/ws-broadcast/models 模块导入、临时 SQLite、认证创建/撤销及 Q1 查询：Node 24.21.0 与最低 Node 22.19.0 均通过；证据脚本 `output/dot-backend-review-2026-11-06/packed-smoke.mjs`。22.19.0 通过隔离 npm exec 获取，未更改全局 Node 或服务配置。
- 未完成：packed 服务 HTTP/WS 全流程、node-pty 实际 spawn、已配置扩展实际加载及真实服务验收；不能把导入通过等同于这些流程通过。安装脚本权限保持原样。
- C5 两个兼容 shim 暂留：仓内无引用，但发布包公开 deep-import 外部消费者尚未核实。D3/D4 尚未改动。

## 第七批：依赖与最终回归复核

### D3：保留 marked 生产依赖（未提交分类变更）

源码仅 Web 聊天 Markdown 与文件预览直接引用，浏览器构建 bundle:true；不能因此推断所有已发布叶模块均无运行依赖。最终 packed artifact 含 `dist/web-ui/markdown.js`（bare marked import）及 `.d.ts`（只引用 MessageFileContext，不直接 import marked）。manifest 发布 dist 且无 exports 封装；未取得明确的叶模块支持/退役契约。本轮选择保留显式生产依赖 ^18.0.14，不删除路径、不借 Pi 的 marked 18.0.11 hoist。此为有界兼容取舍，不宣称已证明后端入口需要 marked，也不把所有 dist 叶模块永远锁定为公共 API。

分类实验的 npm 命令曾解析到 18.1.3；已恢复原 18.0.14 和原范围，最终 diff 无 marked 改动。`markdown-fixture.mts` 的聊天/预览标题、强调、代码、表格、相对文件、恶意 HTML/链接通过。首次 fixture 表格断言漏考虑 class，修正断言后通过。最终生产包真实 markdown.js 导入和表格渲染通过。浏览器资产打包/预算通过，真实浏览器功能验收未运行，不以源码 fixture 代替。

### D4：显式 Anthropic SDK 对齐

package.json/package-lock.json 将直接 SDK 从 ^0.81.0 对齐到精确 0.129.0，与 Pi AI 1.0.2 的要求一致；锁图由两份变一份。八项 @earendil-works/* 1.0.2 pins 逐项对比未改。模型目录生产适配器源码未改，保留 CLI/Core 隔离。

`HOME=<新临时空目录> tsx output/dot-backend-review-2026-11-06/sdk-fixture.mts`：本地 HTTP + fake commandRunner，无真实 CLI/付费模型：
- 真实生产 ModelCatalogService + 默认 SDK 适配器：baseURL 子路径、两页 auto-pagination；401 fallback（1 请求），429/500 fallback（各 3 请求，包含 SDK 默认重试）通过。
- SDK timeout=40ms/maxRetries=0，经现有 modelsApi 注入接入真实目录服务：超时、连接断开均保留持久缓存，通过。这是短超时 fixture，不宣称生产默认十分钟 timeout 已实等完。
- 无凭据请求在网络发送前拒绝。初次错误假设构造函数立刻拒绝，实际校验在发请求时；修正 fixture 后通过。

### 最终产物和回归

- `npm run typecheck`、`npm run check`、`npm run build`：通过，日志 `/tmp/wand-final-{typecheck,check,build}.log`。
- `/tmp/wand-security-review/review.mts`、本机 `security-fixture.mts`、`query-fixture.mts`、`knowledge-fixture.mts`：最终依赖变更后全部退出 0；日志 `/tmp/wand-final-{security,http-security,query,knowledge}.log`。本机最终复跑当前独立 review.mts 为 18/18（日志已逐项读取核对）；监督另确认 Q1 owner 优先级等检查。
- `npm pack --ignore-scripts`：1,141 文件，8,115,816 bytes（解包 19,767,430 bytes）。清单 `/tmp/wand-final-pack.json`，包在 `output/dot-backend-review-2026-11-06/packed-final/`。
- `/tmp/wand-final-production.YJ5Ws0` 全新 `npm install --omit=dev --ignore-scripts --no-audit --no-fund <tgz>`：213 包；明确跳过脚本，不宣称完整生命周期安装通过。
- 最终生产包 Node 22.19.0 / 24.21.0：server/models/ws 导入、临时 SQLite、auth create/revoke、Q1 查询通过。ESM 逐项解析全部直接生产依赖均在临时目录，固定 Pi SDK import 通过（不是扩展实际加载）。初次以 require.resolve 检查 ESM-only Pi 报 ERR_PACKAGE_PATH_NOT_EXPORTED，改用真实 ESM 解析后通过，不是产品故障。失败发生在同一 bash 调用的第三段 CJS 解析检查，不是此前两个 Node 版本的 packed-smoke.mjs；后者均退出 0。packed-smoke 修改仅允许传最终目录路径，未移除断言。
- 实际 PTY spawn、实际配置扩展加载、真实已安装服务和浏览器验收未运行。没有借其他目录二进制、手动跑安装脚本、改 npm allowScripts 或换安装器。

### 安装脚本授权请求（未执行）

已向监督提交，等待用户明确许可；拟仅限临时验收安装，源码来自 npm lock 所记 registry.npmmirror.com：

| 包 | 精确命令 | 行为与风险 |
| --- | --- | --- |
| node-pty 1.1.0 | `node scripts/prebuild.js || node-gyp rebuild`；`node scripts/post-install.js` | 检查 prebuild，必要时编译；清理包内 build/Release 非保留文件。可能下载 Node headers / 写编译缓存。 |
| esbuild 0.28.2 | `node install.js` | 配置并校验二进制，缺失时可能 npm 或 registry.npmjs.org 下载，写包内文件并运行版本检查。 |
| @google/genai 2.21.0 | `echo 'preinstall: no-op'` | 只输出提示。 |
| protobufjs 7.6.6 | `node scripts/postinstall` | 读包元数据并打印版本兼容警告。 |

未设置全局/持久白名单。原目录 `/tmp/wand-d1-production.DKHPug`，最终目录如上；编译/下载可能写用户缓存，不能声称所有副作用只在临时目录。收到授权前不执行；实际 PTY 如获准也只新建隔离子进程，绝不向真实 owner 输入。

## 原报告逐项状态（不等同整体验收通过）

| 编号 | 当前分类 | 证据或具体剩余边界 |
| --- | --- | --- |
| S1/S2 | 已修且隔离验证 | 最终安全回归通过；真实服务未部署。生产改密原有 disconnectAll，不夸大基线。 |
| C1 Prediction | 需要用户决策/权限 | 暂停，不实现、不登记、不派发；独立整改验收之前不得开始。 |
| C1 MCP Apps | 需要用户决策/权限 | 恢复或完整下线未定；无路由与现有 UI 的契约问题尚未闭环。 |
| C2 | 确认保留且证据充分 | 两路共享 sendMessage，但 202/问题 ID/Pi autoResources/PTY 恢复与错误映射不同；无确定接口漂移，保留语义，不盲合并。未改代码。 |
| C3 | 已修且验证 | 旧录制显式 legacy、默认不录 Qoder，spawn 前 guard 通过；没有声称 ACP 真实执行通过。 |
| D1/D2 | 未完成 | 已删闲置依赖、构建/最低 Node 入口通过；实际 PTY/扩展与安装脚本授权仍缺。 |
| D3 | 确认保留且证据充分（本轮保守分类） | Web bundle 是主消费者，但已发布 JS 叶模块可加载且依赖 marked；没有必要为减包改变未经确认的路径契约。 |
| D4 | 已修且隔离验证 | 显式 SDK 0.129.0 与 Pi 对齐，分页/baseURL/失败 fallback 通过；无真实模型调用。 |
| C4 host-boot | 需要兼容证据，保留 | 仓内无生产调用；发布 JS/d.ts 真实存在，涉及 PID/重启所有权；未证明外部消费者与替代覆盖，不能凭零引用删除。 |
| C4 codex-image-content | 需要兼容证据，保留 | 仓内无外部调用；发布 JS/d.ts 真实存在；未验证当前图片链路全部替代、未取得产品退役决定。 |
| C4 platform-action 三模块 | 需要产品/兼容决定，保留 | service 明示未接 HTTP/CLI，内部引用 catalog/types；三个均已发布，不能把未接线骨架擅自当已退役。 |
| C5 两个 shim | 需要兼容证据，保留 | 仓内调用已转 subagent-meta/local-model-process，shim 明确标注 compatibility 且发布 JS/d.ts；未知外部 deep-import，收益仅 4 行，不盲删。 |
| Q1 | 已修且验证 | 零消息加载、归档 running/owner 优先级监督已复核；最终 fixture 复跑通过。 |
| Q2 | 未完成基线，不改架构 | 简单文本微基准不足以覆盖跨 turn/迟到/窗口；保留 enrich 与缓存，不把大改视为必要清理。 |
| K1 | 已修且隔离验证 | 新旧 API/CLI/Web repository、revision、快照、归属与迟到写入通过；原生源码兼容已核对，真实按钮/客户端运行未验。 |
| K2 | 需要用户决策 | retention 天数/条数/容量、员工删除语义、审计保全与写失败策略未定；不删记录。 |
| A1 | 需要用户决策 | 密码 hash 迁移需解耦设备 token，决定旧设备继续有效/重配及回滚窗口；不改凭据。 |
| A2 | 未完成基线，保留现层次 | 未取得 stop/delete/迟到 callback/Core drain 全套行为及性能基线，无证据支持整层拆写；只完成 Q1 窄查询增量。 |
| R1 | 确认保留且证据充分 | 多 owner 恢复、unknown delivery 与历史迁移仍有职责；没有 owner 归零/支持矩阵/回滚窗口证据，不退休后端或删除历史列。 |

C4/C5 核对覆盖源码、脚本、CI、文档及已检出 Android/iOS/macOS，搜索文件名与导出标识符（含 hostBootId、belongsToPreviousHostBoot、readCodexImagePart、codexInlineImagePart、PlatformActionRegistry）；没有把搜索无命中等同外部契约证明。

### 只读统计（本轮采样，不读取正文）

直接以 SQLite readOnly + query_only 打开默认本机数据库，只返回聚合：execution_prompts 9 条、record JSON 合计 69,905 bytes、孤儿员工记录 0；command_sessions 438 条、非空旧 messages 39 条、format_version=1 的 normalized heads 438 条。未输出 prompt/聊天/员工身份/凭据，不运行迁移。单点采样不能计算增长率；存在旧 payload 不等于可删。旧 owner 实时 inventory 与 A1 凭据分布未读取，不以 UI idle 或数据库状态替代真实运行所有权。

## 第八批：隔离运行补验与可追溯重建（仅验收文档提交）

本节更新上文“未尝试运行”的状态，不追溯改写旧产物来源。实现代码 SHA 为 `18819ad6b691daabe4d38558a31f48b4a8836471`；后续本节文档提交不是构建输入，不声称产物由文档提交生成。

### 现有最终安装目录的 PTY 唯一一次尝试

对象：`/tmp/wand-final-production.YJ5Ws0`，安装来源旧 packed-final 包 SHA-256 `2b73de1dd5c085ec2664d222031497eee9ab791ff84634928a57aadf99c98271`（旧 stamp 是 2694a29，不称干净 18819ad 产物）。

`node /tmp/wand-final-production.YJ5Ws0/pty-acceptance.mjs`：**失败**，公开 node-pty API 的 spawn(`/bin/sh`, [`-c`, `printf WAND_PACKED_PTY_OK`]) 抛出 `Error: posix_spawnp failed.`，没有 code 值，退出 1。临时 cwd，env 仅 HOME/TMPDIR/PATH/TERM 合成值，不继承凭据；不接已有会话、不写输入。失败后立即停止，未 chmod、rebuild、执行 lifecycle scripts、另找二进制或重试。日志 `/tmp/wand-final-pty.log`。当前不能从这条错误单独证明具体是权限或缺失文件；不猜测根因。

### 现有 packed 模块真实网络验证

`node /tmp/wand-final-production.YJ5Ws0/network-acceptance.mjs`：**通过**，直接 import 已安装 dist 的 auth/routes/WS/storage；Express/WS 也从生产安装目录解析。临时 SQLite、回环随机端口、fake execution port：HTTP 登录/注销、认证 metadata（显式隔离 fixture 路由）、WS init、允许输入、同 token 两连接撤权、不同 token 隔离、全部撤权、自然 TTL 均通过；有效输入计数 2，未授权输入计数 0。未启动完整生产 server、daemon 或模型。日志 `/tmp/wand-final-network.log`。这是真实网络的 packed 组件集成，不是 source fixture，也不是完整 Web 服务验收。

### 干净实现 SHA 重新构建/打包

构建前后 `git diff --quiet` / tracked status 干净，只保留指定未跟踪目录。执行 `npm run build`、`npm pack --ignore-scripts --pack-destination output/dot-backend-review-2026-11-06/packed-18819ad --json`：通过。

- 实现 SHA：`18819ad6b691daabe4d38558a31f48b4a8836471`
- 包：`output/dot-backend-review-2026-11-06/packed-18819ad/co0ontty-wand-4.107.1.tgz`
- SHA-256：`5f6f1f5d964b36ee2023f3877cd86471d4923a6963606a56e312c1d52473ec41`
- 包内 `dist/build-info.json`：commit 同上，builtAt `2026-11-06T01:12:56.146Z`，version `4.107.1`，channel `stable`。channel 是构建元数据，不代表发布。

未重新 npm install。新包解压到 `/tmp/wand-final-production.YJ5Ws0/artifact-18819ad/package/`，使用上级已存在的临时生产 node_modules。只更换受验包代码，不借用其他原生二进制，不再次尝试 PTY。

- `node .../network-acceptance.mjs ./artifact-18819ad/package/`：新包真实网络流程通过；日志 `/tmp/wand-18819ad-network.log`。
- `node .../artifact-18819ad/package/artifact-smoke.mjs` 与已缓存 `npm exec --offline --yes --package=node@22.19.0 -- node .../artifact-smoke.mjs`：Node 24.21.0 / 22.19.0 均通过；强断言包内 stamp、显式 SDK/marked 和全部 Pi pins、生产依赖解析、临时 SQLite/auth/metadata、packed Markdown 标题/强调/表格/代码及危险 HTML/URL。日志 `/tmp/wand-18819ad-smoke24.log`、`/tmp/wand-18819ad-smoke22.log`。
- 新包没有重复干净安装；其依赖沿用先前已核验临时目录。旧包安装证据与新包代码运行证据分别记录，不能混称一次全新 lifecycle 安装。

### 已配置扩展入口与实际加载边界

只读取资源 manifest 和有界扩展源码，未 import 执行以下入口。12 项配置中 `@sentiolabs/pi-frontend-design` 无扩展入口，其余 11 个声明为：

| 包/版本 | 相对包根的入口 |
| --- | --- |
| pi-web-access 0.42.0 | `dist`（已发现 index.js 与 mcp-cli.js，具体目录发现规则仍须沿 Pi loader 核对） |
| pi-subagents 0.79.1 | `index.js`，按 env 动态导入 extension/index 或 herdr bridge |
| @juicesharp/rpiv-todo 2.13.9 | `index.ts` |
| pi-image-paste 1.0.0 | `src/index.ts` |
| pi-dynamic-workflows 1.0.1 | `extensions/workflow.ts` |
| @injaneity/pi-computer-use 0.5.1 | `extensions`（computer-use.ts） |
| pi-advisor 0.3.0 | `index.ts` |
| pi-team 0.6.11 | `src/index.ts` |
| pi-goal-x 0.32.3 | `extensions/goal.ts` |
| pi-cc-extensions 1.0.8 | `extensions/index.ts` |
| pi-context-view 0.7.2 | `src/index.ts` |

具体源码证据：pi-advisor/index.ts:213 初始化 loadConfig，session_start 重新读取配置并调整工具注册；pi-team/src/index.ts:260 的 session_start 枚举 cwd 团队运行、读状态并启动 monitor；pi-web-access/dist/index.js 包含 fetchWithCredentialRedirects、curl spawn、gh execFile 与环境/配置路径；computer-use.ts 注册 launch_browser 和系统 UI 操作并处理 session_start；image-paste 注册 session_start/input/shutdown；workflow 注册工具并在 session_start 修改活动工具集合。这里不是说所有行为都在 import 时立即发生，而是加载+生命周期不是无副作用静态读取。仅换 HOME 也不足以证明转义绝对路径、OS 凭据或子进程副作用被阻断。

最小许可请求：允许逐个入口在临时 HOME/agentDir/cwd、无凭据环境且有实际网络/子进程阻断的隔离进程中做注册加载（不用真实 session_start/工具调用），按结果再申请必要生命周期。尚未建立并验证此阻断环境，因此未加载；不能把“manifest 可读 / SDK 可导入”写成实际扩展加载通过，也不使用加载检查派发 agent 或付费模型。

结论：新包隔离网络已通过；PTY 已真实尝试并失败；扩展注册执行、浏览器完整功能和真实服务未验。四项 lifecycle scripts 仍未执行。D4 不继续换 fetch 或删除显式 SDK，等待用户具体选择。整体仍未通过，不进入 Prediction。

## 监督范围更新

Prediction/预测下一条后续操作暂停：不实现、不登记新任务、不派发，不以其他路径或会话替代。MCP Apps 保留/下线未定，暂不修改。继续范围限于不相关的 K1、依赖和有界清理。K2 retention、凭据存储迁移及兼容后端退役仍不执行删除或生命周期变更。
