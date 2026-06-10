# iOS 客户端

Wand 的 iOS 原生壳，SwiftUI + WKWebView。结构对称 `macos/` 与 `android/` 目录。

核心目标：**不充钱买 Apple Developer 账号（$99/年）也能把它装进自己的 iPhone。**

## 约定

- 工程代码放在 `ios/Wand/`
- `.app` / `.ipa` 构建产物**不要提交到仓库**（已在 `.gitignore`）
- 与 macOS/Android 壳共享同一套连接逻辑：连接码（base64 `url#token`）→ `/api/login` 拿 cookie → WebView 加载 SPA

## 与 macOS/Android 壳的关键差异：没有应用内自动更新

iOS 的自签名应用**无法自我安装更新**——安装新版本必须重新走一次签名 + 描述文件流程，这是系统层面的限制，应用自己做不到。所以本壳**删掉了** DMG/APK 那套「检查更新 → 下载 → 弹窗安装」逻辑（没有 `UpdateChecker` / `DmgInstaller`）。

更新方式改为：用你装它时用的同一个工具（AltStore/SideStore）**后台自动刷新签名**，或者出新版后**重新 sideload 一次**。

---

## 免费安装方案调研（不需要付费 Apple 账号）

iOS 不像 Android 能直接装 APK，必须借道 Apple 的「开发者签名」机制。下面三条路线**都不需要 $99/年 的付费账号**，按推荐度排序：

### 方案 A：AltStore / SideStore（推荐，免费 Apple ID 自签名）

这就是你说的「通过 UUID 自签名的方案」。原理：工具用你的**免费 Apple ID** 登录 Apple 开发者门户，按你设备的 **UDID** 生成一个临时描述文件（provisioning profile），把 IPA 重新签上你的个人开发证书再装进手机。

| 工具 | 是否需要电脑 | 自动刷新 | 说明 |
|------|------------|---------|------|
| **SideStore** | 仅首次安装需要 | ✅ 设备上后台刷新 | AltStore 的分支，不需要常驻的 AltServer。装好后用内置 VPN(StosVPN) + on-device minimuxer 在本机完成刷新，**脱离电脑也能续签**。iOS 26 推荐它。 |
| **AltStore (Classic)** | 需要同局域网常开一台跑 AltServer 的电脑 | ✅ 但要电脑在线 | 临过期时由 AltServer 经 Wi-Fi/USB 自动续签。 |
| **Sideloadly** | 每次都要插电脑 | ❌ 手动 | Windows/macOS 桌面工具，拖 IPA + 登 Apple ID + Start。无自动续签，过期得重装。 |

**免费 Apple ID 的硬限制（Apple 定的，所有工具都一样）：**
- **证书 7 天过期** → 到期前必须刷新，否则 App 打不开（这就是「7 天签名」）
- **同时最多 3 个自签 App**（含 sideload 工具本身）；配合 SideStore 的 **LiveContainer** 可绕过 3 个上限
- 每周最多注册 10 个 App ID
- 用免费 Apple ID 做个人开发签名**不会封号**；介意的话可以单独注册一个小号 Apple ID

**用本仓库产物走这条路：**
1. 在 Mac 上 `./build.sh <version>` → 得到 `dist/wand-v<version>.ipa`（未签名）
2. 把 IPA 传到手机/电脑，用 SideStore（或 AltStore/Sideloadly）打开并安装
3. 安装时登录你的免费 Apple ID，工具自动签名
4. 首次打开后，到 **设置 → 通用 → VPN与设备管理** 里**信任**你这个开发者描述文件

### 方案 B：TrollStore（永久签名，但只限部分旧系统）

这就是你说的「安装证书的方案」一类里最省心的——它利用系统签名校验的一个缺陷做到**永久签名、不用 7 天续期、不占 3 App 名额、不用电脑续签**。装一次就一直能用。

**代价：只支持特定系统版本。** 大致是 **iOS 14.0 – 16.6.1，以及 iOS 17.0**；更新的系统已经修掉了它依赖的漏洞，装不了。所以先去 **设置 → 通用 → 关于本机** 看你的 iOS 版本：
- 落在支持范围 → 强烈建议用 TrollStore，一劳永逸
- 不在范围（比如 iOS 17.1+ / 18 / 26）→ 只能走方案 A

TrollStore 怎么装它自己，取决于你的具体版本（不同版本入口不同），按官方指引来即可。装好 TrollStore 后，把本仓库 `build.sh` 产出的 IPA 用 TrollStore 打开 → Install，就永久装好了。

### 方案 C（不推荐）：第三方「企业证书」签名站

网上有些站点用**企业证书（Enterprise Certificate）** 帮你签名安装（不用电脑、不用 7 天续）。但这类证书是别人盗用/共享的，Apple 一旦吊销，所有用它签的 App 当场全部失效，且证书可能被植入风险。**不建议**，这里只为完整性提及。

---

## 决策速查

```
你的 iPhone 系统版本？
├─ iOS 14.0–16.6.1 或 17.0  → 用 TrollStore（永久，最省心）
└─ 其它（17.1+ / 18 / 26…） → 用 SideStore（免费 Apple ID，7 天自动刷新）
```

## 端到端操作手册（iOS 17.1+，云端编译 + Mac 装机）

**第一步：拿到 IPA**（见下文「云端构建」——Actions 手动跑一次，下载 artifact 解压出 `wand-v*.ipa`）

**第二步：装机。两条路按需选一：**

### 路线 1：AltStore（步骤最少；要求 Mac 经常开机在同一 Wi-Fi）

1. Mac 上从 [altstore.io](https://altstore.io) 下载 **AltServer**，拖进「应用程序」并打开（它住在菜单栏，没有窗口）
2. iPhone 用 USB 线连 Mac，解锁并「信任此电脑」
3. 菜单栏 AltServer 图标 → **Install AltStore** → 选你的 iPhone → 输入 Apple ID（介意可注册个小号）
4. iPhone：**设置 → 通用 → VPN与设备管理** → 信任你 Apple ID 对应的开发者 App
5. iPhone：**设置 → 隐私与安全性 → 开发者模式** 打开并重启（iOS 16+ 必须）
6. 装 wand：把 IPA AirDrop 到 iPhone，用 **AltStore → My Apps → ＋** 选中安装；或在 Mac 上按住 **Option 点 AltServer 菜单图标 → Sideload .ipa**
7. 续期：只要 iPhone 和跑着 AltServer 的 Mac 在同一 Wi-Fi，AltStore 会在 7 天到期前自动后台刷新

### 路线 2：SideStore（首次配置多几步；之后完全脱离电脑自动续签）

1. 先按路线 1 的第 1、2、5 步装好 AltServer、连好手机、开好开发者模式
2. 从 [docs.sidestore.io](https://docs.sidestore.io) 下载 **SideStore.ipa**，Mac 上 **Option 点 AltServer 菜单图标 → Sideload .ipa** 装进手机，并在「VPN与设备管理」里信任
3. 用 [iDevice Pair](https://docs.sidestore.io/docs/advanced/pairing-file) 生成**配对文件**（`.mobiledevicepairing`）导入 SideStore（USB 连接状态下生成）
4. iPhone 装 **StosVPN**（App Store 免费），按 SideStore 提示启用
5. SideStore 里登录 Apple ID，然后用 SideStore 打开/导入 wand IPA 安装
6. 之后续签全在手机上后台自动完成，不再需要电脑；iOS 系统升级后配对文件会失效，重做第 3 步即可

> 两条路线装好后，免费 Apple ID 的「3 个自签 App」名额都包含 AltStore/SideStore 本身 + wand，共占 2 个，还剩 1 个富余。

---

## 云端构建（无需 Mac，推荐）

没有 Mac 也能出 IPA：用 GitHub Actions 的免费 `macos-latest` runner 在线编译。

工作流：`.github/workflows/ios-build.yml`

1. GitHub 仓库 → **Actions** → 左侧选 **iOS IPA Build** → **Run workflow**（可填版本号，默认 `0.0.0-dev`）
2. 等几分钟跑完，进入这次 run 的页面，最下方 **Artifacts** 里下载 `wand-ios-ipa-<版本>`
3. 解压得到 `wand-v<版本>.ipa`（GitHub artifact 是个 zip，里面才是 IPA）

> 用**手动触发（Run workflow）**出包即可，不要为了编译去打 tag——打 `v*` tag 会同时触发 npm/Android/macOS 的正式发布。tag push 时本工作流也会把 IPA 顺带传到对应 Release。

## 本地构建（仅 macOS）

```bash
./build.sh 1.16.0
# 产物：build/Wand.app + dist/wand-v1.16.0.ipa（未签名）
```

要求：

- macOS 12+
- 安装了 Xcode 15+（命令行工具 `xcodebuild` 足够）
- **不需要 Apple Developer 账号**（产物未签名，签名在安装时完成）

构建产物是**未签名 IPA**，直接交给 AltStore/SideStore/Sideloadly/TrollStore 安装即可。

## 工程结构

```
ios/
├── README.md                  # 本文件
├── build.sh                   # 构建未签名 IPA
├── scripts/
│   └── generate-icons.swift   # 生成 1024 单尺寸 App 图标
└── Wand/
    ├── App.swift              # @main 入口（WindowGroup）
    ├── ContentView.swift      # 容器：已连接→WebView+切换按钮 / 未连接→ConnectView
    ├── ConnectView.swift      # 连接界面（连接码 / 地址 + 最近连接）
    ├── WebContainerView.swift # UIViewRepresentable 包 WKWebView + 加载/错误覆盖层
    ├── WebBridge.swift        # 导航委托 + 自签名证书放行 + JS 桥（无自动更新）
    ├── ServerStore.swift      # UserDefaults 持久化连接状态
    ├── WandAuth.swift         # 连接码解码 / token 登录 / 可达性探测（与 macOS 共享逻辑）
    ├── SelfSignedSession.swift# 放行 wand 自签名 HTTPS 的 URLSession
    ├── Theme.swift            # Claude 珊瑚橙主题 + 复用按钮样式
    ├── Info.plist             # ATS 放行任意加载 + 本地网络权限说明
    └── Assets.xcassets/       # AppIcon / AccentColor
```

## 设计要点

- **自签名 HTTPS 放行**：wand 默认用 `cert.ts` 生成自签名证书，`WebBridge` 和 `SelfSignedSession` 对 ServerTrust 一律放行，等价 Android 的 `trustSelfSigned()`。
- **ATS**：`NSAllowsArbitraryLoads = true`，因为要连局域网 HTTP 地址和自签名 HTTPS。
- **本地网络权限**：`NSLocalNetworkUsageDescription`，iOS 14+ 连局域网设备会弹一次授权。
- **切换服务器入口**：iOS 没有菜单栏，连接后在右上角放一个低调的半透明悬浮按钮，点击弹出切换面板（macOS 是用菜单 + 通知，二者共用 `.wandRequestSwitchServer` 通知）。
- **bundle id**：`com.wand.app`，与 macOS 端一致。免费签名时工具可能会改写它，不影响使用。
- **entitlements**：刻意**不带**特殊 entitlements（推送 / App Groups 等），保持最干净，最大化兼容免费账号签名——带了反而可能签名失败。

## 注意

- 服务端目前**没有** iOS 的更新检查端点（不像 `/api/macos-dmg-update`），因为 iOS 不做应用内更新。若以后要做「提示有新版，请到 SideStore 刷新」之类的轻提醒，可以另加一个只读端点，但不要尝试在应用内直接安装。
- 不要随意更换 bundle id 或签名身份的预期：用同一工具、同一 Apple ID 续签才能平滑升级；换了就要先删旧 App 再装。
