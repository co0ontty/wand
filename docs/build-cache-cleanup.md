# 本机构建缓存自动清理

macOS 使用用户级 LaunchAgent，每天本地时间 **04:30** 检查一次；只处理至少 **7 天**没有修改/替换的历史编译中间物。睡眠期间错过的时间由 launchd 按系统规则处理，不保证关机时执行。

不安装 Git hook：提交不应隐式清空增量编译缓存，且不覆盖现有 post-commit。

## 范围与安全边界

- 自动发现当前仓库 `output/` 内 Xcode DerivedData 树，必须有 `info.plist` 和 `Logs/` 标识；搜索深度最多6层、最多10000目录，超限停止而不是扩大扫描。
- 白名单仅为 `Build/Intermediates.noindex`、`ModuleCache.noindex`、`SDKStatCaches.noindex`、`SDKExplicitPrecompiledModules`、`Index.noindex`、`CompilationCache.noindex`。
- 保留 `Build/Products`、`.app`/IPA/APK、`SourcePackages`（含Git checkout）、`Logs`（含xcresult）、验收报告、截图、签名、源码、数据库、模型、会话和Git历史。
- 不清理模拟器数据、全局 npm/Gradle 等工具缓存，也不自动删除演示项目 node_modules 或现用 `android/ios/macos/render` 构建目录；这些可能作为运行环境或未完成验收的输入。
- 使用现有 `.wand-build-lock` 与 `npm run check/build`、本机部署互斥；锁忙跳过，不自动抢夺或回收疑似过期锁。
- 查询实际编译器进程和打开文件（包含cwd），初次及逐目录删除前检查；检查超时/失败时跳过。Xcode正在构建或归档目录正在使用时不删。
- 年龄按递归扫描中**最新**的文件/目录 mtime、ctime 及 DerivedData 标识计算，不仅看父目录mtime；删除前再次校验Git忽略、无跟踪文件、无嵌套Git元数据和无路径符号链接。
- 原生直接构建尚未统一接入项目锁，因此定时器仅限历史归档，不对现用原生目录做“看起来空闲就删”的自动清理。进程/文件检查是额外保护，不能冒称为所有任意外部命令的原子互斥。
- 输出区分**实际分配字节**与**逻辑字节**，避免Xcode稀疏文件误报几十GB；APFS共享块使分配合计不等于磁盘净释放量。

## 安装、预览与停用

在仓库根目录，使用 `.nvmrc` 指定的 Node（当前24.21.0）：

```bash
# 默认只预览
npm run clean:build-cache:auto
npm run clean:build-cache:install

# 安装用户级每日任务；不需要sudo，不重启Wand
npm run clean:build-cache:install -- --install

# 手动执行相同的七天闲置规则
npm run clean:build-cache:auto -- --apply

# 停用并移除本任务的plist；保留日志
npm run clean:build-cache:install -- --uninstall
```

安装入口绑定 `~/.nvm/versions/node/v<.nvmrc>/bin/node` 的绝对路径，并校验版本；没有依赖交互shell的nvm初始化，也不会隐式回退到另一个Node。如果卸载这个版本或移动仓库，先停用，迁移后重新安装任务。

任务文件：`~/Library/LaunchAgents/com.wand.build-cache-cleanup.plist`。

执行日志：`~/Library/Logs/Wand/build-cache-cleanup.log`（每天追加一次，可自行归档；不包含凭据、环境或进程参数）。

```bash
launchctl print "gui/$(id -u)/com.wand.build-cache-cleanup"
# 无需重启服务，立即测试一次；不用-k，不中断现有运行
launchctl kickstart "gui/$(id -u)/com.wand.build-cache-cleanup"
```

安装器只管理此label，拒绝覆盖其他来源/仓库的同名任务。安装失败恢复原配置，停用不删除日志。不设置RunAtLoad，避免每次登录即触发删除。

原有 `npm run clean:build-cache -- --apply` 仍是**手动**即时清理固定工作目录的入口，没有七天规则；只有确认本机构建和开发态Render产物不在使用时才执行，不能把它直接挂定时器。

## 验证

```bash
node --test --import tsx tests/clean-build-cache.test.ts tests/auto-clean-build-cache.test.ts
```

覆盖：预览不删除、归档识别与产品保留、递归新文件/标识保留、锁占用、活动/检测失败跳过、删除前重新检查、跟踪/嵌套Git/符号链接拒绝、稀疏文件统计、LaunchAgent安装/回滚/停用及XML路径转义。真实定时链路另通过launchd状态和日志核对；不需要安装或启动移动设备。
