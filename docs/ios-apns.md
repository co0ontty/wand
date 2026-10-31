# iOS APNs 远程提醒

Wand 直连 Apple Push Notification service，不引入第三方客户端 SDK。消息提醒只发送真实“回复完成”和“等待授权”；另支持已经在前台创建的聚合灵动岛活动远程更新/结束。不包含 Android、通知内审批、富媒体、后台 Push-to-Start 或静默保活。

## 部署条件

1. 沿用主 App 的实际 Bundle ID，在 Apple Developer 为该 App ID 开启 Push Notifications。不要用源码默认 Bundle ID 代替 Ad Hoc profile 中的实际标识。
2. 创建 APNs token key，优先限制为该 App 的 Production / Topic Specific；私钥仅留在受信任服务端，文件权限 `0600`。不能把它随 npm/客户端包分发给其他自托管用户。
3. 为主 App 重新生成 Ad Hoc profile，沿用原分发证书与已登记设备。Widget 不需要新增推送能力。原本地 profile 保留；Apple 修改能力后会要求旧 profile 重新生成。
4. 固定入口 `~/ios.sh --check` 检查本机签名条件，`~/ios.sh` 构建/签名 Beta。`ios/scripts/adhoc-signing.py` 额外要求主 profile 的 `aps-environment=production`，并验证最终 App entitlement 与 Info.plist 环境相同。

## 服务端配置

在当前 Wand 配置文件所在目录放置独立的 `apns.json`（权限 `0600`），例如 `~/.wand/apns.json`：

```json
{
  "keyPath": "/absolute/private/path/AuthKey_EXAMPLE123.p8",
  "keyId": "EXAMPLE123",
  "teamId": "TEAMID1234",
  "topic": "com.example.wand",
  "environment": "production"
}
```

这里只保存本机密钥路径和元数据，不保存私钥正文；此文件不进入公共 `/api/config` 或 Web 设置 DTO。私钥需为 APNs P-256 `.p8`，只从本机绝对路径读取，不从 HTTP 输入、URL 或公开下载地址加载。

也可通过部署进程环境配置 `WAND_APNS_KEY_PATH`、`WAND_APNS_KEY_ID`、`WAND_APNS_TEAM_ID`、`WAND_APNS_TOPIC`、可选 `WAND_APNS_ENVIRONMENT`（默认 production）。环境配置整体优先；不完整环境不会与本机文件拼接。配置在服务启动时读取，错误时关闭推送并给出不含敏感值的诊断，其他功能保持可用。

本机服务更新/重启仍需当前任务授权，使用 `~/start.sh` 和现有 Core 排空屏障，不强停或重启 Render/terminald。仅写配置不代表已安装服务已加载新实现。

源码默认的未签名构建不声明推送环境，保留本地通知/活动，不把免费侧载误标为 APNs-ready。Ad Hoc 入口从已验证的 profile 注入 production；TestFlight 和 App Store 也使用 production。Xcode development 签名须显式设置 `WAND_APNS_ENVIRONMENT=development` 并使用匹配的 profile，服务器选择 sandbox，不能因为版本名称带 Beta/debug 就选 sandbox。若确需 sandbox，应另配具有相应环境能力的 key，并让客户端签名环境与服务配置一致。本实现不在发送失败后静默切换环境。

## 客户端与订阅边界

- 沿用“回复完成 / 等待授权通知”开关。App 每次启动向 APNs 重新注册 token，token 不缓存到本地磁盘。
- 仅当前选中且持有应用连接凭据的服务器订阅提醒。切换、断开、删除服务器、凭据变化和关通知触发撤销。关闭通知/断开当前服务器同时停止本机远程通知注册。
- `PUT /api/push/apns/subscription` 必须使用有效的应用 Bearer 凭据，不能用浏览器 Cookie 或受限执行票据替代。当前鉴权模型为一个 Wand 实例所有者共享连接凭据，不冒充已具备多用户账号隔离。
- 客户端把独立随机 256-bit 设备撤销能力保存在本机不跨设备同步的 Keychain。服务端只保存其摘要。`DELETE` 使用此能力作为 Bearer，只能撤销该设备绑定，不能登录、读取、注册或发送；因此删除旧服务器后，无需额外保存旧登录凭据即可补偿撤销。
- 注册前先可靠保存撤销能力；同一个串行 revision 循环处理注册/撤销，迟到注册回执会在下一轮撤销，不重新登录已移除服务器。
- 请求结果未知时仍保留“可能已注册”的事实，避免 APNs 和本地通知重复生成。明确不支持/拒绝后才退回本地通知；设置状态区分“已启用”和“待确认”。旧服务器无新接口时可继续原本地提醒。
- 通知只携带通用提示、稳定事件 ID、会话 ID 和客户端已保存的服务器 ID，不携带完整对话、工具参数或登录凭据。点击通知不创建新服务器、不增加权限；未知/已删除的服务器被忽略，内容通过原服务重新鉴权拉取。
- App 前台抑制普通提醒，保留原本地测试按钮。远程订阅有效时，轮询与 WebView 不再为同一类会话通知重复生成本地提醒。

## 投递策略与限制

服务端分别观察 PTY 和 structured 的权威事件，不合并执行实现。完成通知只由 SessionCompletionTracker 新建成功完成事实触发，使用 completionRevision；授权通知使用 pendingEscalation.requestId。首次订阅不重放历史完成记录。

设备代次、凭据摘要、topic/environment、有效期在每次发送前复核。密码或 app-secret 变化使旧订阅不可继续投递；失效设备响应不能撤销刚替换的新 token。

SQLite outbox 跨服务重启保留：完成提醒 TTL 1 小时，授权提醒 TTL 15 分钟；已查看、已解决、会话移除、代次变化或过期时取消。最多 1000 条待发投递、每轮最多 32 条、最多 5 次发送尝试、指数退避；队列满/失败诊断限频，推送失败不能阻塞任务执行。完成状态表述为“APNs 已接受”，不冒充设备已展示。

同一投递的 APNs ID / collapse ID 保持稳定，但网络未知回执后的重试仍是 best effort，不承诺 exactly-once 或必达。专注模式、通知授权、设备网络与 Apple 策略均可能抑制或延迟显示。

设备订阅有效期 14 天，App 回到前台续约；队列与失效记录有界清理。离线切换/删除某个服务器时，远端撤销只能等联网后补偿，期间仍可能收到通用旧服务器提醒；设置显示待撤销状态。已交给 Apple 的提醒也无法撤回。不把离线补偿、取消队列或 `unregisterForRemoteNotifications` 宣称为所有已在途提醒可立即消失。

本机 Wand 主机断网/休眠时无法实时向 APNs 发送；服务只需出站连接 Apple，不需要为推送开放新的公网入站端口。点通知读取内容时，手机仍需能访问原服务。

## 灵动岛 / Live Activity 远程更新

- 沿用同一条活动聚合当前服务器的多个会话，不给每个会话另开一个岛。活动仍在手机前台创建，`Activity.request(..., pushType: .token)` 申请的是该活动专属 token，不是普通通知设备 token；本轮不支持 App 从未打开时在后台远程创建新活动。
- iOS 持续监听 `pushTokenUpdates` 和 `activityStateUpdates`，恢复 App 时重建观察。不可变 attributes 保存已知服务器 ID、单向凭据归属指纹与远程创建标记，即使 token 未到、Keychain 还没有 binding，跨进程恢复也不能跟随新凭据；这些值不是登录凭据。旧版没有这些可选字段仍可解码；旧本地活动升级时一次性替换以获得 token，普通远程更新不重建活动。
- 独立 `PUT /api/push/apns/live-activity` 要求应用 Bearer。撤销能力与普通通知使用同一个安全 Keychain/端点有界传输实现，但账户、表、token、代次完全分开；`DELETE` 只能撤销该活动，不能撤销普通设备或取得其他 API 权限。切服、凭据变化、关灵动岛和活动结束撤销；迟到 token 不跟随新服务器，已退休活动不能重新绑定。
- Live Activity 不依赖普通通知的授权/开关；取决于“灵动岛与锁屏进度”和系统实时活动权限。服务器不把 Live Activity 的410或坏token响应传播到普通通知设备表。
- 服务端 migration21 持久化每个活动的最新状态、待发 payload、APNs ID、时间戳、重试预算。只从运行管理器实际持有的快照投影，不把遗留数据库 `running/inFlight` 列当作正在执行；原默认会话列表 DTO 不变。启动恢复未确认时不伪造完成、不刷新看似在线的状态，允许系统显示过期。
- 状态事件约2秒合并，重复的状态心跳不重置重试次数。通常每分钟低优先级5刷新一次、180秒未更新由系统标记过期；首次进入授权/完成/失败状态及结束使用10；未变化的待授权心跳或其他会话普通进度仍使用5，不发送重复声音或横幅。只有状态改变或正常心跳才新建投递，每个投递最多5次尝试；永久拒绝停止该活动重试，等待重新注册/服务重新启动。
- 内容匹配 `SessionActivityAttributes.ContentState`，最多8个会话，动态JSON整体不超过4KB。只发送有界会话标题、任务摘要、状态与计时等展示字段，经 Apple 传输；不发送原始会话、执行命令、cwd、权限目标/工具参数或登录凭据。待授权使用通用说明，完整原因回 App 查看。请按锁屏展示场景考虑标题和任务摘要的隐私。
- `aps.timestamp` / `stale-date` 使用 Unix 秒；`content-state` 中 Swift Date 使用默认 Codable 的2001参考纪元，不自定义ISO编码。时间戳跨重启持久化，时钟倒退不捏造未来进度。发送中到达的新事实不会被旧回执吞掉，旧代次失败不能禁用新 token。
- 已完成停留12秒、失败30秒，再移除；空活动发送 `event=end` 和立即移除的 `dismissal-date`。每个完成条目带独立 `finishedAt`，本地恢复按该条目的完成时间补剩余收起计时，不使用会被其他会话更新覆盖的整条活动时间；旧版缺失完成时间的条目直接清理，不猜测续期。只是关闭展示，不改变任何执行或任务状态。
- 活动沿用系统最多约8小时的生命周期，续注册不会无限续命；服务重启可恢复尚有效的待发活动。主机/设备离线、Apple预算与系统策略仍可能延迟显示，不承诺实时或必达。现有 Production Topic Specific key是否接受派生的 `<bundle-id>.push-type.liveactivity`，需在真实活动 token 出现后连同设备显示一起核验，不能拿普通推送200代替。

## 验证

```bash
bash ios/scripts/test-live-activity-push.sh   # 真实TS payload → 生产Swift Codable声明
bash ios/scripts/test-apns.sh
python3 ios/scripts/test-adhoc-signing.py
BUILD_ONLY=1 bash ios/scripts/run-tests.sh APNsTests
```

定点测试使用本地模拟 HTTP/2 服务和测试密钥，不调用真实 Apple/付费模型。涉及存储与生命周期的交付还需完整 check/test/build。Web/macOS 继续使用既有通知与 DTO，本轮新增独立 iOS 接口，不给其他端新增必填协议字段；Android 按本轮明确要求跳过。

最终验收须在安装了当前服务与签名客户端的真实 iPhone 上测试：锁屏/挂起、冷启动跳转、前台不重复提醒、拒绝/关闭权限、两类真实事件、切服务器/删除与离线撤销、token 更换、服务重启、失效 token 和专注模式。没有真机送达证据时不得说“推送已打通”。默认不自动安装或启动设备。
