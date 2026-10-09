# 设置内的 LAYA / 语音模型管理

完整 Web 设置新增「本地模型」，语音输入页也有同一组下载/初始化操作。原生客户端通过现有完整设置入口访问；普通 App 连接可查看状态，安装、取消、启用必须登录管理员，不把连接码或推理专用 capability 当安装权限。

## LAYA

- 当前只支持 Apple Silicon macOS / Metal，不静默换 Torch、聊天模型或云判断。
- 固定 `aac6fef/laya-multilingual-mlx` 的 revision `f2b4faf51023039425946074e2cf1361d2db11d5`，按每个文件的真实大小/SHA-256 验证 weights、tokenizer、encoder config、模型身份与许可证；总计 678,214,509 B（约 647 MiB）。不下载 reference Torch 权重/训练集。
- 下载完成再初始化；复用已配置且通过完整性检查的模型与兼容 Python 环境。缺失或不兼容时创建新的独立 venv，固定 LAYA 0.3.0 / MLX 0.32.2 / Hugging Face Hub 1.33.0，不覆盖系统 Python或原有 venv。需服务器已有 Python 3.11+，可通过受信任环境 `WAND_LAYA_PYTHON_BIN` 指定，HTTP 不能指定路径。
- 初始化会真正加载现有 `DecisionService` worker，校验 Metal 与 ready 协议，不运行用户任务。没有自动启用、安装技能、授予工具、付费切换或自动派工。
- 启用状态为独立明确操作，热更新时拒绝打断活动判断/队列；使用原有推理所有权、1024-token 边界和错误事实。
- `localDecision` 作为现有 SQLite 偏好存储；旧 JSON 值幂等迁移、用户旧 paths/enabled 保留，CLI `decision:configure` 写同一偏好。设置内更新立即生效，CLI 修改仍需普通安全重启。通用 `/api/settings/config` 不接受 `localDecision` 的路径/命令，专用管理入口只接受启用 boolean。
- 仍是实验性辅助判断。高概率不等于正确，更不是权限批准、数据删除、发布或付款授权。

## 语音

Tiny / Base / Small 通过已有 `SpeechService` 下载和转写，不合并到 LAYA worker。初始化需要模型先下载；可选择自动 / CPU / Metal / CUDA，Mac 自动使用 Metal，其它主机自动 CPU。

运行时缺失时，管理员的白名单初始化操作运行固定 `scripts/install-speech-runtime.js`；已有自定义 `WAND_WHISPER_BIN` 不被覆盖。需 Git/CMake/C++，CUDA 需已装 Toolkit。不在通用构建或状态 GET 中启动安装。初始化使用短合成静音真实检查模型，并清理临时文件，不读取任何草稿/私聊/用户音频。

语音初始化持有 `SpeechService` 的专属维护入口，有活动转写或下载时拒绝；期间新识别暂时繁忙，不停止现有用户执行。详情见 [服务端语音](server-speech.md)。

## 生命周期与故障

下载/初始化返回 202，由服务器持有有界后台任务，设置显示下载字节、阶段、失败及重试。取消只终止本次受信任安装进程组，不杀 Wand / Render / terminald 或系统 Python。保留已校验的完整模型文件，失败/取消清理半文件和本次临时环境。

状态接口只读，不隐式 warm-up、不执行模型或安装依赖，不返回可执行路径、凭据或原始 compiler/Python diagnostics。没有自动重启服务；首次上线新代码仍按项目的 Core 排空与生命周期规则。

旧 HTTP 语音下载端点保留给兼容客户端，新管理操作复用同一下载 owner。状态中的 ready/initialized 区分文件存在、完整性通过、运行时存在和真正初始化通过；LAYA 空闲卸载后并不表示模型被删除。

全局 npm 包也可由操作者显式运行 `node "$(npm root -g)/@co0ontty/wand/scripts/install-laya-runtime.js"`；仓库内为 `npm run laya:install`。这些仅装运行时，不下载/启用模型、不修改系统依赖。
