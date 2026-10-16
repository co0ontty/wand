# CLI / skill 一次性网页登录

TASK-69：本机可信所有者 CLI 为用户授权的界面自动化签发短时票据，通过真实网页登录表单建立 HttpOnly 登录 Cookie。不是管理员免密入口，也不使用 App 长期连接码代替一次性密钥。

## 入口

- `wand web-login:issue --stdin`：`{"requestId":"<UUID>","origin":"https://wand.example:8443"}`。只允许提供的 skill 内存助手以匿名进程管道接收，普通终端/调试环境默认拒绝。
- `wand web-login:cancel --stdin`：`{"requestId":"<原UUID>"}`。取消未消费票据，不撤销已消费的 Cookie。
- `wand-system/scripts/web-login.mjs`：`loginWithWebTicket(page,{origin,signal})`，传入专用 Playwright Page，从可见页面选择「一次性票据」、填写遮罩输入并点击原「进入控制台」按钮。已有登录态不签发。
- Web、`?reactUi=0` 和原生 WebView 共用入口；复用 Ant Segmented/Input.Password，切换前后按钮原位，提交后同步清空原生DOM及Ant内部状态。

## 执行主体与授权边界

签发/取消沿用 WandCliApi 的本机所有者认证；长期密码只在既有 CLI 内存认证通道使用，不回显、不放 argv。路由额外要求管理员、socket回环来源，且没有 Origin/Sec-Fetch-Site/Forwarded/X-Forwarded-*。App token、扩展、浏览器和反代即使已登录也不能签发。

每轮员工runner由服务注入独立的随机执行证明，服务内存将证明绑定当前员工/会话；完成、取消、改密或重启即撤销。CLI只在请求头的内存通道传递证明，服务由证明解析主体，**不把调用者提供的非秘密session ID/环境ID当作身份证明**，也不复用知识库/决策token。stdin不能另选员工/会话/scopes/模式/TTL。服务再核对真实运行所有者；签发及消费时必须仍在运行、未归档且身份不变。**升级前已在执行的回合没有新证明，要等新一轮员工执行才能签发，不能降为local-owner或手填他人ID。**

消费后的 Cookie 固定为 connected-app / sessions，并在同一 AuthPrincipal 中保留 `webSession={sessionId,employeeId}`。HTTP 鉴权边界只允许：

- GET 安全配置（返回明确只读能力）以及只包含该员工当前这一个会话的会话列表/分页列表；
- GET 这一个会话的详情、消息与工具内容；
- 正常会话探测与登出。

其他会话（包括同员工的另一个会话）、员工定义/知识/私聊、任务/工作区、文件/密码库/设置/管理接口、所有写操作和未来新增路由一律403。不能修改权限、发送/排队/停止、创建会话或执行任务。列表分页的总数/版本也在过滤后计算，不泄漏全局元数据。WebSocket 原通道包含工作台全局广播，因此 scoped Cookie 在握手后立即被拒绝且不接收任何帧；客户端只通过受限HTTP轮询。输入框显示明确只读提示。

**不是只靠“没有admin”或者提示词来限制员工权限。** 后续如需任务编辑/管理页等更广范围，必须另行设计明确的资源授权，不能静默扩大本票据能力。正常原生App、浏览器密码登录及其既有scope不变。

## 生命周期与失败

- 票据随机32字节、60秒，绑定精确origin；仅HTTPS，回环允许HTTP，publicOrigin配置存在时必须匹配。消费同时校验请求Origin、实际服务origin及Sec-Fetch-Site。
- 服务内存只存票据摘要，同步检查并烧毁，无await竞争窗口；并发最多一次成功。原票据不进入URL、历史、文件、日志、知识或Cookie。
- requestId已处理/取消墓碑保留12小时，重复请求返回409而不重发；取消先到也阻止迟到签发。内存上限4096，消费独立有界限流。
- 改密/撤销全部登录、服务重启及释放清空票据。签发后主体结束/改变拒绝消费。
- Cookie 也保留执行主体限制，最长12小时；不持久化成只有scope而没有主体的数据。**服务重启后需要新的票据登录**，不能恢复为更宽权限。Storage显式拒绝保存丢失主体的scoped session；早期原型已签发的无主体sessions-only Cookie升级后拒绝认证，无需删除用户历史或正常登录态。
- Cookie 使用期间每次鉴权回读绑定会话；会话删除或员工归属改变立即拒绝并撤销Cookie。会话正常结束仍可只读该历史，不因此获得新会话权限。
- 明确拒绝与未知送达分开：helper返回ISSUANCE_REJECTED/CONSUMPTION_REJECTED或DELIVERY_UNKNOWN；超时、5xx、408/409、解析失败、成功但Cookie没保存不自动重试/重签。先刷新核对；明确未登录且重新获得授权才用新requestId。
- 取消helper尽力撤票并清输入，已消费Cookie不能假称撤销；需要退出走正常登出。登录过期后重新走显式流程，不保存长期密码作兜底。

## 自动化保密

调用程序必须关闭trace/HAR/video、DEBUG/PWDEBUG/NODE_DEBUG及请求体记录；登录期间不截图、不输出输入/请求/响应/中间票据，不用剪贴板或导出Cookie。只能输出最终非敏感状态、requestId及权限范围。CLI无法检测所有外层录制器，非TTY不等于自动保证匿名管道，必须通过可信内存helper使用。

## 多端兼容

新增Web自动化凭据，未改变 `/api/login` password/appToken、正常App principal或Cookie协议；原生App不能签发票据。Mac内嵌WebView与Web共享只读入口；iOS/Android的原生token登录照旧，不储存/转发票据。三端源码已检查；本次无原生包变更，不能把共享WebView验证说成真实设备视觉/触控验收。
