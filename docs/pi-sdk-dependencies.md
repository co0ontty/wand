# Pi CLI 与 Wand SDK 的加载边界

Wand 有两条独立执行路径：

| 路径 | 执行与依赖 |
| --- | --- |
| Pi CLI | 运行 PATH 实际选中的 `pi --mode json --print`，会话桥使用这个 CLI 自己的内置 MCP/CodeMode/provider。 |
| Wand Agent | Wand 进程内的 Core harness，使用 Wand 包内固定版本的 Pi SDK。 |

服务启动不预热 SDK。新建/切换到 Wand Agent 或执行其候选时才按需加载；Pi CLI 的启动、设置面板和资源发现不依赖 Wand SDK 的公共入口或 ModelRuntime。

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

```bash
node --test --import tsx tests/pi-cli-isolation.test.ts tests/pi-resource-selection.test.ts tests/pi-sdk-dependencies.test.ts tests/core-harness.test.ts tests/openrouter-free-cli.test.ts
```

- `pi-cli-isolation`：真实服务器在 SDK 入口被阻断时启动，CLI 创建/设置/资源发现正常；显式 SDK 返回错误，不留下半个会话。另一新进程证明只有显式 SDK 选择才首次导入它，且无全局预热也能创建 SDK 会话。
- `pi-resource-selection`：真实 CLI 子进程阻断公共 SDK 入口，仍完成选定 Skills/MCP 和 CodeMode 的本地 fixture 模型请求；未选服务器连初始化都不发生。
- `openrouter-free-cli`：源文件与编译文件的真实 CLI provider、工具续轮、resume 与价格边界回归，使用本地 fixture，不调用真实付费模型。
- `pi-sdk-dependencies`：发布 SDK 依赖闭包/锁/嵌套版本与新进程真实导入。

CI 在 `$RUNNER_TEMP/wand-ci-pi` 独立安装已验证的 Pi CLI 1.2.0，并把它的真实 npm bin 目录加入 PATH；测试不调用真实付费模型。这个安装不属于 Wand 的 SDK 依赖闭包，不能以 Wand `node_modules/.bin/pi` 冒充独立 CLI，也不修改机器上的全局 Pi。升级 CI CLI 时单独复验资源、加载隔离与拒绝/降级协议契约，不能把 CLI 版本机械跟随 SDK pin。

改动后跑完整 check/test/build，核对 npm tarball 的干净生产安装。最终验收用已安装服务；更新必须走现有部署锁/Core 排空流程，不重启或强杀 daemon，不修改全局 Pi CLI。
