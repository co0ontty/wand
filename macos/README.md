# macOS 客户端

Wand 的 macOS 原生壳，SwiftUI + WKWebView。结构对称 `android/` 目录。

## 约定

- 工程代码放在 `macos/Wand/`
- `.app` 与 `.dmg` 构建产物**不要提交到仓库**（已在 `.gitignore`）
- 设置页里的下载入口指向 wand 运行时配置目录中的 DMG（默认 `~/.wand/macos/`），不是仓库下的产物

## 本地构建（仅 macOS）

```bash
./build.sh 1.16.0
# 产物：build/Wand.app + dist/wand-v1.16.0.dmg
```

要求：

- macOS 12+
- 安装了 Xcode 15+（命令行工具足够）
- 不需要 Apple Developer 账号（ad-hoc 自签名）

## 部署 DMG 供下载

服务端通过 `config.macos.dmgDir`（相对于 config 目录）查找 DMG，按修改时间取最新的。

| 环境 | Config 目录 | DMG 目录 | 端口 |
|------|------------|---------|------|
| 生产 | `~/.wand/` | `~/.wand/macos/` | 8443 |
| 开发 | `/tmp/wand-dev/` | `/tmp/wand-dev/macos/` | 9443 |

文件名必须包含语义化版本号（如 `wand-v1.16.0.dmg`），服务端正则 `(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)` 抽取版本号。

## DMG 下载来源优先级

1. 本地文件（`dmgDir` 中最新的 `.dmg`）→ `source: "local"`
2. GitHub Release 回退 → `source: "github"`

设置页面会显示来源标签（本地/线上），等同 Android APK 的逻辑。

## 签名

ad-hoc 签名（`codesign --sign -`），等同 Android 的自签名 keystore。**用户首次打开 Wand.app 时：**

> 右键 → 打开 → 在系统弹"无法验证开发者"时点"打开"。之后双击即可正常使用。

也可以在终端跑：

```bash
xattr -dr com.apple.quarantine /Applications/Wand.app
```

去掉 quarantine 标签。

**不要换签名身份。**一旦换了，已安装的旧版升级时会被 macOS 拒绝（"签名变化"）。当前签名是 ad-hoc，不需要 Apple Developer 账号。

## 自动更新

App 启动 5 秒后异步调 `/api/macos-dmg-update?currentVersion=<当前版本>`，如果有新版：

1. 弹原生对话框（NSAlert）："立即更新 / 稍后提醒 / 跳过此版本"
2. 点"立即更新"→ URLSession 下载 DMG（进度对话框，throttle 50ms）
3. 下载完调 `hdiutil attach` 挂载，然后用 `NSWorkspace.open` 在 Finder 中显示挂载点
4. 用户拖拽 Wand.app 到 Applications 完成升级

对称 Android 的 `Intent.ACTION_VIEW` APK：把"实际安装"交回系统/用户决策，比"自动替换 /Applications/Wand.app + helper script 重启"更稳。
