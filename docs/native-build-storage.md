# 本机原生开发环境外置

原生构建入口可通过本机的 `~/.config/wand-build/environment.sh` 加载可信的存储配置；也可显式提供 `WAND_NATIVE_BUILD_ENV`。配置不存在时，独立检出与 CI 保持原路径，不要求使用某台开发机的外接盘。显式指定了不存在的配置文件则失败，不能静默忽略。

覆盖入口：Android `debug.sh` / `gradlew`，iOS `build.sh` / `debug.sh`，macOS `build.sh` / `debug.sh` / `scripts/run-tests.sh`。本机配置必须先验证外盘确实挂载、卷身份正确、可用容量足够，验证前不创建目录。迁移期间可由配置拒绝新构建；已执行的编译不靠强杀结束。

配置可设置：

- `WAND_BUILD_STORAGE_ROOT`：新构建和测试输出根。各端使用独立子目录，避免相互清理。
- `TMPDIR`、Clang/Swift module cache：编译及打包临时输出。
- `DEVELOPER_DIR`：当前调用使用的完整 Xcode，不要求更改全局 `xcode-select`。
- `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `ANDROID_AVD_HOME` / `GRADLE_USER_HOME`：Android 工具、设备与缓存。
- `wand_assert_external_build_path <path>`（可选函数）：检查显式输出路径，拒绝解析到内盘的路径或符号链接逃逸；必须在清理/创建输出目录前调用。

macOS/iOS Release 支持 `WAND_BUILD_DIR` / `WAND_DIST_DIR`，显式指定时必须是尚不存在的绝对路径，不能用参数让脚本清空已有目录。Debug 与测试仍支持原有 `DERIVED_DATA_PATH` / `DERIVED_DATA`；配置可以校验它们必须留在外盘。Android 的 project cache 由 wrapper 定位到存储根下的项目路径 SHA-256 子目录；模块 buildDirectory 由本机 Gradle init script 配置到同一项目目录，分发脚本按相同目录读取 APK。

本机迁移依赖符号链接保留常规路径。原件仅在文件集合、内容校验和、权限和链接检查通过后移除。文件复制期间发现活跃写入或校验不一致，应保留原件并重新协调，而不是继续切换。

外盘缺席时应明确停止，不创建内盘替代目录。不要把 FAT32 根当作工具链目录；使用其上的 APFS 卷。签名钥匙串与 Apple 系统管理的 Runtime/系统组件不通过无条件移动或链接处理。

验证：`node --test --import tsx tests/native-build-storage.test.ts` 检查拒绝路径、显式缺失配置、Gradle 参数与含空格路径，以及无配置时的兼容。真实工具链发现、各平台编译/测试和模拟器验证仍须分别执行；脚本单测不等于原生验收。
