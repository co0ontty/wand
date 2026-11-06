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

## 监督范围更新

Prediction/预测下一条后续操作暂停：不实现、不登记新任务、不派发，不以其他路径或会话替代。MCP Apps 保留/下线未定，暂不修改。继续范围限于不相关的 K1、依赖和有界清理。K2 retention、凭据存储迁移及兼容后端退役仍不执行删除或生命周期变更。
