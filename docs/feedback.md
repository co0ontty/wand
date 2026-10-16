# 加密错误日志接口（v1）

实现顺序：先实现并验证收集端和中转接口，再让 Web、macOS、Android、iOS 接入。默认收集服务为 `https://feedback.huniu.fun:8443`。

## 数据与隐私边界

按用户要求保留**原始错误消息及错误堆栈**，不是只上报分类。只自动采集更新失败、服务端 5xx、WebSocket 异常和未处理运行异常；不收集聊天正文、用户输入、附件、完整 HTTP 请求/响应、环境变量或配置快照。

错误消息/堆栈中的已知凭据及明确的 Authorization、Cookie、密码、API key、token 值会替换为 `[REDACTED]`。这会改变包含凭据的片段，其他错误文本保留。错误文本可能包含文件路径等诊断信息。客户端不得把任意请求/响应正文作为错误堆栈上传。

## 1. 客户端 → 已连接的 Wand 服务

`POST /api/feedback/client`

- 使用客户端现有登录态或 Bearer app token，要求 `sessions` scope，不开放匿名日志中转。
- 请求 JSON 上限 32 KiB；消息上限 8 KiB、堆栈上限 16 KiB；超限返回 413。
- 客户端只请求当前连接的 Wand 服务，不向收集服务器发送 Wand 登录凭据；原始日志只在 HTTPS 或本机 loopback 连接上传，远端明文 HTTP 连接不传诊断。
- 日志中转失败不得影响原操作，不自动重放原业务请求。

```json
{
  "schema": 1,
  "source": "android",
  "event": "update_failed",
  "version": "4.99.0-beta.1",
  "feature": "app_update",
  "error": {
    "name": "IOException",
    "code": "ENOSPC",
    "message": "No space left on device",
    "stack": "java.io.IOException: No space left on device\n..."
  }
}
```

`source`：`web | macos | android | ios`。

`event`：`update_failed | provider_update_failed | daemon_update_failed | uncaught_exception | unhandled_rejection | http_5xx | websocket_error | startup_failed`。

`feature`、`error.code`、`error.stack` 可以省略；其余字段必填。不允许额外字段。客户端版本无法获取时使用 `0.0.0`。`feature` 是明确采集点声明的稳定功能代码，不解析错误文本关键词；省略时按事件类型兜底。

功能代码：`app_update` 应用更新、`server_update` 服务端更新、`provider_update` CLI 工具更新、`daemon_update` 底层组件更新、`api` 接口请求、`sessions` 会话、`conversations` 对话、`tasks` 任务、`files` 文件、`speech` 语音、`settings` 设置、`models` 模型、`authentication` 登录认证、`realtime` 实时连接、`runtime` 系统运行、`startup` 服务启动、`storage` 存储、`repository` 代码仓库。

用户名不由请求随意传入。中转服务在采集时读取**上报方 Wand 自定义个人名称 `userProfile.name`**，沿用 `userDisplayName()` 的默认名 `我`，写入内层密文报告的 `username`。不读取操作系统账号、设备名、员工名，也不使用收集主机的个人名称。改名热生效；已采集/排队报告保留当时姓名快照。

响应：`202 {"accepted":true}` 表示接受到本机有界队列，不表示中央服务器已收到；禁用时 `202 {"accepted":false}`。认证/权限失败 401/403，格式错误 400，体积超限 413，限频 429。

## 2. Wand 上报端 → 中央收集端

`GET /api/feedback/key`：仅启用接收功能的实例公开公钥，响应包含 `schema:1`、`algorithm:"RSA-OAEP-256+A256GCM"`、SPKI PEM `publicKey` 与公钥 DER SHA-256 `keyId`。

`POST /api/feedback`：匿名**密文**接收接口，只在显式配置私钥后开放。仅 HTTPS；公钥发现与上报均禁止重定向，使用系统 TLS 证书验证。公钥初次通过 HTTPS 信任，缓存到本机；不内置共享私钥，也不回退明文。

```json
{
  "schema": 1,
  "algorithm": "RSA-OAEP-256+A256GCM",
  "keyId": "公钥 DER 的 SHA-256 hex",
  "wrappedKey": "RSA-OAEP-SHA256 加密的随机 32 字节 AES 密钥，base64",
  "iv": "随机 12 字节，base64",
  "tag": "GCM 16 字节认证标签，base64",
  "ciphertext": "UTF-8 JSON 报告的 AES-256-GCM 密文，base64"
}
```

AAD 为 `wand-feedback:1:<keyId>`。每次新报告使用独立随机 AES 密钥和 IV；重试复用原密文和报告 UUID。RSA 支持 2048–4096 位。外层 JSON 上限 64 KiB，解密后的固定结构报告上限 32 KiB；不接受明文日志。

内层报告由服务端生成 UUID/时间，包含上报用户个人名称 `username`、稳定功能 `feature`、来源、服务端版本、客户端版本、平台、Node 版本，以及错误名称、错误码、原始消息和堆栈。接收端验证结构后将密文与任务投影在同一 SQLite 事务中保存，不保存 IP、请求头和原始错误明文。用户名、功能等必要任务元数据按普通任务字段存储。

响应：202 已接收或同 UUID 已存在；400 无效密文/报告；404 接收未启用；413 超限；429 限频；503 存储不可用；507 达到收集容量。

注意：公钥加密保护机密性及密文完整性，**不证明发送者身份**。公开接收端有每分钟 30 次 POST、120 次公钥查询的进程级总限额；生产反向代理还应限制连接/来源流量。

## 3. 自动创建/归并任务

所有通过验证并成功接收的日志，必须与以下投影**同事务**提交，不能出现“密文已保存却没有任务”：

1. 同一个稳定 `feature` 首次出现，创建普通待办任务，标题严格为 `【用户名】-【错误的功能】`，例如 `【小王】-【应用更新】`。不自动派发，不调用模型改标题。
2. 已有该功能关联任务时，保留原任务标题，在真实任务评论中追加 `【用户名】也遇到了相同的问题。`。按功能归并，不按姓名、平台、版本或错误文本归并。
3. 同一报告 UUID 的网络重试，不重复建任务或追加评论。不同报告属于同一功能，即使来自同名用户，也追加一次评论。
4. 任务被手工改名/完成/归档后仍复用并加评论，不擅自重开或执行；任务被明确删除后，下一条新报告重新建任务。旧 UUID 重试不复活已删除任务。

原始日志继续以密文保存，不复制到所有有任务权限的客户端。任务描述保留来源、版本、时间、报告 ID；管理员可按任务 ID 读取原始错误。

`GET /api/wand-tasks/:id/comments`：现有 `sessions` 权限，返回 `{comments:[{id,taskId,authorName,body,createdAt}]}`，最近 50 条、时间正序；任务不存在返回 404。各端在当前任务详情内只读展示，不另建整页评论系统。

## 4. 管理员查看

`GET /api/feedback/reports`，沿用 Wand 认证并要求管理员权限，返回最近 50 条报告的解密内容；可传 `?taskId=<任务UUID>` 查看该任务最近 50 条日志。`Cache-Control: no-store`。不提供匿名读取，不在控制台打印日志内容。

## 配置与部署

所有配置均为服务端进程环境变量，不改用户业务配置/schema：

- `WAND_FEEDBACK_URL`：收集端 HTTPS origin，默认 `https://feedback.huniu.fun:8443`，不能带账号密码、路径、查询参数。
- `WAND_FEEDBACK_ENABLED=0`：关闭本机上报（包括客户端中转）；`WAND_TEST_MODE=1` 也不联网。
- `WAND_FEEDBACK_PRIVATE_KEY_FILE`：仅在收集主机配置；未配置时不开放密文接收。私钥权限必须 0600。

收集主机上自行生成私钥，不在源码或上报客户端中放置私钥：

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /secure/path/feedback-private.pem
# 向收集主机的服务进程注入：
# WAND_FEEDBACK_PRIVATE_KEY_FILE=/secure/path/feedback-private.pem
```

反向代理需允许匿名访问 `GET /api/feedback/key` 与 `POST /api/feedback`，不要让站点登录拦截这两个路径；管理读取仍必须鉴权。部署与重启须单独遵守当前任务授权和已有排空屏障。

本机上报箱 `feedback-outbox/<收集地址哈希>/` 最多 100 条密文；无公钥时最多 20 条报告只保留内存。相同来源/错误类型去重 5 分钟，联网失败指数退避（1–30 分钟）。目录 0700，密文/缓存公钥文件 0600。正式服务的接收日志保存在 `feedback_reports`（密文）及 `feedback_task_features`（功能到任务的稳定关联）；评论在 `wand_task_comments`。最多 2000 条日志，满后拒收，不擅自删除历史。管理员应安排受控归档。独立收发测试可使用文件接收箱 `feedback-inbox/`，不替代正式服务的任务事务投影。

缓存公钥后，进程致命错误可在退出前同步加密落盘，下次启动补送；第一次公钥引导完成前的致命错误可能丢失。独立更新 helper 使用更新前复制的独立模块，因此服务退出/安装被替换后仍可报告；最多等待 5 秒，不改变原更新结果或 Server/Render 生命周期。

密钥轮换应保留旧私钥和旧报告；本版本不自动重加密已有密文，也不擅自删除/重置缓存。需要迁移公钥时，应先排空上报箱并安排运维切换。

## 当前验证/部署边界

- 初步实现（尚未扩展原始日志时）的 42 项定点测试通过，服务端 TypeScript 检查通过。
- 2026-10-16 对默认地址的 `/api/feedback/key` 探测返回 401；这不是收集成功。需在收集主机部署新接口及私钥并调整代理鉴权后再做真实加密往返验收。
- 尚未对本机已安装服务安装/重启，客户端适配及各端独立构建结果以最终交付记录为准。
