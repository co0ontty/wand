# Pi CLI 与 Wand SDK 的加载边界

Wand 有两条独立执行路径：

| 路径 | 执行与依赖 |
| --- | --- |
| Pi CLI | 运行 PATH 实际选中的 Pi；默认使用 tmux 原生 TUI 和同进程事件桥，关闭原生桥时使用 `pi --mode json --print`。会话桥使用该 CLI 自己的内置 MCP/CodeMode/provider。 |
| Wand Agent | Wand 进程内的 Core harness，使用 Wand 包内固定版本的 Pi SDK。 |

服务启动不预热 SDK。新建/切换到 Wand Agent 或执行其候选时才按需加载；Pi CLI 的启动、设置面板和资源发现不依赖 Wand SDK 的公共入口或 ModelRuntime。

原生 Pi 的执行中输入通过官方 `turn_end` boundary drafts 与私有文件邮箱衔接；Wand 持久化交接身份、Pi 原生上下文 commit 回执和分段记录。没有把 CLI 改成 SDK 或 RPC，也不使用扩展 `sendUserMessage()` 的 void 返回冒充接收回执。新桥支持安全边界插话，旧桥/JSON print 路径保持整轮后发送。细节见 [Pi 对话队列](pi-conversation-queue.md)。

## CLI 的资源与扩展

- `src/pi-cli-runtime.ts` 从真实可执行入口识别 npm 包，或读取官方 managed launcher 当前发布版本。只看实际 PATH 中第一个可执行 `pi`；不执行自定义 shell wrapper，不猜其他安装、不回退到 Wand SDK。每次重新读取 managed 当前版本，不把上次 CLI 版本锁死。
- CLI 资源目录通过当前 CLI 的只读 Settings/Package/Skills/MCP 叶解析器枚举，保留原生包声明、过滤及 USER 范围；不导入用户扩展、不联网安装、不执行凭据命令、不提升项目信任。
- `pi-resource-bridge.ts` 在 CLI 子进程内按正在运行的 CLI 入口加载其原生内置扩展。父进程准备后即使 CLI 更新，运行时也不会混用 Wand SDK 的旧工厂。Skills/MCP 只加载选定项，CodeMode 保留 off/on/only 与全局跟随语义，不写用户配置。
- 免费模型桥同样使用运行 CLI 的 provider 叶 API，不从 Wand 包导入另一份 Pi AI 实现；保留零价格复核、会话能力绑定和撤销。
- 官方 npm 与 managed 安装已验证。无法识别的自定义 launcher 或缺少接口的安装会明确拒绝会话级资源设置，不会暗中扩大为全局资源或换用另一 CLI。独立二进制/自定义 wrapper/Windows shim 的资源接口需单独适配和验证；普通 CLI 引擎不因此改成 SDK。

Pi CLI 官方内部也使用 Pi 的共享实现；隔离的是 **Wand 对其内置 SDK/harness 的依赖**，并非重写官方 CLI、替换 MCP 实现或移除所有共享解析器。

## Wand Agent 的版本配套

`package.json` 将 SDK 及其 `@earendil-works/*` 间接依赖声明为同一已验证发布批次的精确直接依赖。升级时一起调整并验证，不能只升级一个包。这份 SDK 不随独立 Pi CLI 的更新变化。

原故障：Pi SDK 1.0.2 内部使用 `^1.0.2`，重新安装 Wand 时 npm 选中 CodeMode 1.2.0；它已移除旧 SDK 使用的 `MCP_TYPESCRIPT_PREAMBLE`，导致 ESM 导入失败。开发旧锁文件掩盖了发布安装问题。只改 package-lock 或 dependency-owned overrides 不够：消费者安装发布包不使用其开发锁文件或 overrides。精确直接依赖随 tarball 生效。

配套 pin 保证 Wand Agent 自身可用；CLI 隔离保证即使 Wand SDK 缺失/坏掉，也不拖累独立 CLI。

## 验证

### 当前持续检查

[CI 工作流](../.github/workflows/ci.yml) 当前配置为：安装项目依赖（`npm ci --prefer-offline`），执行 `npm run build`，分别对 browser 与 React 执行 `npx --no-install tsc --noEmit -p tsconfig.browser.json` / `tsconfig.react.json`，以及 `node scripts/stage-render-binaries.js --all --strict --check`。其中 [构建脚本](../scripts/build-body.js) 生成 Web 资产、编译服务端与声明文件并执行 bundle 预算门禁；Render 检查使用工作流检出的固定 `render-bin` 产物。这些是配置中的检查步骤，不代表某次运行已通过，也不覆盖 Pi CLI/SDK 的运行隔离或发布包干净安装验证。

本地代码改动的验证入口为 [package.json](../package.json) 中的 `npm run check`、`npm run build`；只做三套 TypeScript 检查、不生成资产时可用 `npm run typecheck`。按 [当前验证策略](testing-policy.md) 核对受影响流程，不恢复整包测试；纯文档改动只核对引用、约束及 `git diff --check`。

### 历史说明与证据边界

基线 `78d2d14ae72895eb6fbf8788cbac5384617962b2` 的旧说明曾列出 `pi-cli-isolation`、`pi-resource-selection`、`openrouter-free-cli`、`pi-sdk-dependencies`，并声称 CI 独立安装 Pi CLI 1.2.0。这仅是旧文档记录，不是本次核实过的一次性验证结果：未提供对应运行记录，不能据此声称已验证。2026-10-30 起 `tests/` 套件已移除，当前 `package.json` 没有 `test` 脚本，CI 也没有上述测试或独立安装 Pi CLI 的步骤；它们不属于当前持续检查。

### 后续发布验证建议（非现有 CI 承诺）

涉及 Pi CLI/SDK 或发布依赖变更时，建议在相应任务授权范围内核对 npm tarball 的干净生产安装、SDK 依赖闭包与真实导入，以及独立 CLI 的资源选择、加载隔离和拒绝/降级契约。独立 CLI 不能用 Wand `node_modules/.bin/pi` 冒充，验证版本应单独记录，不机械跟随 SDK pin；未执行的项目应明确标注，不以历史说明代替证据，也不隐式调用真实付费模型。

涉及运行功能的最终验收使用已安装服务；如需更新，遵守现有部署锁/Core 排空流程，不重启或强杀 daemon，不修改全局 Pi CLI。本节本身不授权安装、部署或运行验证。
