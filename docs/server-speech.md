# 语音识别：服务端 / 客户端本地

Web、Android、iOS 的「语音输入」设置可选择两条独立链路，选择只保存在当前设备；不会替换其他设备的选择。

- **服务端识别**：客户端采集最多 60 秒音频，松手后上传到当前连接的 Wand 服务器，由 whisper.cpp 离线转写，再追加到原草稿。不使用第三方云识别 API。服务器必须先由管理员启用、安装运行时并下载模型。
- **客户端本地识别**：不向 Wand 上传音频。Android 优先 sherpa-onnx，次选系统端侧引擎；iOS 使用系统端侧听写；Web 使用支持 `processLocally` 的浏览器端侧识别（需要对应语言包）。设备不支持时明确报错，不静默转 Apple / Google 云识别，也不自动切服务端。

识别结果绑定开始录音时的输入版本与会话，取消、离开页面、发送或修改输入后迟到结果不会覆盖新草稿。服务端路径没有实时 partial 转写，松手后显示「服务端识别中」。建议远程访问使用 HTTPS；浏览器麦克风只在 HTTPS / localhost 安全上下文可用。

## 设置内下载和初始化

Web 完整设置 →「本地模型」或「语音输入」可直接管理：选择模型 → 下载并校验 → 初始化运行时与模型 → 明确启用。支持实时下载字节/进度、编译/初始化阶段、取消以及失败后重试；关掉设置页不杀后台安装任务。下载和初始化不自动启用、不修改系统 Python、不停活动决策/识别，也不重启 Wand。

服务端缺少 Git、CMake、C++ 工具链（CUDA 还需 Toolkit）时会明确失败并允许重试，不擅自用 sudo/包管理器安装系统依赖。管理员操作会按需联网获取固定 whisper.cpp 源码/模型，普通安装和构建仍不会触发。

## 安装服务端运行时

运行时是可选组件；`npm install`、普通服务端构建和原生客户端构建不会下载模型或编译 whisper.cpp。固定 whisper.cpp v1.8.3 源码提交 `2eeeba56e9edd762b4b38467bab96c2517163158`，需要 Git、CMake 和 C++ 工具链。源码检出和构建只由服务器操作者显式运行，或由管理员在设置中发起固定白名单初始化任务；HTTP 只接受模型/后端枚举，不接受命令、路径或下载 URL。

仓库内先运行 `npm run build`，然后：

```sh
# macOS / Mac mini：自动使用 Metal；Linux / Windows：保守地使用 CPU
npm run speech:install
# 无 GPU、低配置服务器 / 容器 / macOS CPU-only
npm run speech:install -- --backend cpu
# 有 NVIDIA GPU 且已安装 CUDA Toolkit 的 Linux / Windows
npm run speech:install -- --backend cuda
```

安装全局 npm 分发包的用户，在 macOS / Linux 可直接运行：

```sh
node "$(npm root -g)/@co0ontty/wand/scripts/install-speech-runtime.js"
```

Windows 同样运行全局包目录下的 `scripts/install-speech-runtime.js`。Windows 使用装好 Visual Studio C++ Build Tools、Git、CMake 的开发者终端，支持 x64；Linux 支持 x64 / arm64（需对应平台编译工具链）；macOS 支持 Intel / Apple Silicon。这是按当前主机构建，不把 Mac 二进制拿到 Linux 运行。不需要 Python、ffmpeg 或 Node 原生推理依赖。

默认安装到 `~/.wand/speech/bin/`。使用自定义 Wand 配置目录时，传 `--dir <配置目录>/speech`。也可使用已安装的兼容 whisper-cli：通过服务器受信任环境指定绝对路径 `WAND_WHISPER_BIN`，用 `WAND_WHISPER_BACKEND=cpu|metal|cuda` 声明编译后端；未指定路径时，优先配置目录下的运行时，其次 PATH。不是 HTTP 可改参数。

## 配置和模型

在 Web 设置 → 语音输入中，管理员选择模型、语言、运行设备和 CPU 线程；点模型旁的下载按钮才下载到服务器，点「初始化运行时与模型」检查独立运行时和实际模型，再明确启用「服务端语音识别」。原生客户端只查看服务端就绪状态，管理配置仍走已有 Web 管理权限。设置立即生效，不需要为选择模型重启服务；首次增加服务端代码仍需正常部署。

| 多语言模型 | 下载字节数 | 使用场景 |
| --- | ---: | --- |
| Tiny | 77,691,713 | 低内存 CPU，速度优先 |
| Base（默认） | 147,951,465 | CPU / Mac mini 通用均衡 |
| Small | 487,601,967 | 更高准确度，较强 CPU / Metal / CUDA |

模型固定 Hugging Face 上游 revision，并按真实字节数与 SHA-256 校验，存入 `<配置目录>/speech/models/`；不使用仅英文的 `.en` 模型。使用固定 Wand / code / Git / API / 代码 / 语音识别等应用术语作为初始识别上下文，改善术语和简体中文识别；不读取用户草稿、私聊或知识作为上下文，也不对结果做伪造式自动替换。模型准确率仍受大小、录音质量和口音影响，可选择 Small 或指定语言。下载失败不留下可用的半文件，不把模型加入仓库或安装包。已有完整模型每次服务启动首次使用时重新校验，之后按文件元信息缓存；文件变化重新验证。

运行设备为「自动 / CPU / GPU」。自动只使用已安装运行时声明的后端，不要求无 GPU 机器安装 GPU 库；Metal / CUDA 初始化或识别失败时在同一 120 秒预算内尝试一次 CPU。明确选择 GPU 时失败不静默改 CPU。CPU 固定 `--no-gpu`，默认最多 4 个线程（可选 1–16），服务端同时只允许 1 个识别任务，繁忙返回 429，不无限排队。

## HTTP 契约和隐私

所有入口要求现有 Wand 身份认证与 sessions scope，管理写操作额外要求 admin；连接码不会赋予模型下载、启用或修改服务器的权限。

- `GET /api/speech/status`：配置、运行时环境、模型完整性/下载进度、就绪原因；不返回路径、凭据、音频。
- `PATCH /api/speech/settings`：`enabled, model, acceleration, language, threads` 的部分更新，管理员专用。
- `POST /api/speech/models/:id/download`：白名单模型的显式后台下载，管理员专用，返回 202。
- `GET /api/local-models/status`：LAYA / 语音模型和安装操作状态，无可执行路径。
- `POST /api/local-models/:kind/download|initialize|cancel`：管理员的固定模型操作，返回 202；kind 为 `laya` / `speech`。
- `PATCH /api/local-models/laya/settings`：只接受 `enabled`，不接受 Python 或模型路径。
- `POST /api/speech/transcribe`：`Content-Type: audio/wav`，固定 44 字节 WAV header + 16 kHz 单声道 little-endian PCM16；0.1–60 秒，最大 1,920,044 字节。成功返回 `{text, model, backend}`。

各端本地完成采音和 WAV 编码，不让服务器执行复杂媒体解码器。上传与推理并发有界，超时和断开连接终止本次语音子进程，录音临时文件在成功、失败、取消后清理，不进入会话历史或日志；只把用户决定发送的识别文字作为草稿。服务停止取消语音工作，不影响 Render / terminald 生命周期。

代码与开发测试覆盖 CPU 参数、GPU 降级、配置/鉴权、音频校验、下载完整性、取消、资源上限和临时文件清理。实际平台、录音设备与加速性能的验收结果以本轮工作日志为准，不能把适配代码当作每个平台已实机验证。
