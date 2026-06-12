# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install                # Install dependencies (requires Node.js >= 22.5.0)
npm run check              # bundle browser scripts → regenerate embedded assets → tsc --noEmit (server tsconfig.json + browser tsconfig.browser.json)
npm run build              # bundle wterm → bundle qrcode → bundle browser → generate embedded assets → tsc → copy+minify src/web-ui/content into dist/web-ui/ → stamp dist/build-info.json → fix dist permissions
npm run dev                # bundle browser scripts + regenerate embedded assets, then run src/cli.ts web via tsx
node dist/cli.js init      # Create or refresh config + SQLite files
node dist/cli.js web       # Start the packaged web server from dist/
wand config:path           # Print resolved config path
wand config:show           # Print merged runtime config
wand config:set host 0.0.0.0  # Update a simple config value
wand service:install          # Install + start as systemd (Linux) / launchd (macOS) service; --user for user-level
wand service:status           # Service state; also :start :stop :restart :logs :uninstall
```

`wand web` is single-instance per config: if a wand instance is already running, it **attaches** (TUI or banner) instead of starting a second server. In a TTY it renders a neo-blessed TUI dashboard; set `WAND_NO_TUI=1` to force the plain one-line banner. `wand service:*` flags: `--user`/`--system` (default system, needs root), `--verbose`, `--lines <N>` (for `service:logs`).

There is no automated test suite, no single-test command, and no lint/format script in this repo.

**Recommended validation after TS or UI changes:**
```bash
npm run check
npm run build
```

**Smoke test:**
```bash
npm run build && wand init && wand web
```

**Isolated dev server with disposable data:**
```bash
npm run dev -- -c /tmp/wand-test/config.json
```
This keeps config, database, and session artifacts under `/tmp/wand-test/`. The same `-c` flag also works with the compiled binary (`wand web -c /tmp/wand-test/config.json`).

**Testing server (use this for all QA / smoke tests):**
```bash
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json
```
The test config at `/tmp/wand-dev/config.json` should use its own port (edit the `port` field after first `init`). Working directory for test tasks: `/tmp/wand-dev/workspace/`. This keeps QA isolated from any other wand instance you happen to be running.

**Manual browser QA / release verification:** Open the test server in a browser and verify login, session creation, chat/terminal views, permission prompts, and resume.

**Install flow from README:**
```bash
npm install -g @co0ontty/wand
wand init
wand web
```
The runtime config file is `~/.wand/config.json` by default.

**Repo-specific notes:**
- `npm run dev` already runs `src/cli.ts web`; append CLI flags after `--`. It re-runs `bundle-browser` + `generate-web-assets` on each start, but does **not** rebundle wterm/qrcode.
- `loadConfigWithStorage()` rewrites the config file with defaults merged in, so config-schema changes must also update `src/config.ts`.
- Browser-side code lives in `src/web-ui/browser/*.ts` (entry `main.ts`). `scripts/bundle-browser.js` (esbuild) emits `src/web-ui/content/scripts.js` — that file is **generated, never hand-edit it**. `src/web-ui/content/styles.css` is still hand-edited source.
- `scripts/generate-web-assets.js` minifies `scripts.js` + `styles.css` and base64-embeds them (plus the wterm/qrcode vendor bundles) into `src/web-ui/embedded-assets.ts` — also generated, never hand-edit. The server serves assets from this module; `styles.ts`/`scripts.ts` add an mtime-based cache so editing files under `dist/` is picked up without restarting.
- `npm run build` must keep copying `src/web-ui/content/` into `dist/web-ui/`; the packaged app depends on those static assets.
- `scripts/bundle-wterm.js` uses esbuild to bundle `@wterm/dom` into `src/web-ui/content/vendor/wterm/wterm.bundle.js` and copies `terminal.css` next to it. It also patches the renderer to strip an underline branch (`stripUnderlinePlugin`). After changing wterm-related code or upgrading `@wterm/dom`, you must re-run this script — `npm run dev` does not rebundle it automatically. The committed bundle is what the browser loads.
- `scripts/bundle-qrcode.js` similarly bundles the `qrcode` npm package (entry `scripts/qrcode-entry.js`) into `src/web-ui/content/vendor/qrcode/qrcode.bundle.js`, used by the browser to render the mobile-connect QR code. Re-run it after upgrading `qrcode`. `npm run build` runs both vendor bundlers before `tsc`.

## Client Shells as Submodules

三个客户端壳应用是独立仓库，主仓库以 git submodule 引用（`.gitmodules` 用 https URL，CI 与匿名 clone 可直接拉取）：

| 路径 | 仓库 |
|------|------|
| `android/` | [co0ontty/wand-android](https://github.com/co0ontty/wand-android) |
| `macos/` | [co0ontty/wand-macos](https://github.com/co0ontty/wand-macos) |
| `ios/` | [co0ontty/wand-ios](https://github.com/co0ontty/wand-ios) |

- 克隆后先 `git submodule update --init`（`publish.sh` 构建前也会自动执行）。
- **改客户端代码的流程**：在 submodule 目录里 commit 并 push 到子仓库（本地推送用 ssh URL：`git push git@github.com:co0ontty/wand-<平台>.git HEAD:master`），然后回主仓库 `git add <目录>` 提交 submodule 指针更新。只改主仓库指针而忘了 push 子仓库，CI 会因拉不到对应 commit 而失败。
- 三个 release/build workflow 的 checkout 都带 `submodules: true`；beta-branch / npm-release / release-notes 不需要客户端代码，不拉 submodule。

## Android APK Build & Deployment

项目包含一个 Android **原生客户端**（Kotlin + Jetpack Compose，会话列表 / 聊天 / 新建会话 / 权限审批 / 设置直连 REST + `/ws`，对称 iOS 原生客户端；WebView 的 MainActivity 仅作设置页「网页版」兜底入口），源码在 `android/` 目录（git submodule → `co0ontty/wand-android`）。原生层结构：`data/`（WandHttp OkHttp 单例 + WandModels org.json 容错解析 + WandApi + WandSocket，合流/重连语义逐行对齐 `ios/Wand/ChatStore.swift` 与 `WandSocket.swift`）、`ui/`（ChatStore 状态机 + Compose 屏幕）。原有 Java 辅助类（ServerStore / NotificationHelper / UpdateManager / WandForegroundService / QR 扫码）原样复用，更新检查迁到 HomeActivity 启动时，图标切换抽取为 `AppIconSwitcher` 供原生与 WebView 桥共用。`updateSessionProgress` 网页驱动的进度通知与任务完成通知（sendNotification）在原生主路径下暂缺，待由原生 WS/前台服务驱动（v1.1）。聊天输入栏带**按住说话端侧语音识别**（`speech/` 模块）：sherpa-onnx 流式中文 CTC 模型优先（按需下载约 26MB，hf-mirror 镜像优先，下载到 `filesDir/asr/`）、系统 SpeechRecognizer 兜底（国产无 GMS ROM 上普遍不可用，所以 sherpa 是主路径）；`app/libs/` 里**提交了** sherpa-onnx static-link AAR（38MB，JitPack 对 k2-fsa 新 tag 构建失败所以钉本地文件），`abiFilters` 仅 arm64-v8a、`useLegacyPackaging=true` 压缩 .so（APK 下载体积约 +9MB）。

**编译 APK：**
```bash
cd android
# 使用最新 git tag 作为版本号，加 debug 时间戳后缀。
# versionCode 一律由 build.gradle 从 versionName 派生（唯一真源，不接受 -PAPP_VERSION_CODE 覆盖）：
#   major*10_000_000 + minor*10_000 + patch*100 + (含 -debug ? 1 : 0)
# 同三段时 debug(+1) > release(+0)——debug 是 tag 之后的 master 构建，比同号 release 新；
# 下一个 release（patch+1 = base+100）仍高于任何同段 debug。
# 历史教训：CI 曾另算一套小数字 versionCode，与本公式并存后，装过本地构建（大 versionCode）
# 的设备升级任何 CI 包都会被系统按「降级」拒装（INSTALL_FAILED_VERSION_DOWNGRADE）。
./gradlew assembleDebug \
  -PAPP_VERSION_NAME="$(git describe --tags --abbrev=0 | sed 's/^v//')-debug.$(date +%m%d%H%M)"
```
产物：`android/app/build/outputs/apk/debug/app-debug.apk`

**部署 APK 供下载：**

服务端通过 `config.android.apkDir`（相对于 config 目录）查找 APK 文件，按修改时间取最新的。

| 环境 | Config 目录 | APK 目录 |
|------|------------|---------|
| 默认 | `~/.wand/` | `~/.wand/android/` |
| 隔离测试 | `/tmp/wand-dev/` | `/tmp/wand-dev/android/` |

如果同时在跑默认实例和隔离测试实例，APK 两个目录都要放，否则切到哪个实例就只能下到那边的版本。

```bash
# 编译后同时部署到两个目录（按需）
cp android/app/build/outputs/apk/debug/app-debug.apk ~/.wand/android/wand-v<VERSION>.apk
cp android/app/build/outputs/apk/debug/app-debug.apk /tmp/wand-dev/android/wand-v<VERSION>.apk
```

**版本号规则：**
- 文件名中必须包含语义化版本号（如 `wand-v1.13.2.apk`），服务端通过正则 `(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)` 提取
- 版本号必须高于当前已安装版本，APK 端才会触发更新弹窗（`compareSemver` 比较）
- 开发调试时用 `-debug.MMDDHHMM` 后缀区分构建

**APK 下载来源优先级：**
1. 本地文件（`apkDir` 目录中最新的 `.apk`）→ source: `"local"`
2. GitHub Release 回退 → source: `"github"`

设置页面会显示来源标签（本地/线上）。

**图标切换：**
APK 支持运行时切换启动器图标（赛博虎妞 / 勤劳初二），通过 `AndroidManifest.xml` 中的 `<activity-alias>` 和 `PackageManager.setComponentEnabledSetting` 实现。相关 drawable 资源：
- `ic_launcher_foreground.xml` / `ic_launcher_background.xml` — 虎妞（灰猫）
- `ic_launcher_foreground_garfield.xml` / `ic_launcher_background_garfield.xml` — 初二（橙猫）

**签名 keystore（重要）：**
仓库根目录提交了 `android/wand-release.keystore`（密码 `wand-release`，alias `wand`），`app/build.gradle` 把它配成 debug 和 release 共用的 signingConfig。这样本地、`publish.sh`、GitHub Actions 三种构建出来的 APK 签名一致，用户在不同来源升级时不会撞上"签名冲突"。

**注意：** 这是自签名分发用 key，不是 Play Store 上传 key。也因此**绝不要换 keystore**——一旦换了，所有已安装的旧版 APK 都会因签名不匹配而无法升级，必须先卸载。

## macOS DMG Build & Deployment

项目包含一个 macOS WebView 壳应用（SwiftUI + WKWebView），源码在 `macos/` 目录（git submodule → `co0ontty/wand-macos`）。

**编译 DMG（仅 macOS）：**
```bash
cd macos
./build.sh 1.16.0
# 产物：build/Wand.app + dist/wand-v1.16.0.dmg
```

要求：macOS 12+、Xcode 15+ 命令行工具。**不需要 Apple Developer 账号**（ad-hoc 自签名）。

**部署 DMG 供下载：**

服务端通过 `config.macos.dmgDir`（相对于 config 目录）查找 DMG 文件，按修改时间取最新的。

| 环境 | Config 目录 | DMG 目录 |
|------|------------|---------|
| 默认 | `~/.wand/` | `~/.wand/macos/` |
| 隔离测试 | `/tmp/wand-dev/` | `/tmp/wand-dev/macos/` |

```bash
cp macos/dist/wand-v<VERSION>.dmg ~/.wand/macos/wand-v<VERSION>.dmg
cp macos/dist/wand-v<VERSION>.dmg /tmp/wand-dev/macos/wand-v<VERSION>.dmg
```

需要在 `config.json` 里把 `macos.enabled` 改成 `true` 才会启用下载入口：

```json
{
  "macos": {
    "enabled": true,
    "dmgDir": "macos",
    "currentDmgFile": ""
  }
}
```

**版本号规则：**
- 文件名中必须包含语义化版本号（如 `wand-v1.16.0.dmg`），服务端正则 `(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)` 提取
- 版本号必须高于已安装版本，macOS 端才会触发自动更新弹窗

**DMG 下载来源优先级：**
1. 本地文件（`dmgDir` 目录中最新的 `.dmg`）→ source: `"local"`
2. GitHub Release 回退 → source: `"github"`

设置页面会显示来源标签（本地/线上），等同 Android APK 段。

**签名 keystore（重要）：**
macOS 端使用 **ad-hoc 自签名**（`codesign --sign -`），等同 Android 自签名 keystore，不需要 Apple Developer 账号。

用户首次打开 `Wand.app` 必须**右键 → 打开 → 打开**（不要双击），系统会一次性允许"未公证开发者"的应用。

**注意：** 一旦换签名身份（比如未来上 Developer ID），所有已安装的旧版用户升级时会撞"代码签名变化"被 Gatekeeper 拦截。如果换签名，必须卸载旧版后重装。

**为什么不用 Sparkle / 公证：**
- Sparkle 引入第三方依赖与 EdDSA 签名密钥管理
- 公证（notarization）需要 Apple Developer Program（$99/年）+ `notarytool` 凭据
- 与"自分发 ad-hoc"目标不符 — 用"首次右键打开"换取零依赖、零账号成本

**架构：Universal Binary**

`build.sh` 输出 arm64 + x86_64 Universal Binary，在 Apple Silicon 与 Intel Mac 上都原生运行。

**自动更新流程：**

App 启动 5 秒后异步调 `/api/macos-dmg-update?currentVersion=<X>` → 弹 `NSAlert`（立即更新/稍后/跳过）→ `URLSession.downloadTask` 下载到 `~/Library/Application Support/Wand/` → `hdiutil attach -nobrowse -mountpoint` 挂载 → `NSWorkspace.open` 在 Finder 显示挂载点 → 用户拖拽 Wand.app 到 Applications。

对称 Android 的 `Intent.ACTION_VIEW`：把"实际安装"交回系统/用户决策，避免覆盖运行中的 `/Applications/Wand.app` 带来的权限与重启问题。

## iOS IPA Build & Sideload

项目包含一个 iOS **原生 SwiftUI 客户端**（会话列表 / 聊天 / 输入 / 权限审批直连 REST + `/ws`，WKWebView 仅作「网页版」兜底入口），源码在 `ios/` 目录（git submodule → `co0ontty/wand-ios`）。原生化是为了根治 WebView 在移动端的键盘重叠、状态栏错位问题；与 `macos/`（纯 WebView 壳）不再对称。协议对接速查与完整安装手册见 `ios/README.md`。聊天输入栏带**按住说话端侧语音识别**（`SpeechRecognizerService.swift`）：SFSpeechRecognizer 端侧听写模型优先（`requiresOnDeviceRecognition`，设备没下载模型时降级 Apple 服务器识别），只需 Info.plist 两条隐私描述、零 entitlement，免费自签不受影响。

**编译（产物是未签名 IPA）：**
```bash
cd ios && ./build.sh 1.16.0   # 仅 macOS + Xcode 15+；产物 dist/wand-v1.16.0.ipa
```
没有 Mac 时用 GitHub Actions：`.github/workflows/ios-build.yml` 支持 `workflow_dispatch` 手动触发（IPA 作为 artifact 下载）；push `v*` tag 时也会把 IPA 上传到对应 Release。`cleanup-old-releases.yml` 同样清理老 release 的 `.ipa`。

**与 Android/macOS 壳的关键差异：**
- **不签名**：`build.sh` 用 `CODE_SIGNING_ALLOWED=NO` 出未签名 IPA，签名在**安装时**由 sideload 工具（AltStore / SideStore / Sideloadly / TrollStore）用用户自己的免费 Apple ID 现场完成。免费 Apple ID 限制：证书 7 天过期、同时最多 3 个自签 App。
- **没有应用内自动更新**：iOS 自签名应用无法自我安装更新（系统限制），所以没有 `UpdateChecker`/`DmgInstaller`，服务端也**没有** iOS 更新端点（不存在 `config.ios`/`ipaDir`，不像 `apkDir`/`dmgDir`）。更新靠 sideload 工具续签或重新安装。
- **无 entitlements 文件**：刻意保持零特殊权限，最大化免费账号签名兼容性。
- bundle id `com.wand.app` 与 macOS 端一致；sideload 工具签名时可能改写它，属正常现象。

## Update Channels & Self-Repair

服务端更新（`src/server.ts` 的 `/api/update`、`performAutoUpdate`，以及 TUI installUpdate）支持两个通道，状态存在 SQLite app_config 的 `updateChannel`（`stable` | `beta`，默认 stable），设置页「Web 端」更新区有「Beta 通道」开关，对应 `GET/POST /api/update-channel`。

- **stable**：`npm install -g @co0ontty/wand@latest`，按 semver 判定更新（`checkNpmLatestVersion` + `compareSemver`）。
- **beta**：`npm install -g github:co0ontty/wand#beta`，更新到「最新 commit 构建」。`.github/workflows/beta-branch.yml` 在每次 push master 时 `npm run build`（设 `WAND_BUILD_CHANNEL=beta`），把含预编译 `dist/` 的产物 force-push 到 `beta` 分支；因为 beta 分支带 dist 且无 `prepare` 脚本，`npm install` 免现场构建、免装 devDeps。是否有更新按 commit SHA 比对：本地 `dist/build-info.json` 的 `commit` vs `https://raw.githubusercontent.com/co0ontty/wand/beta/dist/build-info.json` 的 `commit`（`checkBetaUpdate`）。切回 stable 时，若当前跑的是 beta 构建会强制提示可更新，便于装回干净正式版。

`dist/build-info.json`（`{ commit, builtAt, version, channel }`）由 `scripts/stamp-build-info.js` 在 `npm run build` 末尾生成，server 端 `readBuildInfo()` 读它做 beta 比对与 UI 展示。正式版（本地 / publish.sh / npm-release CI）stamp `channel=stable`，beta 分支 CI stamp `channel=beta`。

**更新后服务自修复**（镜像 `install.sh`）：装包成功后调用 `src/service-self-repair.ts` 的 `repairServiceUnitAfterUpdate()` —— 若装了 systemd/launchd 服务，用 `preferGlobalBin` 重写 unit（ExecStart 钉到全局 `dist/cli.js`、`Environment=PATH` 取已被 `path-repair` 修复的 `process.env.PATH`）+ daemon-reload，解决「源码安装升级到 npm/GitHub 版后 ExecStart/PATH 失效、服务找不到」。重启统一走 `src/relaunch.ts` 的 `computeRelaunch()`：systemd 托管（存在 `INVOCATION_ID`）且已装服务时仅退出、交给 `Restart=always` 用新 unit 拉起，避免 detached 子进程与 systemd 抢单实例 pidfile 跑回旧二进制；否则 spawn 一个 detached 子进程（bin 优先全局安装）。

**APK 的 beta 通道已实现**：`GET /api/android-apk-update?currentVersion=X&channel=stable|beta`（不带参默认 stable，兼容老客户端）——stable 只看正式版文件（版本号无 prerelease 后缀），beta 额外包含 `-debug.MMDDHHMM` 构建（本地 apkDir 是 beta 包唯一来源；GitHub 回退只有正式版，两通道共用）。更新提示的下载链接始终带 `?channel=`，保证「提示的版本」和「下载到的文件」同通道；裸 `/android/download`（网页下载页/二维码落地页）默认 beta = 目录里真正最新的包。Android 设置页「更新」区有 Beta 通道开关（SharedPreferences `update_beta_channel`，`ServerStore.isBetaChannel`），`UpdateManager.checkForUpdate` 按它带 channel 参数。`/api/settings`、`/api/android-apk` 管理视图固定 beta 视角（展示目录真实最新文件）。macOS DMG 的 beta 通道尚未实现。

## Publishing & Release

版本号由 git tag 驱动。**发布全部交给 GitHub Actions**——push 一个 `v*` tag 即可：

```bash
git tag v1.15.0
git push origin v1.15.0
```

push tag 后四个 workflow 并行触发：
- `.github/workflows/npm-release.yml`（`ubuntu-latest`）：从 tag 同步版本号到 `package.json` → `npm ci` → `npm run build` → `npm publish --access public`。需要仓库 secret **`NPM_TOKEN`**（npm Automation / Granular Access token，对 `@co0ontty/wand` 有读写权限）。
- `.github/workflows/android-release.yml`（`ubuntu-latest`）：构建 APK 上传到对应 Release（**不动 release body**）。
- `.github/workflows/macos-release.yml`（`macos-latest`）：构建 DMG 上传到对应 Release（**不动 release body**）。
- `.github/workflows/release-notes.yml`（`ubuntu-latest`）：**单点负责 release body**——从 `git log <prev-tag>..<current-tag>` 拼真 changelog（项目直接推 master 不走 PR，所以 `generate_release_notes` 拿到的 PR 列表是空的，必须自己从 commits 拼），再附上 Android / macOS 下载说明段落，最后用 `softprops/action-gh-release` 一次性写入 body。其他三个 release 工作流都不再 `append_body`，避免多源写 body 撞车。第一个 release 没有前 tag 时 fallback 成「列出 tag 之前的全部 commits」。

**客户端无改动时跳过构建**：android-release / macos-release / ios-build 三个 workflow 在 tag 触发时会比较当前 tag 与上一个 tag（semver 降序的下一个）的 submodule 指针（`git rev-parse <tag>:<dir>`），指针没动就跳过整个构建、不往本 release 上传产物（ios 的 `workflow_dispatch` 手动触发不受此限制，永远构建）。配套行为：
- 服务端 GitHub 回退（`fetchGitHubReleaseAssetByExt`）不再只查 `/releases/latest`，而是按时间倒序遍历最近 30 个 release，取第一个带 `.apk`/`.dmg` 的；版本号**优先从 asset 文件名提取**（老包挂在老 release 上，用 tag 当版本会造成「提示新版、下载到旧包」的假更新循环）。
- release-notes.yml 会检测同样的指针变化：客户端无改动的版本，release body 的下载段落指向最后真实出包的那个 release。

新 release 发完后还会自动触发 `.github/workflows/cleanup-old-releases.yml`：按 tag 的 semver 降序保留最近 **10** 个 release 的产物，更老的 release **页面与 release notes 不动**，但把它们身上的 `.apk` / `.dmg` 删掉，避免 GitHub Release 长期堆积二进制。手动跑（`workflow_dispatch`）可改 `keep` 参数。当前触发本次清理的 release 永远不会动到自己的 assets（防止"补丁回填到老 minor"被误删）。另外每类产物（apk/dmg/ipa）**全局至少保住一个**：若保留窗口内某类产物因连续跳过构建而完全缺失，窗口外最新的那一个不删——服务端向前遍历 release 找包依赖它。

`publish.sh` 现在**只做本地构建 + 把 APK/DMG 部署到 `~/.wand/{android,macos}/`** 供本地实例分发，**不再 `npm publish`**（避免和 CI 撞 "version already exists"）。本地日常用 `start.sh`，正式发版用「打 tag + push」。

`install.sh` 是面向终端用户的一键安装脚本（自动装 Node.js 22+，然后 `npm install -g`）。

## Additional References

- `README.md` contains the end-user install/start flow (`npm install -g @co0ontty/wand`, `wand init`, `wand web`).
- There is no `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` in this repo.
- `.github/workflows/npm-release.yml` handles GitHub Actions npm publish on tag push (needs `NPM_TOKEN` secret).
- `.github/workflows/android-release.yml` handles GitHub Actions APK builds on tag push.
- `.github/workflows/macos-release.yml` handles GitHub Actions DMG builds on tag push (runs on `macos-latest`).
- `.github/workflows/release-notes.yml` owns the release body: generates a real changelog from `git log <prev>..<current>` (PR-based auto-notes are empty for this repo) and appends Android/macOS download sections. Other release workflows must NOT touch the body.
- `.github/workflows/cleanup-old-releases.yml` prunes `.apk` / `.dmg` from older releases after each `release: published`, keeping the 10 most recent (by semver) intact. Manual `workflow_dispatch` accepts a `keep` input.

## Architecture

`wand` is a Node.js web console for local CLI tools such as Claude Code and Codex. The app starts from a CLI command, serves a browser UI over Express + WebSocket, launches commands inside PTYs with `node-pty` (or as one-shot streamed processes for the structured runner), and persists session/auth state in SQLite under `~/.wand/`. A single session is tagged with a `SessionRunner` (`claude` / `codex` / etc.) and an `ExecutionMode` that picks between the PTY runner and the structured runner — see "Two session runners" below.

### Runtime flow

1. `src/cli.ts` is the only entrypoint. It parses `wand init`, `wand web`, `config:*`, and `service:*`, resolves `-c/--config`, and always ensures config + SQLite files exist before startup. `wand web` is single-instance: if `pidfile.ts` reports a live instance it attaches over the IPC socket instead of starting a second server.
2. `src/server.ts` wires the whole application together: Express routes, auth/session APIs, file browser APIs, update endpoints, static assets, and the `/ws` WebSocket server.
3. `ProcessManager` in `src/process-manager.ts` is the core runtime owner for PTY-backed sessions. It launches commands, persists snapshots, handles resume/auto-recovery, watches for confirmation prompts, and bridges UI input back into the process.
4. `ClaudePtyBridge` in `src/claude-pty-bridge.ts` parses Claude PTY output into structured conversation turns, permission events, task/tool updates, and captured Claude session IDs while preserving raw terminal output in parallel.
5. The browser UI subscribes over `/ws` and renders the same session in two synchronized representations: terminal output and structured chat history.

When debugging a user-visible session bug, trace the full chain: `cli.ts` -> `server.ts` -> `process-manager.ts` -> `claude-pty-bridge.ts` -> web UI.

### Two session runners

A session can run in one of two modes, owned by different managers:

- **PTY runner** (`src/process-manager.ts`) — interactive PTY-backed sessions for `claude` / `codex` / shells. This is the default and drives both the terminal view and (via `ClaudePtyBridge`) the structured chat view. Permission prompts, resume, archive/idle transitions and most lifecycle logic live here.
- **Structured runner** (`src/structured-session-manager.ts`) — non-PTY sessions for prompts that don't need an interactive terminal. It runs Claude two ways: the CLI runner (`claude -p --output-format stream-json`) and the **Agent SDK** (`query()` from `@anthropic-ai/claude-agent-sdk`, with live handles tracked in `pendingSdkQueries` so a run can be interrupted). Both paths consume streamed JSON output; output debounce is 16 ms (`STREAM_EMIT_DEBOUNCE_MS`). It shares `WandStorage`, `SessionSnapshot`, and `ProcessEvent` types with the PTY runner, and can also use git worktrees via `prepareSessionWorktree()`. These runs are non-interactive — there is no permission prompt, so `mcp__*` tools fail rather than escalate.

When debugging session behavior, first check which runner owns the session — they share types but execute on independent code paths.

### Process model: single instance, TUI, and system service

`wand web` runs as one instance per config. On launch it checks `pidfile.ts` for a live instance:
- **No instance** → start the Express/WebSocket server, write a pidfile, and start an IPC server over a unix socket (`src/tui/ipc-server.ts`). In a TTY it then renders the neo-blessed TUI dashboard (`src/tui/index.ts`); otherwise it prints a one-line startup banner (`WAND_NO_TUI=1` forces the banner).
- **Live instance** → *attach* over the IPC socket (`src/tui/attach.ts`) instead of starting a second server.

`src/tui/` is a self-contained subsystem: the dashboard/attach UI, the IPC protocol/client/server, and the **system-service** commands (`commands.ts`) behind `wand service:*` — systemd units on Linux (`/etc/systemd/system` for `--system`, `~/.config/systemd/user` for `--user`) and launchd plists on macOS. Because a service unit freezes `PATH` at install time, `src/path-repair.ts` re-derives `PATH` at runtime so a spawned `claude` keeps resolving after the user switches Node versions (nvm/fnm/volta) or reinstalls without re-running `service:install`.

Auxiliary Claude features — quick-commit messages (`git-quick-commit.ts`) and prompt optimization (`prompt-optimizer.ts`) — use neither session runner; they call `claude-sdk-runner.ts`'s one-shot `runClaudePrint()` through the Agent SDK.

### API and UI boundary

`src/server.ts` is also the backend surface for the app. It serves:
- the single HTML shell from `renderApp()` in `src/web-ui/index.ts`
- REST endpoints for auth, config/settings, sessions, path browsing/search, favorites/recent paths, command launch, resume, PTY input/resize, permission decisions, and updates
- the `/ws` fanout used for live session state

Session-specific HTTP routes live in `src/server-session-routes.ts`; `src/server.ts` remains the composition root that injects `ProcessManager`, storage, auth, and broadcast plumbing.

Before adding a new abstraction, check whether the needed data can fit into an existing `/api/*` route or `ProcessEvent` payload.

### State and persistence

- Config lives in `~/.wand/config.json`; `loadConfigWithStorage()` in `src/config.ts` loads the file, merges defaults (plus SQLite preference overrides), and writes the normalized result back to disk.
- SQLite lives beside the config (`resolveDatabasePath(configPath)`), usually `~/.wand/wand.db`; `src/storage.ts` stores auth sessions, command sessions, app config overrides, Claude resume metadata, and serialized `ConversationTurn[]`.
- Schema migration policy is additive only: `ensureCommandSessionSchema()` adds missing columns and never drops old ones.
- `src/session-logger.ts` writes per-session artifacts under `~/.wand/sessions/<sessionId>/`, including rotating PTY logs, structured messages, metadata, native stream events, and shortcut interaction logs.
- Two more directories live **inside the session's working directory**, not under `~/.wand/`:
  - `<session.cwd>/.wand-uploads/` — uploaded files written by `src/upload-routes.ts` (10 MB per file, max 5 files per request, filenames sanitized to `[a-zA-Z0-9._-]`).
  - `.wand-worktrees/` (at the repo root when worktree mode is enabled) — per-session git worktrees created and cleaned up by `src/git-worktree.ts`. Snapshots store the worktree handle on `SessionSnapshot.worktree`.

If persistence looks inconsistent, inspect both SQLite (`src/storage.ts`) and file-based session artifacts (`src/session-logger.ts`); they are complementary, not redundant.

### Session and resume model

A session is not just a child process. `SessionSnapshot` in `src/types.ts` combines PTY state, buffered output, structured messages, lifecycle state, permission/escalation state, and optional Claude resume linkage (`claudeSessionId`, resumed-from/to fields, auto-recovery flags).

Resume behavior is split across multiple layers:
- `ProcessManager` decides when a session is resumable, restores snapshots, and scans Claude project JSONL history under `~/.claude/projects/`
- `ClaudePtyBridge` captures Claude session UUIDs from PTY output
- `resume-policy.ts` contains the heuristics for binding stored Claude history to wand sessions
- `storage.ts` persists both raw output and structured messages
- server routes expose session resume and Claude-history resume actions

If resume buttons, recovered sessions, or chat history look wrong, inspect those files together.

### Lifecycle and permissions

Two cross-cutting systems shape session behavior:
- `src/session-lifecycle.ts` marks sessions as initializing/running/thinking/waiting-input/idle/archived and performs timeout-driven idle/archive transitions.
- `ProcessManager` + `ClaudePtyBridge` detect permission prompts, track approval policy (`ask-every-time`, `approve-once`, `remember-this-turn`), keep per-session approval stats, and convert Claude CLI prompt text into structured escalation state for the UI.

A bug around blocked input, idle/archive transitions, or wrong permission state is usually not just a UI issue; check lifecycle state and permission detection before changing rendering.

### UI structure

The frontend is server-rendered, not a separate SPA build. `src/server.ts` serves one HTML document built by `renderApp()` in `src/web-ui/index.ts`, which inlines generated CSS and JavaScript and references vendor assets.

Asset pipeline (source → generated, never edit generated files by hand):
- `src/web-ui/browser/*.ts` — the browser-side TypeScript modules (entry `main.ts`: state, websocket, terminal, chat-render, session-engine, i18n, …). Type-checked by `tsconfig.browser.json`.
- → `scripts/bundle-browser.js` (esbuild) emits `src/web-ui/content/scripts.js` (generated).
- `src/web-ui/content/styles.css` — hand-edited CSS source.
- → `scripts/generate-web-assets.js` minifies and base64-embeds `scripts.js` + `styles.css` + vendor bundles into `src/web-ui/embedded-assets.ts` (generated).
- `src/web-ui/styles.ts` / `scripts.ts` read from the embedded assets with an mtime-based cache, so edits to files under `dist/` are re-read on the next request without restarting.
- `src/web-ui/content/vendor/wterm/wterm.bundle.js` + `terminal.css` — the wterm terminal renderer, regenerated by `scripts/bundle-wterm.js`; `vendor/qrcode/qrcode.bundle.js` by `scripts/bundle-qrcode.js`.

So a typical frontend change touches `src/web-ui/browser/*.ts` and/or `content/styles.css`, then `npm run dev` (or `npm run check`) regenerates `scripts.js` and `embedded-assets.ts` automatically.

Any build or packaging change that forgets to copy `src/web-ui/content/` into `dist/web-ui/` will break the packaged app even if dev mode still works.

### Output parsing and transport

There are two parallel representations of assistant output:
- raw PTY output for terminal view
- structured conversation data for chat view

`ClaudePtyBridge` maintains the richer block-based `ConversationTurn[]` (with tool use/results) that backs the chat view, derived from the same raw PTY stream that drives the terminal view. Bugs in chat rendering often come from drift between these two representations.

WebSocket clients connect to `/ws`, send `{type: "subscribe", sessionId}`, and receive debounced `ProcessEvent` updates. Output events are throttled to reduce churn, and oversized queues are dropped instead of backpressuring the server.

### Main modules worth knowing

| File | Role |
|------|------|
| `src/cli.ts` | CLI entrypoint and config-related commands |
| `src/server.ts` | Express server, REST API, WebSocket, and web UI endpoints |
| `src/server-session-routes.ts` | Session/resume/history HTTP routes and shared API error helpers |
| `src/process-manager.ts` | PTY session orchestration, input/output routing, permission handling, resume/archive logic |
| `src/structured-session-manager.ts` | Non-PTY runner that spawns `claude -p` and streams JSON output |
| `src/claude-pty-bridge.ts` | PTY output parser for structured chat, permissions, task tracking, and Claude session IDs |
| `src/resume-policy.ts` | Heuristics for mapping Claude history/resume data back onto wand sessions |
| `src/storage.ts` | SQLite persistence and additive schema migration helpers |
| `src/config.ts` | Default config, merge logic, config path resolution |
| `src/session-lifecycle.ts` | Idle/thinking/waiting/archive state machine |
| `src/session-logger.ts` | File-based logs under `~/.wand/sessions/` |
| `src/auth.ts` | Session token creation, validation, and revocation |
| `src/cert.ts` | Self-signed HTTPS certificate generation and loading |
| `src/ws-broadcast.ts` | WebSocket broadcast manager for `/ws` fanout |
| `src/git-worktree.ts` | Per-session git worktree create/merge/cleanup, backs `.wand-worktrees/` |
| `src/upload-routes.ts` | `POST /api/sessions/:id/upload` — multer-backed uploads to `<cwd>/.wand-uploads/` |
| `src/models.ts` | Built-in Claude model list, `claude --version` probing, model cache |
| `src/claude-sdk-runner.ts` | One-shot `runClaudePrint()` via the Agent SDK; `resolveSdkClaudeBinary()` prefers the system `claude` on PATH (kept fresh by user updates), falling back to the SDK's bundled native binary (musl/glibc aware). Shared by `structured-session-manager.ts`. Backs quick-commit + prompt-optimizer |
| `src/git-quick-commit.ts` | Git status, quick commit (AI-generated message via `claude-sdk-runner`), tag, and push; wired into `server-session-routes.ts` |
| `src/prompt-optimizer.ts` | One-shot prompt rewrite via `claude-sdk-runner`, exposed by a `server.ts` route |
| `src/env-utils.ts` | Child-process env assembly; minimal whitelist when "inherit env" is off, to keep API keys/tokens out of spawned tools |
| `src/path-repair.ts` | Runtime PATH self-repair so service-installed instances still find `claude` after Node-version/reinstall changes |
| `src/pidfile.ts` | Single-instance pidfile + IPC unix-socket path that back the attach/TUI model |
| `src/npm-update-utils.ts` | npm global self-update + leftover cleanup, shared by server and TUI |
| `src/update-helper.ts` | Detached update-runner process plumbing used by the self-update flow |
| `src/service-self-repair.ts` | Rewrites systemd/launchd unit after a self-update (`repairServiceUnitAfterUpdate()`) |
| `src/relaunch.ts` | `computeRelaunch()` — restart strategy after update (systemd-managed exit vs detached respawn) |
| `src/version-utils.ts` | Semver compare/extract single source, shared by server / TUI / path-repair / models |
| `src/language-prompt.ts` | Strong Chinese-language instruction generator shared by all runners |
| `src/git-utils.ts` | Shared git exec helpers used by quick-commit and worktree code |
| `src/error-utils.ts` | Shared `getErrorMessage()` helper |
| `src/ensure-node-pty-helper.ts` | Marks the bundled node-pty helper binary executable before server start |
| `src/tui/` | neo-blessed dashboard, IPC client/server (over the pidfile socket), and systemd/launchd service commands (`commands.ts`) behind `wand service:*` |
| `src/middleware/path-safety.ts` | Path-traversal guard for the file browser API |
| `src/middleware/rate-limit.ts` | Login / sensitive endpoint rate limiting |
| `src/pty-text-utils.ts` | ANSI / control-sequence helpers for terminal output processing |
| `src/message-truncator.ts` | Long-message truncation for chat persistence and broadcast |
| `src/web-ui/` | Server-rendered HTML + browser assets. Browser source is `browser/*.ts`; `content/scripts.js`, `embedded-assets.ts`, and `content/vendor/*` bundles are generated — do not hand-edit |
| `src/types.ts` | Shared contracts across CLI, server, storage, PTY bridge, and UI |

### REST surface

The server exposes login/logout, config, session control, PTY input/resize, file browser, favorites, and quick-path endpoints from `src/server.ts` plus resume/history routes from `src/server-session-routes.ts`. If a frontend feature needs data, look for an existing `/api/*` route there before adding a new abstraction.

## Code Style

### Formatting
- **2-space indentation**, no tabs
- **Double quotes** for all strings
- **Semicolons** at end of statements
- Lines ~100 chars soft limit

### Imports
- Node built-ins: `node:` prefix, named imports where available, `.js` extension for ES modules
  ```ts
  import { existsSync } from "node:fs";
  import { EventEmitter } from "node:events";
  import path from "node:path";
  ```
- Third-party: default imports
  ```ts
  import express from "express";
  ```

### Naming
- Files: lowercase kebab-case (`process-manager.ts`)
- Types/Interfaces: PascalCase (`WandConfig`, `SessionSnapshot`)
- Functions/Variables: camelCase (`loadConfigWithStorage`, `appendWindow`)
- Constants: UPPER_SNAKE_CASE (`MAX_SESSIONS`, `OUTPUT_MAX_SIZE`)
- Classes: PascalCase, use `private` keyword for internals

### Functions & Types
- Prefer small top-level functions; add explicit return types on exports
- Use `readonly` on non-mutating properties
- Stateful managers: classes extending `EventEmitter`
- Pure utilities: standalone functions (e.g., `parseMessages`)
- Error handling: catch `unknown`, use the shared `getErrorMessage()` helper from `src/error-utils.ts`
- HTTP errors: `res.status(400).json({ error: "..." })`

### Patterns
- Module-level constants at top of files
- Debounce frequent events (output 16ms, task 100ms)
- `appendWindow()` for memory-bounded output buffers
- Schema migrations: add columns, don't drop tables

## Commit Guidelines

Use short, imperative subjects (e.g., `Add config path validation`). One logical change per commit. For UI changes, include screenshots or screen recordings in PR descriptions.

## Security Notes

- Never commit real passwords or machine-specific paths from `~/.wand/config.json`
- Keep `host` on `127.0.0.1` unless remote access is intentional
- HTTPS is off by default (`https: false`); enable it only when needed and keep `host` restricted
- Document any new command execution permissions added to the config schema
