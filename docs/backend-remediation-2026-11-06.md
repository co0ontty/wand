# 后端整改记录（2026-11-06）

本轮授权：只改源码、隔离验证和 Git 提交/push；不打 tag、不部署、不重启实际 Wand/客户端，不调用真实付费模型。真实服务最终验收尚未通过：需要部署新版本，用户本轮明确禁止部署/重启。

## 输入与基线

完整阅读 `output/dot-backend-review-2026-11-06/Wand_后端架构与清理报告_2026-11-06.txt`；DOCX 可读，64474 字节，SHA-256 `173885fc58796289f009c7ba108eaff66b4901f3ce1b1ae7970772bca9ba43c5`。
`HEAD`、`master`、`origin/master`、`git ls-remote origin refs/heads/master` 初始均为 `17354e6fc647a4146954cc12f8a3eea28454ecd7`。各子模块工作区干净；保留既存未跟踪 `.wand-build-lock-reviewed-2026-11-04T22-49-42-252Z/`，不纳入提交。

## 第一批：S1/S2

修改 `src/server-auth-routes.ts`、`src/auth.ts`、`src/ws-broadcast.ts`。

- S1 保留有效 app token 优先和失败后的密码回退；实际提供错误密码的混合请求累计失败，纯 stale token 不累计；成功仍重置密码桶。
- S2 AuthService 提供单 token / 全量撤销通知；WS 固定握手选中的认证来源，单 token 撤销只断其所有 socket，全量撤销包含 Bearer socket。消息入口、心跳及业务发送出口校验有效性，清空撤权后的队列与延迟 resync，避免关闭与消息到达竞争。Cookie 校验复用内存认证缓存。
- 不改 token 存储格式、权限配置、daemon 生命周期或输入交付协议。

验证（Node 24.21.0，临时 SQLite、回环随机端口、计数式输入 fixture，无执行器或模型）：

- `node_modules/.bin/tsx output/dot-backend-review-2026-11-06/security-fixture.mts --baseline`：基线复现通过；第 11 次混合失败仍 401；logout 后同 token 两 socket 共发生 2 次输入、2 次 resize；TTL 后仍 1 次输入；全量撤销后 Cookie/Bearer 共 2 次输入。
- 同 fixture 不带 `--baseline`：修复隔离检查通过；上述未授权输入/resize 全为 0，不同 token 仍可输入；密码变更撤权后输入为 0；纯 stale token 重试和混合正确密码兼容通过。
- fixture 初次启动因误用 `createAppToken` 导出失败，改为真实 `generateAppToken` 后才完成上述复现；未触及实际服务。
- `npm run typecheck`、`npm run check`、`npm run build`、`git diff --check`：通过。
- fixture 保存在本机报告目录，非恢复 `tests/` 套件。所有凭据均为 fixture 合成值，未输出真实凭据。

提交 SHA 与远端核对在本会话逐批报告；不在本文件写自身提交 SHA，避免自引用。
