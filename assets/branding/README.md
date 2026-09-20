# Wand 产品标识

所有 Wand 产品标识统一使用 Android 启动图标的灰底像素猫。Claude、Codex 等 provider
标识，以及表示操作或状态的星芒/终端图标，不属于 Wand 产品 logo，不替换。

## 唯一图案来源

- `android/app/src/main/res/drawable/ic_launcher_foreground.xml`：六色像素猫与 24/108 安全区。
- `android/app/src/main/res/drawable/ic_launcher_background.xml`：背景 `#E3E8EE`。

```sh
npm run sync:brand-assets
npm run check:brand-assets
swift ios/scripts/generate-icons.swift ios/Wand/Assets.xcassets/AppIcon.appiconset
swift macos/scripts/generate-icons.swift macos/Wand/Assets.xcassets/AppIcon.appiconset
```

`sync:brand-assets` 生成 Web 共享几何、SVG、浏览器扩展 PNG、Android 通知单色变体、
原生 asset catalog 和本地构建快照。`generate-icons.swift` 是共享渲染模板，脚本将其
复制到两个原生子仓库并设置平台参数；原生构建脚本会重新生成 AppIcon PNG。
不要手工修改这些生成资源。`npm test` 会验证图案、颜色、资源同步和图标尺寸。

## 平台差异

- Web 登录页、插画、React Shell、favicon 和浏览器通知共用同一份品牌数据。
- Android 内部组件直接复用启动图标的两个原始 drawable，不重新画猫。
- iOS/macOS 内部组件和 iOS 实时活动使用 `WandLogo`，保留原色，不接受主题 tint。
- iOS AppIcon 是不透明的 1024 方图，圆角交给系统；macOS 保留系统图标留白和透明圆角。
- 通知栏只支持单色，使用同图案的镂空眼鼻轮廓；浏览器扩展 manifest 使用 PNG。
- 原生子仓库保留 JSON/SVG/脚本快照，可独立构建；同步变更需分别提交并推送子仓库，
  然后在主仓库提交 submodule 指针。
