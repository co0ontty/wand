# Android 客户端

此目录用于放置 wand 的 Android 客户端工程。

## 约定

- Android 工程代码放在此目录中。
- APK 构建产物**不要提交到仓库**。
- 页面下载入口使用的是 wand 运行时配置目录中的 APK，而不是本目录下的文件。

## 本地分发流程

1. 在 `android/` 中完成客户端打包。
2. 将生成的 APK 手工复制到 wand 配置目录下的 Android 工件目录。
   - 默认目录：`<configDir>/android/`
   - 默认 `configDir` 通常是 `~/.wand/`
3. 如需固定当前下载文件名，可在 `config.json` 中设置：

```json
{
  "android": {
    "enabled": true,
    "apkDir": "android",
    "currentApkFile": "your-app.apk"
  }
}
```

4. 启动 wand 后，设置页“关于”中会显示 APK 下载入口。

## 后续演进

后续可扩展为从 GitHub Release 自动拉取最新 APK 到运行时目录，再继续复用同一个下载入口。
