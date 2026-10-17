# CLI / skill 一次性网页登录

TASK-69：本机可信所有者 CLI 为用户授权的界面自动化签发短时票据，通过真实网页登录表单建立 HttpOnly 登录 Cookie。登录后与管理员密码登录同权限；签发仍要求真实员工执行证明，不使用 App 长期连接码代替一次性密钥。

## 入口

- `wand web-login:issue --stdin`：`{"requestId":"<UUID>","origin":"https://wand.example:8443"}`。只允许提供的 skill 内存助手以匿名进程管道接收，普通终端/调试环境默认拒绝。
- `wand web-login:cancel --stdin`：`{"requestId":"<原UUID>"}`。取消未消费票据，不撤销已消费的 Cookie。
- `wand-system/scripts/web-login.mjs`：`loginWithWebTicket(page,{origin,signal})`，传入专用 Playwright Page，在可见页面的「访问密码」输入框填写票据并点击原「进入控制台」按钮，不需要切换登录方式。已有登录态不签发。
- Web、`?reactUi=0` 和原生 WebView 共用入口；复用单个 Ant Input.Password，不展示票据切换或专用说明；客户端按完整 `wlt_` 票据格式选择原消费接口，普通密码仍走原密码接口，不做失败后跨接口重试。票据输入关闭自动填充与明文切换，提交后同步清空原生DOM及Ant内部状态。

## 执行主体与授权边界

签发/取消沿用 WandCliApi 的本机所有者认证；长期密码只在既有 CLI 内存认证通道使用，不回显、不放 argv。路由额外要求管理员、socket回环来源，且没有 Origin/Sec-Fetch-Site/Forwarded/X-Forwarded-*。App token、扩展、浏览器和反代即使已登录也不能签发。

每轮员工runner由服务注入独立的随机执行证明，服务内存将证明绑定当前员工/会话；完成、取消、改密或重启即撤销。CLI只在请求头的内存通道传递证明，服务由证明解析主体，**不把调用者提供的非秘密session ID/环境ID当作身份证明**，也不复用知识库/决策token。stdin不能另选员工/会话/scopes/模式/TTL。服务再核对真实运行所有者；签发及消费时必须仍在运行、未归档且身份不变。**升级前已在执行的回合没有新证明，要等新一轮员工执行才能签发，不能降为local-owner或手填他人ID。**

消费后的 Cookie 与网页管理员密码登录完全同权限（browser-admin / admin）：可查看和操作所有会话、任务/工作区、文件/密码库、设置/管理接口与实时 WebSocket，输入框可用，界面不显示只读提示。

这是明确的产品决定：票据用于员工像用户一样操作系统界面（2026-10-17 修订，取代此前 connected-app/sessions 只读绑定方案，相关只读中间件与过滤已移除）。签发门槛保持不变：仅本机可信所有者 CLI、真实员工执行证明且主体仍在运行；请求不能携带 employeeId、scopes、mode 或 TTL。正常原生App、浏览器密码登录及其既有scope不变。

## 生命周期与失败

- 票据随机32字节、60秒，绑定精确origin；仅HTTPS，回环允许HTTP，publicOrigin配置存在时必须匹配。消费同时校验请求Origin、实际服务origin及Sec-Fetch-Site。
- 服务内存只存票据摘要，同步检查并烧毁，无await竞争窗口；并发最多一次成功。原票据不进入URL、历史、文件、日志、知识或Cookie。
- requestId已处理/取消墓碑保留12小时，重复请求返回409而不重发；取消先到也阻止迟到签发。内存上限4096，消费独立有界限流。
- 改密/撤销全部登录、服务重启及释放清空票据。签发后主体结束/改变拒绝消费。
- Cookie 与普通登录一致：持久化、最长12小时且服务重启后仍有效。早期原型签发的无主体 sessions-only Cookie升级后拒绝认证，无需删除用户历史或正常登录态。
- 登录后的网页会话不因签发时的员工会话结束/删除而失效；它就是一份普通管理员登录态，使用完成后按正常登出退出。
- 明确拒绝与未知送达分开：helper返回ISSUANCE_REJECTED/CONSUMPTION_REJECTED或DELIVERY_UNKNOWN；超时、5xx、408/409、解析失败、成功但Cookie没保存不自动重试/重签。先刷新核对；明确未登录且重新获得授权才用新requestId。
- 取消helper尽力撤票并清输入，已消费Cookie不能假称撤销；需要退出走正常登出。登录过期后重新走显式流程，不保存长期密码作兜底。

## 无法签发时的诊断

`EXECUTION_PROOF_REQUIRED` 表示 helper 的本地前置检查未通过：执行环境缺少/格式无效的 `WAND_WEB_LOGIN_PROOF`，还没有启动 CLI 或发出认证、签发、取消请求，也不会修改页面输入。独立启动的 Pi/终端可以发现托管技能，但不属于 Wand 员工 runner，因而不会自动获得证明；升级前已启动的回合也可能缺少证明。请在 Wand 内已获授权的员工会话新一轮执行中登录，或由用户手动登录，不能手填会话 ID、复制证明或降级所有者身份。已有网页登录态无需证明。

旧 helper 会把 CLI 本地的 403 `invalid_subject` 合并为 `ISSUANCE_REJECTED`，无法区分缺少证明和服务端拒绝；看到该旧错误不能直接断言网站/票据消费故障。格式有效但已撤销、过期或属于另一个服务的证明仍由服务端拒绝；前置检查并不保证可以签发。仅检查证明是否存在/格式有效，不打印其值。

## 自动化保密

调用程序必须关闭trace/HAR/video、DEBUG/PWDEBUG/NODE_DEBUG及请求体记录；登录期间不截图、不输出输入/请求/响应/中间票据，不用剪贴板或导出Cookie。只能输出最终非敏感状态、requestId及权限范围。CLI无法检测所有外层录制器，非TTY不等于自动保证匿名管道，必须通过可信内存helper使用。

## 多端兼容

新增Web自动化凭据，未改变 `/api/login` password/appToken、正常App principal或Cookie协议；原生App不能签发票据。Mac内嵌WebView与Web共享同一登录入口；iOS/Android的原生token登录照旧，不储存/转发票据。三端源码已检查；本次无原生包变更，不能把共享WebView验证说成真实设备视觉/触控验收。
