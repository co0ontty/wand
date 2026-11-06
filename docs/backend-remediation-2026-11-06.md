# 后端整改记录（2026-11-06）

本轮授权：只改源码、隔离验证和 Git 提交/push；不打 tag、不部署、不重启实际 Wand/客户端，不调用真实付费模型。真实服务最终验收尚未通过：需要部署新版本，用户本轮明确禁止部署/重启。

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
- 本批 `npm run typecheck`、`npm run check`、`npm run build` 通过；文档末尾空行导致首次 `git diff --check` 失败，修正后重跑。
