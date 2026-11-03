# 服务端接口功能与归一化索引

源码盘点日期：2026-11-03。以下按注册模块列出 HTTP 注册表达式（含数组路径）；模板字符串、循环和函数参数路径未展开，不包含封装函数调用另行注册的路径、WebSocket 消息类型或静态文件中间件。路径、鉴权和注册顺序以源码为准。

## 功能边界

| 功能域 | 路由入口 | 业务归属 / 已复用能力 |
| --- | --- | --- |
| 登录与权限 | auth、apns、vault | AuthService、api-scope；浏览器管理员与 connected-app 能力分开 |
| 会话读取与历史 | session-list、history、conversation、attention | SessionRegistry、session-transport、server-session-history；运行态与不可变历史分别读取 |
| 会话生命周期与输入 | session-lifecycle、session-input、resume | session-service、SessionRegistry；PTY 与 structured 执行边界保留 |
| Git / Worktree | session-worktree、github | git-quick-commit、git-worktree、git-worktree-batch；仓库操作锁继续由原入口持有 |
| 项目与任务 | workspace、task、mission、conversation-organize | storage 原子入口、ConversationService、任务工作流；wand_tasks 与 workspace_tasks 不混并 |
| 员工、团队与派发 | employee、ai-team、team-dispatch、employee-im | task-agent-parsing、avatar-input、团队/员工服务；身份和候选权限保留 |
| 知识与记忆 | knowledge、user-memory | 知识命名空间与 revision 校验；不合并不同归属 |
| 模型与设置 | settings、pi-defaults、pi-recommendation、local-model、decision | provider-catalog、Pi 设置/资源服务、本地决策服务 |
| 计划与维护 | scheduled-task、daemon-maintenance、storage-cleanup | 调度服务、维护排空屏障、清理服务 |
| 分发与升级 | update | DistributionManager、版本比较、文件 Range 下载、独立更新 helper |
| 文件、静态资源与预览 | file、asset、local-preview | http-file-stream、路径校验、预览代理 |
| 集成与诊断 | dingtalk、feedback、diagnostics、server | 对应集成服务；组合根持有服务装配及中间件顺序 |

## 本轮归一化

- 更新检查：Android APK、macOS Beta、旧 DMG 共用公共更新回包；版本比较仍分别采用 APK 安装序、Wand 安装序、SemVer。无包时省略字段、macOS 可选哈希和 Android null 哈希语义原样保留。iOS 的签名、OTA、bundle build 不是等价逻辑，保留专用实现。
- Git 接口：快捷提交、生成提交消息、打 tag、push、批量合并共用会话及目录前置校验。保留各接口原有 NO_CWD 字段差异；没有执行提交、push 或 tag。
- 工具读取：Pi 执行详情、工具内容、内联图片共用运行会话优先、历史按 toolUseId 读取的快照选择，避免三个接口各自维护回退逻辑。
- 请求解析、错误输出、头像解析、候选解析已经分别由 server-request、express-async、avatar-input、task-agent-parsing 统一；本轮没有叠加新框架。具体业务错误格式与历史兼容响应没有强行统一。

## 路由清单

共 39 个含路由注册的模块、302 个方法/路径注册表达式项。此计数不是完整接口数，也不是公网可访问接口数，鉴权和 capability 限制仍由组合根及路由中间件决定。

### server-ai-team-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/ai-teams` | [159](../src/server-ai-team-routes.ts#L159) |
| POST | `/api/ai-teams` | [163](../src/server-ai-team-routes.ts#L163) |
| PUT | `/api/ai-teams/:id` | [173](../src/server-ai-team-routes.ts#L173) |
| DELETE | `/api/ai-teams/:id` | [186](../src/server-ai-team-routes.ts#L186) |
| GET | `/api/ai-teams/:id` | [193](../src/server-ai-team-routes.ts#L193) |
| POST | `/api/ai-teams/:id/runs` | [208](../src/server-ai-team-routes.ts#L208) |
| GET | `/api/ai-team-runs` | [254](../src/server-ai-team-routes.ts#L254) |
| GET | `/api/wand-tasks/:id/team-runs` | [260](../src/server-ai-team-routes.ts#L260) |
| POST | `/api/wand-tasks/:id/team-runs` | [264](../src/server-ai-team-routes.ts#L264) |
| GET | `/api/ai-team-runs/:id` | [277](../src/server-ai-team-routes.ts#L277) |
| GET | `/api/ai-team-runs/:id/live` | [290](../src/server-ai-team-routes.ts#L290) |
| POST | `path` | [302](../src/server-ai-team-routes.ts#L302) |

### server-apns-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| PUT | `/subscription` | [22](../src/server-apns-routes.ts#L22) |
| DELETE | `/subscription` | [43](../src/server-apns-routes.ts#L43) |
| PUT | `/live-activity` | [52](../src/server-apns-routes.ts#L52) |
| DELETE | `/live-activity` | [72](../src/server-apns-routes.ts#L72) |

### server-asset-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/vendor/xterm/xterm.bundle.js` | [58](../src/server-asset-routes.ts#L58) |
| GET | `/vendor/xterm/xterm.css` | [59](../src/server-asset-routes.ts#L59) |
| GET | `/vendor/qrcode/qrcode.bundle.js` | [60](../src/server-asset-routes.ts#L60) |
| GET | `/assets/app.css` | [61](../src/server-asset-routes.ts#L61) |
| GET | `/assets/theme.js` | [66](../src/server-asset-routes.ts#L66) |
| GET | `/assets/app.js` | [71](../src/server-asset-routes.ts#L71) |
| GET | `/assets/modules/:build/:file` | [76](../src/server-asset-routes.ts#L76) |
| GET | `/assets/ai-teams.js` | [89](../src/server-asset-routes.ts#L89) |
| GET | `/assets/login.js` | [94](../src/server-asset-routes.ts#L94) |
| GET | `/assets/plush-avatar.js` | [99](../src/server-asset-routes.ts#L99) |
| GET | `/` | [107](../src/server-asset-routes.ts#L107) |
| GET | `/settings` | [107](../src/server-asset-routes.ts#L107) |
| GET | `/api/structured-chat-avatar/:role` | [117](../src/server-asset-routes.ts#L117) |

### server-attention-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/attention` | [13](../src/server-attention-routes.ts#L13) |

### server-auth-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/login/ticket/issue` | [67](../src/server-auth-routes.ts#L67) |
| POST | `/api/login/ticket/cancel` | [86](../src/server-auth-routes.ts#L86) |
| POST | `/api/login/ticket` | [92](../src/server-auth-routes.ts#L92) |
| POST | `/api/login` | [117](../src/server-auth-routes.ts#L117) |
| POST | `/api/logout` | [168](../src/server-auth-routes.ts#L168) |
| POST | `/api/set-password` | [174](../src/server-auth-routes.ts#L174) |
| GET | `/api/session-check` | [196](../src/server-auth-routes.ts#L196) |

### server-conversation-organize-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/sessions/auto-organize` | [32](../src/server-conversation-organize-routes.ts#L32) |
| GET | `/api/sessions/auto-organize/by-token/:token` | [44](../src/server-conversation-organize-routes.ts#L44) |
| GET | `/api/sessions/auto-organize/:id` | [49](../src/server-conversation-organize-routes.ts#L49) |
| POST | `/api/sessions/auto-organize/:id/cancel` | [54](../src/server-conversation-organize-routes.ts#L54) |

### server-conversation-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/conversations` | [23](../src/server-conversation-routes.ts#L23) |
| PATCH | `/api/conversations/:id/list-state` | [24](../src/server-conversation-routes.ts#L24) |
| DELETE | `/api/conversations/:id` | [32](../src/server-conversation-routes.ts#L32) |
| GET | `/api/conversations/requests/:requestId` | [36](../src/server-conversation-routes.ts#L36) |
| GET | `/api/conversations/:id/sync` | [41](../src/server-conversation-routes.ts#L41) |
| GET | `/api/conversations/:id` | [54](../src/server-conversation-routes.ts#L54) |
| POST | `path` | [59](../src/server-conversation-routes.ts#L59) |

### server-daemon-maintenance-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/daemon-maintenance` | [11](../src/server-daemon-maintenance-routes.ts#L11) |
| POST | `/api/daemon-maintenance/force-update` | [14](../src/server-daemon-maintenance-routes.ts#L14) |

### server-decision-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/decisions/status` | [32](../src/server-decision-routes.ts#L32) |
| POST | `/api/decisions/evaluate` | [35](../src/server-decision-routes.ts#L35) |

### server-diagnostics.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/diagnostics/export` | [98](../src/server-diagnostics.ts#L98) |

### server-employee-im-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `path` | [15](../src/server-employee-im-routes.ts#L15) |
| PUT | `path` | [16](../src/server-employee-im-routes.ts#L16) |
| POST | `${path}/test` | [25](../src/server-employee-im-routes.ts#L25) |

### server-employee-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/silicon-employees` | [275](../src/server-employee-routes.ts#L275) |
| GET | `/api/silicon-employees/draft/defaults` | [286](../src/server-employee-routes.ts#L286) |
| PUT | `/api/silicon-employees/draft/defaults` | [291](../src/server-employee-routes.ts#L291) |
| POST | `/api/silicon-employees/draft` | [310](../src/server-employee-routes.ts#L310) |
| POST | `/api/silicon-employees` | [335](../src/server-employee-routes.ts#L335) |
| GET | `/api/silicon-employees/:id` | [347](../src/server-employee-routes.ts#L347) |
| GET | `/api/silicon-employees/:id/knowledge` | [357](../src/server-employee-routes.ts#L357) |
| POST | `/api/silicon-employees/:id/knowledge` | [367](../src/server-employee-routes.ts#L367) |
| DELETE | `/api/silicon-employees/:id/knowledge/:entryId` | [376](../src/server-employee-routes.ts#L376) |
| DELETE | `/api/silicon-employees/:id/knowledge` | [384](../src/server-employee-routes.ts#L384) |
| PUT | `/api/silicon-employees/:id` | [391](../src/server-employee-routes.ts#L391) |
| POST | `/api/silicon-employees/:id/archive` | [416](../src/server-employee-routes.ts#L416) |
| POST | `/api/silicon-employees/:id/unarchive` | [430](../src/server-employee-routes.ts#L430) |
| DELETE | `/api/silicon-employees/:id` | [443](../src/server-employee-routes.ts#L443) |

### server-feedback-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/key` | [24](../src/server-feedback-routes.ts#L24) |
| POST | `/` | [25](../src/server-feedback-routes.ts#L25) |
| POST | `/api/feedback/client` | [47](../src/server-feedback-routes.ts#L47) |
| GET | `/api/feedback/reports` | [64](../src/server-feedback-routes.ts#L64) |

### server-file-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/session-file/:sessionId` | [62](../src/server-file-routes.ts#L62) |
| GET | `/api/path-suggestions` | [96](../src/server-file-routes.ts#L96) |
| GET | `/api/directory` | [109](../src/server-file-routes.ts#L109) |
| GET | `/api/file-preview` | [157](../src/server-file-routes.ts#L157) |
| POST | `/api/file-write` | [219](../src/server-file-routes.ts#L219) |
| POST | `/api/file-create` | [297](../src/server-file-routes.ts#L297) |
| POST | `/api/dir-create` | [323](../src/server-file-routes.ts#L323) |
| POST | `/api/file-rename` | [344](../src/server-file-routes.ts#L344) |
| POST | `/api/file-delete` | [387](../src/server-file-routes.ts#L387) |
| GET | `/api/file-raw` | [413](../src/server-file-routes.ts#L413) |
| GET | `/api/folders` | [569](../src/server-file-routes.ts#L569) |
| GET | `/api/quick-paths` | [604](../src/server-file-routes.ts#L604) |
| GET | `/api/recent-paths` | [614](../src/server-file-routes.ts#L614) |
| POST | `/api/recent-paths` | [619](../src/server-file-routes.ts#L619) |
| GET | `/api/validate-path` | [638](../src/server-file-routes.ts#L638) |
| GET | `/api/file-search` | [669](../src/server-file-routes.ts#L669) |

### server-github-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/connectors/github` | [78](../src/server-github-routes.ts#L78) |
| POST | `/api/connectors/github` | [83](../src/server-github-routes.ts#L83) |
| DELETE | `/api/connectors/github` | [95](../src/server-github-routes.ts#L95) |
| GET | `/api/github/repos/:owner/:repo/issues/:number/bindings` | [100](../src/server-github-routes.ts#L100) |
| POST | `/api/github/repos/:owner/:repo/issues/:number/bindings` | [110](../src/server-github-routes.ts#L110) |
| DELETE | `/api/github/repos/:owner/:repo/issues/:number/bindings/:sessionId` | [123](../src/server-github-routes.ts#L123) |
| GET | `/api/github/user` | [132](../src/server-github-routes.ts#L132) |
| GET | `/api/github/repos` | [137](../src/server-github-routes.ts#L137) |
| GET | `/api/github/repos/:owner/:repo` | [155](../src/server-github-routes.ts#L155) |
| GET | `/api/github/repos/:owner/:repo/issues` | [160](../src/server-github-routes.ts#L160) |
| POST | `/api/github/repos/:owner/:repo/issues` | [167](../src/server-github-routes.ts#L167) |
| PATCH | `/api/github/repos/:owner/:repo/issues/:number` | [178](../src/server-github-routes.ts#L178) |
| POST | `/api/github/repos/:owner/:repo/issues/:number/comments` | [190](../src/server-github-routes.ts#L190) |
| GET | `/api/github/repos/:owner/:repo/pulls` | [198](../src/server-github-routes.ts#L198) |
| POST | `/api/github/repos/:owner/:repo/pulls` | [205](../src/server-github-routes.ts#L205) |

### server-history-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/${provider}-history` | [20](../src/server-history-routes.ts#L20) |
| DELETE | `/api/${provider}-history/:${param}` | [71](../src/server-history-routes.ts#L71) |
| POST | `/api/${provider}-history/batch-delete` | [85](../src/server-history-routes.ts#L85) |
| DELETE | `/api/claude-history` | [103](../src/server-history-routes.ts#L103) |

### server-knowledge-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/knowledge/owners` | [37](../src/server-knowledge-routes.ts#L37) |
| GET | `/api/knowledge` | [38](../src/server-knowledge-routes.ts#L38) |
| POST | `/api/knowledge` | [43](../src/server-knowledge-routes.ts#L43) |
| PATCH | `/api/knowledge/:id` | [47](../src/server-knowledge-routes.ts#L47) |
| DELETE | `/api/knowledge/:id` | [51](../src/server-knowledge-routes.ts#L51) |

### server-local-model-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/local-models/status` | [15](../src/server-local-model-routes.ts#L15) |
| POST | `/api/local-models/:kind/${action}` | [19](../src/server-local-model-routes.ts#L19) |
| POST | `/api/local-models/:kind/cancel` | [24](../src/server-local-model-routes.ts#L24) |
| PATCH | `/api/local-models/laya/settings` | [30](../src/server-local-model-routes.ts#L30) |

### server-mission-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/inbox` | [28](../src/server-mission-routes.ts#L28) |
| POST | `/api/inbox/read` | [32](../src/server-mission-routes.ts#L32) |
| GET | `/api/missions` | [38](../src/server-mission-routes.ts#L38) |
| POST | `/api/missions` | [42](../src/server-mission-routes.ts#L42) |
| GET | `/api/missions/:missionId` | [50](../src/server-mission-routes.ts#L50) |
| POST | `/api/missions/:missionId/archive` | [59](../src/server-mission-routes.ts#L59) |
| GET | `/api/missions/:missionId/attempts/:attemptId/diff` | [67](../src/server-mission-routes.ts#L67) |
| POST | `/api/missions/:missionId/attempts/:attemptId/comments` | [75](../src/server-mission-routes.ts#L75) |
| POST | `/api/missions/:missionId/attempts/:attemptId/review/send` | [87](../src/server-mission-routes.ts#L87) |
| POST | `/api/missions/:missionId/attempts/:attemptId/review/resolve` | [96](../src/server-mission-routes.ts#L96) |

### server-pi-defaults-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/pi-settings/defaults` | [45](../src/server-pi-defaults-routes.ts#L45) |
| PATCH | `/api/pi-settings/defaults` | [61](../src/server-pi-defaults-routes.ts#L61) |

### server-pi-recommendation-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/sessions/:id/pi-settings/recommend` | [23](../src/server-pi-recommendation-routes.ts#L23) |

### server-resume-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `path` | [131](../src/server-resume-routes.ts#L131) |

### server-scheduled-task-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/scheduled-tasks` | [13](../src/server-scheduled-task-routes.ts#L13) |
| GET | `/api/scheduled-tasks/calendar` | [14](../src/server-scheduled-task-routes.ts#L14) |
| GET | `/api/scheduled-tasks/:id/activity` | [17](../src/server-scheduled-task-routes.ts#L17) |
| GET | `/api/scheduled-tasks/:id/runs/:runId` | [20](../src/server-scheduled-task-routes.ts#L20) |
| GET | `/api/scheduled-tasks/:id` | [23](../src/server-scheduled-task-routes.ts#L23) |
| POST | `/api/scheduled-tasks` | [26](../src/server-scheduled-task-routes.ts#L26) |
| PATCH | `/api/scheduled-tasks/:id` | [29](../src/server-scheduled-task-routes.ts#L29) |

### server-session-input-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/structured-sessions/:id/messages` | [47](../src/server-session-input-routes.ts#L47) |
| POST | `/api/structured-sessions/:id/messages` | [67](../src/server-session-input-routes.ts#L67) |
| PATCH | `/api/structured-sessions/:id/queued` | [89](../src/server-session-input-routes.ts#L89) |
| PATCH | `/api/structured-sessions/:id/queued/:index` | [103](../src/server-session-input-routes.ts#L103) |
| DELETE | `/api/structured-sessions/:id/queued/:index` | [118](../src/server-session-input-routes.ts#L118) |
| POST | `/api/structured-sessions/:id/queued/:index/promote` | [133](../src/server-session-input-routes.ts#L133) |
| DELETE | `/api/structured-sessions/:id/queued` | [146](../src/server-session-input-routes.ts#L146) |
| POST | `/api/sessions/:id/input` | [157](../src/server-session-input-routes.ts#L157) |
| POST | `/api/sessions/:id/resize` | [245](../src/server-session-input-routes.ts#L245) |
| POST | `/api/sessions/:id/${path}` | [264](../src/server-session-input-routes.ts#L264) |
| POST | `/api/sessions/:id/escalations/:requestId/resolve` | [280](../src/server-session-input-routes.ts#L280) |
| POST | `/api/sessions/:id/stop` | [299](../src/server-session-input-routes.ts#L299) |

### server-session-lifecycle-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/sessions` | [39](../src/server-session-lifecycle-routes.ts#L39) |
| PUT | `/api/sessions/:id/quick-terminal` | [231](../src/server-session-lifecycle-routes.ts#L231) |
| POST | `/api/sessions/:id/directory` | [239](../src/server-session-lifecycle-routes.ts#L239) |
| POST | `/api/sessions/:id/employee` | [264](../src/server-session-lifecycle-routes.ts#L264) |
| POST | `/api/sessions/:id/provider` | [287](../src/server-session-lifecycle-routes.ts#L287) |
| GET | `/api/sessions/:id/pi-settings` | [320](../src/server-session-lifecycle-routes.ts#L320) |
| PATCH | `/api/sessions/:id/pi-settings` | [328](../src/server-session-lifecycle-routes.ts#L328) |
| POST | `/api/sessions/:id/model` | [363](../src/server-session-lifecycle-routes.ts#L363) |
| POST | `/api/sessions/:id/thinking-effort` | [382](../src/server-session-lifecycle-routes.ts#L382) |
| POST | `/api/sessions/:id/mode` | [402](../src/server-session-lifecycle-routes.ts#L402) |
| POST | `/api/sessions/batch-delete` | [429](../src/server-session-lifecycle-routes.ts#L429) |
| POST | `/api/sessions/:id/resume` | [459](../src/server-session-lifecycle-routes.ts#L459) |
| POST | `/api/claude-sessions/:claudeSessionId/resume` | [479](../src/server-session-lifecycle-routes.ts#L479) |
| POST | `/api/sessions/:id/archive` | [549](../src/server-session-lifecycle-routes.ts#L549) |
| POST | `/api/sessions/:id/unarchive` | [562](../src/server-session-lifecycle-routes.ts#L562) |
| POST | `/api/sessions/batch-archive` | [577](../src/server-session-lifecycle-routes.ts#L577) |
| DELETE | `/api/sessions/:id` | [603](../src/server-session-lifecycle-routes.ts#L603) |

### server-session-list-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/session-list` | [34](../src/server-session-list-routes.ts#L34) |
| GET | `/api/session-directories` | [61](../src/server-session-list-routes.ts#L61) |
| PUT | `/api/session-directories/name` | [69](../src/server-session-list-routes.ts#L69) |
| GET | `/api/sessions` | [111](../src/server-session-list-routes.ts#L111) |
| GET | `/api/sessions/provider-usage` | [115](../src/server-session-list-routes.ts#L115) |
| GET | `/api/sessions/:id/pi-execution/:toolUseId` | [119](../src/server-session-list-routes.ts#L119) |
| GET | `/api/sessions/:id/tool-content/:toolUseId` | [128](../src/server-session-list-routes.ts#L128) |
| GET | `/api/sessions/:id/tool-images/:toolUseId/:index` | [162](../src/server-session-list-routes.ts#L162) |
| GET | `/api/sessions/:id/pty-history` | [194](../src/server-session-list-routes.ts#L194) |
| POST | `/api/sessions/:id/completion/view` | [216](../src/server-session-list-routes.ts#L216) |
| GET | `/api/sessions/:id` | [233](../src/server-session-list-routes.ts#L233) |
| GET | `/api/sessions/:id/messages` | [288](../src/server-session-list-routes.ts#L288) |

### server-session-worktree-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/sessions/:id/worktree/merge/check` | [47](../src/server-session-worktree-routes.ts#L47) |
| POST | `/api/sessions/:id/worktree/merge` | [76](../src/server-session-worktree-routes.ts#L76) |
| GET | `/api/sessions/:id/git-status` | [119](../src/server-session-worktree-routes.ts#L119) |
| POST | `/api/sessions/:id/git/merge-worktrees` | [138](../src/server-session-worktree-routes.ts#L138) |
| POST | `/api/sessions/:id/quick-commit` | [154](../src/server-session-worktree-routes.ts#L154) |
| GET | `/api/sessions/:id/iteration-context` | [208](../src/server-session-worktree-routes.ts#L208) |
| POST | `/api/sessions/:id/iteration-context` | [225](../src/server-session-worktree-routes.ts#L225) |
| POST | `/api/sessions/:id/generate-commit-message` | [239](../src/server-session-worktree-routes.ts#L239) |
| POST | `/api/sessions/:id/git/tag-head` | [269](../src/server-session-worktree-routes.ts#L269) |
| POST | `/api/sessions/:id/git/push` | [294](../src/server-session-worktree-routes.ts#L294) |
| POST | `/api/sessions/:id/worktree/cleanup` | [316](../src/server-session-worktree-routes.ts#L316) |
| POST | `/api/workspaces/:id/worktree-merge-agent` | [336](../src/server-session-worktree-routes.ts#L336) |

### server-settings-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/settings/about` | [88](../src/server-settings-routes.ts#L88) |
| GET | `/api/settings` | [105](../src/server-settings-routes.ts#L105) |
| GET | `/api/settings/env-preview` | [136](../src/server-settings-routes.ts#L136) |
| GET | `/api/app-connect-code` | [169](../src/server-settings-routes.ts#L169) |
| POST | `/api/settings/config` | [173](../src/server-settings-routes.ts#L173) |
| GET | `/api/settings/openrouter` | [289](../src/server-settings-routes.ts#L289) |
| POST | `/api/settings/openrouter` | [294](../src/server-settings-routes.ts#L294) |
| POST | `/api/settings/openrouter/refresh` | [304](../src/server-settings-routes.ts#L304) |
| DELETE | `/api/settings/openrouter` | [312](../src/server-settings-routes.ts#L312) |
| GET | `/api/models` | [316](../src/server-settings-routes.ts#L316) |
| POST | `/api/models/refresh` | [329](../src/server-settings-routes.ts#L329) |
| POST | `/api/settings/upload-cert` | [343](../src/server-settings-routes.ts#L343) |

### server-storage-cleanup-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/storage-cleanup/status` | [8](../src/server-storage-cleanup-routes.ts#L8) |
| GET | `/api/storage-cleanup/preview` | [9](../src/server-storage-cleanup-routes.ts#L9) |
| POST | `/api/storage-cleanup/run` | [13](../src/server-storage-cleanup-routes.ts#L13) |

### server-task-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/reference/:id` | [259](../src/server-task-routes.ts#L259) |
| GET | `/api/wand-tasks` | [273](../src/server-task-routes.ts#L273) |
| GET | `/api/wand-task-actions` | [279](../src/server-task-routes.ts#L279) |
| POST | `/api/wand-tasks/:id/maintenance` | [285](../src/server-task-routes.ts#L285) |
| GET | `/api/wand-task-agent-defaults` | [292](../src/server-task-routes.ts#L292) |
| GET | `/api/wand-milestones` | [296](../src/server-task-routes.ts#L296) |
| POST | `/api/wand-milestones` | [307](../src/server-task-routes.ts#L307) |
| PATCH | `/api/wand-milestones/:id` | [322](../src/server-task-routes.ts#L322) |
| DELETE | `/api/wand-milestones/:id` | [353](../src/server-task-routes.ts#L353) |
| PUT | `/api/wand-task-agent-defaults` | [364](../src/server-task-routes.ts#L364) |
| POST | `/api/wand-tasks` | [375](../src/server-task-routes.ts#L375) |
| PATCH | `/api/wand-tasks/:id` | [443](../src/server-task-routes.ts#L443) |
| DELETE | `/api/wand-tasks/archived` | [555](../src/server-task-routes.ts#L555) |
| DELETE | `/api/wand-tasks/:id` | [582](../src/server-task-routes.ts#L582) |
| POST | `/api/wand-tasks/:id/sessions` | [594](../src/server-task-routes.ts#L594) |
| DELETE | `/api/wand-tasks/:id/sessions/:sessionId` | [611](../src/server-task-routes.ts#L611) |
| POST | `/api/wand-tasks/:id/dispatch` | [628](../src/server-task-routes.ts#L628) |
| GET | `/api/wand-tasks/:id` | [786](../src/server-task-routes.ts#L786) |

### server-team-dispatch-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/team-dispatch/plan` | [38](../src/server-team-dispatch-routes.ts#L38) |
| POST | `/api/team-dispatch/start` | [62](../src/server-team-dispatch-routes.ts#L62) |

### server-update-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/android-apk-update` | [175](../src/server-update-routes.ts#L175) |
| GET | `/android/download` | [192](../src/server-update-routes.ts#L192) |
| GET | `/api/macos-app-update` | [228](../src/server-update-routes.ts#L228) |
| GET | `/macos/update-download` | [240](../src/server-update-routes.ts#L240) |
| GET | `/api/macos-dmg-update` | [265](../src/server-update-routes.ts#L265) |
| GET | `/macos/download` | [272](../src/server-update-routes.ts#L272) |
| GET | `/api/ios-ipa-update` | [287](../src/server-update-routes.ts#L287) |
| GET | `/ios/manifest.plist` | [333](../src/server-update-routes.ts#L333) |
| GET | `/ios/install` | [344](../src/server-update-routes.ts#L344) |
| GET | `/ios/download` | [364](../src/server-update-routes.ts#L364) |
| GET | `/api/android-apk` | [592](../src/server-update-routes.ts#L592) |
| GET | `/api/macos-dmg` | [595](../src/server-update-routes.ts#L595) |
| GET | `/api/ios-ipa` | [598](../src/server-update-routes.ts#L598) |
| GET | `/api/provider-cli-updates` | [602](../src/server-update-routes.ts#L602) |
| POST | `/api/provider-cli-updates` | [618](../src/server-update-routes.ts#L618) |
| GET | `/api/update-status` | [647](../src/server-update-routes.ts#L647) |
| GET | `/api/check-update` | [655](../src/server-update-routes.ts#L655) |
| POST | `/api/update` | [664](../src/server-update-routes.ts#L664) |
| GET | `/api/auto-update` | [711](../src/server-update-routes.ts#L711) |
| POST | `/api/auto-update` | [715](../src/server-update-routes.ts#L715) |
| GET | `/api/update-channel` | [729](../src/server-update-routes.ts#L729) |
| POST | `/api/update-channel` | [736](../src/server-update-routes.ts#L736) |

### server-user-memory.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/user-memory` | [72](../src/server-user-memory.ts#L72) |
| PATCH | `/api/user-memory` | [76](../src/server-user-memory.ts#L76) |
| DELETE | `/api/user-memory` | [85](../src/server-user-memory.ts#L85) |
| POST | `/api/user-memory/refresh` | [90](../src/server-user-memory.ts#L90) |

### server-vault-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/browser-extension/status` | [33](../src/server-vault-routes.ts#L33) |
| GET | `/api/browser-extension/vaults` | [51](../src/server-vault-routes.ts#L51) |
| POST | `/api/browser-extension/vaults` | [55](../src/server-vault-routes.ts#L55) |
| GET | `/api/browser-extension/items` | [64](../src/server-vault-routes.ts#L64) |
| POST | `/api/browser-extension/items` | [75](../src/server-vault-routes.ts#L75) |
| GET | `/api/browser-extension/items/:id` | [84](../src/server-vault-routes.ts#L84) |
| PUT | `/api/browser-extension/items/:id` | [93](../src/server-vault-routes.ts#L93) |
| DELETE | `/api/browser-extension/items/:id` | [106](../src/server-vault-routes.ts#L106) |
| POST | `/api/browser-extension/items/:id/use` | [114](../src/server-vault-routes.ts#L114) |
| GET | `/api/browser-extension/generator/password` | [123](../src/server-vault-routes.ts#L123) |
| POST | `/api/browser-extension/totp/preview` | [133](../src/server-vault-routes.ts#L133) |
| GET | `/api/browser-extension/security-report` | [149](../src/server-vault-routes.ts#L149) |

### server-workspace-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/workspaces` | [409](../src/server-workspace-routes.ts#L409) |
| POST | `/api/workspaces` | [418](../src/server-workspace-routes.ts#L418) |
| GET | `/api/workspaces/:id` | [450](../src/server-workspace-routes.ts#L450) |
| PATCH | `/api/workspaces/:id` | [475](../src/server-workspace-routes.ts#L475) |
| DELETE | `/api/workspaces/:id` | [511](../src/server-workspace-routes.ts#L511) |
| PUT | `/api/workspaces/:id/layout` | [549](../src/server-workspace-routes.ts#L549) |
| POST | `/api/tasks/organize-by-title` | [565](../src/server-workspace-routes.ts#L565) |
| POST | `/api/workspace-sections` | [632](../src/server-workspace-routes.ts#L632) |
| POST | `/api/workspace-sections/unassign` | [652](../src/server-workspace-routes.ts#L652) |
| POST | `/api/tasks` | [664](../src/server-workspace-routes.ts#L664) |
| POST | `/api/workspaces/:id/tasks` | [664](../src/server-workspace-routes.ts#L664) |
| GET | `/api/tasks` | [692](../src/server-workspace-routes.ts#L692) |
| PUT | `/api/workspaces/order` | [962](../src/server-workspace-routes.ts#L962) |
| GET | `/api/workspaces/:id/tasks` | [980](../src/server-workspace-routes.ts#L980) |
| GET | `/api/workspaces/:id/worktrees` | [996](../src/server-workspace-routes.ts#L996) |
| GET | `/api/workspace-tasks/:taskId` | [1075](../src/server-workspace-routes.ts#L1075) |
| POST | `/api/workspace-tasks/:taskId/sessions` | [1102](../src/server-workspace-routes.ts#L1102) |
| PATCH | `/api/workspace-tasks/:taskId` | [1118](../src/server-workspace-routes.ts#L1118) |
| POST | `/api/workspace-tasks/:taskId/archive` | [1146](../src/server-workspace-routes.ts#L1146) |
| DELETE | `/api/workspace-tasks/:taskId` | [1170](../src/server-workspace-routes.ts#L1170) |
| PUT | `/api/workspace-tasks/:taskId/layout` | [1201](../src/server-workspace-routes.ts#L1201) |

### server.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/core-status` | [708](../src/server.ts#L708) |
| GET | `/api/config` | [766](../src/server.ts#L766) |
| POST | `/api/optimize-prompt` | [906](../src/server.ts#L906) |
| GET | `/cert/server.crt` | [972](../src/server.ts#L972) |
| POST | `/api/restart` | [1118](../src/server.ts#L1118) |

### settings-web-access.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/settings/webview-session` | [31](../src/settings-web-access.ts#L31) |

### task-comment-dispatch.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| GET | `/api/wand-tasks/:id/comments/:commentId/result` | [254](../src/task-comment-dispatch.ts#L254) |
| GET | `/api/wand-tasks/:id/comments/:commentId/result/blocks/:turnOffset` | [288](../src/task-comment-dispatch.ts#L288) |
| GET | `/api/wand-tasks/:id/comments/:commentId/result/tool-content/:toolUseId` | [320](../src/task-comment-dispatch.ts#L320) |
| GET | `/api/wand-tasks/:id/comments/:commentId/result/block/:turnOffset/:blockIndex` | [355](../src/task-comment-dispatch.ts#L355) |
| GET | `/api/wand-tasks/:id/context` | [375](../src/task-comment-dispatch.ts#L375) |
| GET | `/api/wand-tasks/:id/comments/:commentId/source` | [389](../src/task-comment-dispatch.ts#L389) |
| GET | `/api/wand-tasks/:id/comments/status` | [395](../src/task-comment-dispatch.ts#L395) |
| GET | `/api/wand-tasks/:id/comments` | [409](../src/task-comment-dispatch.ts#L409) |
| POST | `/api/wand-tasks/:id/comments` | [425](../src/task-comment-dispatch.ts#L425) |

### upload-routes.ts

| 方法 | 路径 | 源码 |
| --- | --- | --- |
| POST | `/api/sessions/:id/upload` | [171](../src/upload-routes.ts#L171) |

> 后续深入复查见 [服务端归一化复查](server-normalization-review.md)。首轮下述结果仅覆盖首轮三个修改模块。

## 本轮验证结果

2026-11-03 本轮三组归一化验证通过：

- `npm run check`、`npm run build`、`git diff --check` 通过；检查使用 `.nvmrc` 的 Node 24.21.0，部署使用当前服务 Node 26.10.0。
- 73 个临时 HTTP 前后对照检查通过：更新字段与版本关系、Git 缺会话/缺目录、工具运行态/历史回退及图片响应。没有向仓库恢复自动化测试套件。
- 通过 `~/start.sh` 安装为 `4.109.0-debug.t11032028`，三个修改模块的安装文件与本机构建文件 SHA-256 一致；Render / terminald 未重启。
- 已安装服务 20 个请求与部署前响应一致；当前会话 3 个已完成工具的内容读取返回 200、resultAvailable=true、pending=false。
- Web、Android、iOS、macOS 调用与解码处已核对，接口路径、状态码和字段契约未变，无客户端源码修改。没有执行真实 Git 提交、push、tag 或模型调用，也没有进行客户端视觉/设备验收。
- 证据位于本机 `/tmp/wand-server-normalization/`（临时文件可能被系统清理）：`before.json`、`after.json`、`verify.mjs`、`build.log`、`deploy-current.log`。其中不保存连接码或 token。

旧 Node 24 安装前缀的遗留更新锁阻止了首次部署；未清锁或修改旧安装。当前 Node 26 服务部署通过。该问题已有关联任务 `f82d6456-7b76-4dd6-b2a6-f0b18494f2b1`、`2adc495d-ecee-4c7f-b494-5bc5bf49e74c`，未重复建卡。
