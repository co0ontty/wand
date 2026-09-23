# Render 升级与回滚路径（无损升级）

本文描述**从「PTY 由 Node 的 `terminald` 持有」升级到「PTY 由常驻 Rust `wand-render` 持有」**时，
用户执行什么、机器上自动发生什么、出问题时怎么退回去。

前置阅读：

- `docs/render-protocol.md`（冻结契约 v1：职责边界、帧、方法表、生命周期）
- `docs/rust-core-migration-plan.md` §3.2（ADR-1 双角色）、§8（分发与运维）、§9（数据兼容清单）

一句话结论：**升级只重启 Server（web），不碰任何 PTY**。旧会话继续由 legacy `terminald` 服务，
新会话进 `wand-render`，两侧并存、互不领养；数据（`wand.db` / `config.json` / `sessions/` 制品）不需要迁移；
回滚是改一个配置键再重启 Server，同样不杀会话。

---

## 1. 用户看到的部分

### 1.1 用户执行的命令

外部升级（推荐，stable / beta 同一链路，只差 dist-tag）：

```bash
npm i -g @co0ontty/wand@latest   # stable
npm i -g @co0ontty/wand@beta     # beta
wand service:restart             # 装了系统服务时（system scope 需要 sudo）
# 没装服务时：重启你自己的 wand web 进程；应用内更新会自动完成重启
```

应用内更新：设置里的更新入口 → `POST /api/update`（stable/beta 通道取自 SQLite `updateChannel`），
用户点一次「更新」，其余全是自动步骤（见 §1.2）。

验收 / 排障用的只读命令（不改任何东西）：

```bash
# 只看二进制是否就位、版本是否与包内一致（退出码 0=无需动作，4=需要就位）
node "$(npm root -g)/@co0ontty/wand/scripts/install-render-binary.js" --check -c ~/.wand/config.json
# 看它「将会」做什么，不写磁盘
node "$(npm root -g)/@co0ontty/wand/scripts/install-render-binary.js" --dry-run -c ~/.wand/config.json
```

### 1.2 用户看不到的自动步骤

外部 `npm i -g`（或应用内更新，二者在这一层等价）：

1. **npm 覆盖全局包目录**：`dist/` + `native/<triple>/` 被新版本替换。正在运行的进程（web、`terminald`
   里已加载的 JS、已 map 的二进制）持有旧 inode，**不受影响**；也不会因为替换文件而被杀。见 §2。
2. **应用内更新多两步**（`src/update-helper.ts`、`src/service-self-repair.ts`）：detached helper 执行
   `installPackageGloballyAsync()` → `node <新全局 CLI> init -c <config>` → `kill -TERM <旧 web pid>`
   （**只 TERM web 进程，不含 `terminald`**）→ 有服务则等 systemd/launchd 按 `Restart=always` 拉起，
   否则 helper 自己 spawn 新进程；随后 `repairServiceUnitAfterUpdate()` 把 unit 的 `ExecStart` 重新钉到全局 shim。
   全程没有 `pkill`、没有按名字杀进程组。
3. **新 Server 启动早期：Render 二进制就位**（`scripts/install-render-binary.js`，幂等，通常零写盘）。
   本次交付只提供这个工具与它的调用契约；`src/` 里的调用点见 §10「集成缺口 1」。见 §3。
4. **`createUpgradeAwareTerminalHost()`**（`src/render-host.ts`）：按引擎开关决定 owner，见 §4/§5。
   - `engine=legacy` → 老行为：adopt 已有 `terminald`，没有才 spawn。
   - `engine=auto` / `rust` → **只 adopt** 已存在的 `terminald`（绝不 spawn、绝不 kill），
     再 adopt 或 spawn `wand-render`，然后按所有权复合路由。
5. **结构化会话恢复**：`structuredSessions.recoverDetachedRuns()`（`src/server.ts`）把仍跑在
   `terminald` 里的结构化 CLI run 重新接上（这条路径本次没有被改动）。
6. **legacy `terminald` 用完后退场**：Node 侧在它不再持有任何 running 会话后停止路由（见 §4.4）。

---

## 2. 分发布局：两个仓库、两个 submodule

Render 的**源码**与**产物**都不在本仓库：

| submodule | 仓库 | 内容 | 谁更新 |
| --- | --- | --- | --- |
| `render/` | `co0ontty/wand-render` | Rust 源码、协议文档、四平台打包脚本、CI/Release workflow | Render 开发者提交 |
| `render-bin/` | `co0ontty/wand-render-bin` | `v<版本>/<triple>/wand-render` + `manifest.json`（含 sha256/size/protocolVersion） | 只由 `render/` 的 CI 写入 |

为什么拆两个：**发布节奏解耦**。Render 修一个 bug 只需要 `render/` 提交 → 打包 → 产物进 `render-bin/`；
Server 完全不必重新编译 Rust，也不必跟着发版。两个 submodule 指针互相独立，
可以「只换二进制不换源码」（`render-bin/` 单独 bump），也可以「只改源码不发版」。

### npm 包里的东西

```text
@co0ontty/wand/
  dist/                                     # Node Server（npm run build 产物，每次构建 rm -rf）
  dist/native/darwin-arm64/wand-render      # 由 npm run build:render-bin 从 render-bin/ stage 过来
  dist/native/darwin-arm64/wand-render.version
  dist/native/darwin-arm64/wand-render.sha256
  dist/native/darwin-x64/…  dist/native/linux-x64/…  dist/native/linux-arm64/…
  scripts/install-render-binary.js          # 就位工具（启动自检与手工排障共用）
  scripts/stage-render-binaries.js          # stage 工具（构建期用）
```

- 产物放在 `dist/native/` 下：`npm run build` 会 `rm -rf dist`，所以 stage 必须是构建链的**最后一步**
  （`build:render-bin` 已挂在 `npm run build` 末尾）。
- `package.json` 的 `files` 是 `["dist", "browser-extension", "scripts/install-render-binary.js", "scripts/stage-render-binaries.js"]`；
  `dist` 已覆盖产物，不需要单独的 `native` 条目。
- stage 时**逐个校验 sha256**（来自 `render-bin/manifest.json`），并用 `--version` 输出做内容级检查：
  版本不符、或输出里含 `stub` 一律报错退出。这条护栏来自真实事故——曾有只打印 `(stub)` 的假二进制进过分发目录，
  哈希与版本号都是 `0.1.0`，光看版本号分辨不出来。
- `npm run build` 里 stage 是 **best-effort**（没拉子模块的开发机不该构建失败）；
  **发版必须硬失败**：`npm-release.yml` 里 `npm run build` 之后额外跑一次
  `node scripts/stage-render-binaries.js --strict --check`，缺产物直接拦在 publish 之前。
- `npm-release.yml` 的 `actions/checkout` 必须带 `submodules: recursive`（已接线）。
  漏了这行，包里就不会有 `dist/native/`，线上 `engine=auto` 静默回退 legacy ——
  「Rust 化」在产品上等于没发生，而且没有任何报错。
- 平台三元组只支持 `darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64`；
  **win32 明确不实现**（协议 §9.5.1 第一阶段不做命名管道与 ConPTY），
  win32 上就位脚本以退出码 `1` 明示不支持，引擎保持 legacy，功能不降级。
- Linux 产物静态链接 musl（`render/.cargo/config.toml`），避免在旧发行版上
  `GLIBC_x.y not found`；因此必须在 Linux runner 上原生构建，不能交叉编译糊过去。
- 体积代价：四个平台各带一份二进制（真实实现约 0.8 MB/平台），包解压体积大致 +3 MB。
  替代方案是按平台拆 `optionalDependencies`（npm 只装当前平台那份），
  代价是四个包要各自发版，收益不抵复杂度，暂不采用。

## 3. 二进制就位：时机、幂等、原子性

工具：`scripts/install-render-binary.js`（可 `import`，被 `main` 之外调用时不会执行任何动作）。

### 3.1 源与目标

| 顺序 | 源 | 说明 |
| --- | --- | --- |
| 1 | `--from <path>` | 显式指定；路径不存在**直接报错**（退出码 2），不静默回落 |
| 2 | `WAND_RENDER_BIN` | 与 `src/render-binary.ts` 的显式开关一致，视为等价于 `--from` |
| 3 | `<repo>/render/target/release/wand-render` | 开发态：`cargo build --release` 的产物优先于分发包，改完立刻生效 |
| 4 | `<pkg>/native/<triple>/wand-render` | **npm 包内**的正式位置 |
| 5 | `<pkg>/dist/native/<triple>/wand-render` | 兼容 `src/render-binary.ts` 既有的候选位置，避免两处布局分叉 |

目标：`<configDir>/bin/wand-render`（`<configDir>` = `--config` 的所在目录，默认 `~/.wand/`），
旁边写 `<configDir>/bin/wand-render.version`。

### 3.2 幂等与原子性

- **幂等**：先读目标版本（优先 sidecar，缺失/损坏才回落去问二进制），与源版本比较；
  一致就 `skip`，**不创建目录、不写文件、不动 mtime**（Server 每次启动都会跑一次，绝不能每次刷盘）。
- **原子**：复制到同目录临时文件 `wand-render.tmp-<pid>-<rand>` → `chmod 0755` → `rename()` 覆盖。
  绝不用「就地写入」替换正在被执行的二进制（Linux 会 `ETXTBSY`，且可能留下半截可执行文件）。
  rename 语义还保证：**正在运行的 `wand-render` 进程不受影响**（老进程持有老 inode），
  下次 spawn 才用新二进制。
- **失败安全**：任何一步失败都清掉临时文件并保留原二进制；读不出版本的二进制被视为「需要替换」。
- **版本相同的不同构建**（本地 `cargo build` 后 Cargo 版本没变）：版本比对判不出差异，
  这是刻意的（否则每次启动都要按内容比对）。开发态请显式 `--force`。

### 3.3 调用时机与退出码

- **Server 每次启动 check 一次**（幂等、通常零 IO 写），位置在 `createUpgradeAwareTerminalHost()` 之前
  —— 见 §10「集成缺口 1」，`src/` 里目前还没有这个调用点，需要 Node 侧加。
- 也可在 `install.sh` / 更新 helper 的 `wand init` 之后顺手跑一次（与启动自检等效，纯粹省一次启动等待）。

| 退出码 | 含义 | 调用方该怎么处理 |
| --- | --- | --- |
| 0 | 已就位 / 已是最新 / `--dry-run` 判定无需或可以就位 | 继续启动 Render |
| 1 | 平台不支持（win32 等）或参数错误 | `auto` → warning + 用 legacy；`rust` → 报错 |
| 2 | 找不到源二进制 | `auto` → warning + 用 legacy；`rust` → 报错 |
| 3 | 就位失败（只读盘 / 无写权限 / 磁盘满） | warning（旧二进制未被破坏，仍有可用二进制时继续用） |
| 4 | `--check` 判定需要就位 | 只读探询用；真就位请去掉 `--check` 再跑 |

不联网、不读 `config.json` 内容（只取目录）、不打印任何密钥或环境变量。

---

## 4. 无损机制：adopt + 复合路由

### 4.1 升级瞬间的所有权

```
升级前                                 升级后
─────────────────────────────         ─────────────────────────────────────────────
wand web  ── socket ──► terminald      wand web ──┬─ socket ──► terminald（旧代码，仍持有升级前的 PTY）
  （可重启）              （持有 PTY）              └─ socket ──► wand-render（新会话的 owner）
                                                      （同样不随 web 重启退出）
```

- 新 Server 对 `terminald` **只 adopt**（`connectExistingTerminalHost()`）：`hello` → `list` 拿到
  inventory 与每会话的 `chunks` / `seq`，旧 PTY 的字节流一条不丢。
- **所有权判定只能靠 legacy 自己的 inventory**：Server 无法从 DB 倒推「这个 PTY 现在归谁」，
  所以 `CompositeTerminalHost.createOrAttach()` 先问 legacy（命中即用它），否则交给 Render。
- **升级过程中不杀任何 PTY**：`CompositeTerminalHost.disconnect()` 现在只是两侧解绑，
  协议 §6 同样要求 Render 侧 `disconnect` 只解绑。任何「升级顺手清干净」的改动都是禁止项。

### 4.2 三类会话各自的归属

| 会话类型 | 升级后归属 | 原因 |
| --- | --- | --- |
| 升级前已存在的 PTY | legacy `terminald`（到自然结束为止） | 进程就在它里面，跨进程搬不动 |
| 升级后新建的 PTY | `wand-render` | 新 owner 从第一天起接管新会话 |
| 结构化 CLI run（`structuredSpawn` 那套） | **仍是 legacy `terminald`**（新旧都算） | Render 协议 v1 只有 PTY，没有 `structured*` 方法（`docs/render-protocol.md` §3），所以 `src/server.ts` 把 `structuredExecHost` 绑到 `legacyHost` |

第三行是本次升级的硬边界，不是疏漏：**只要还有结构化会话跑在 `terminald` 里，它就必须活着**。
把结构化 runner 迁到 Rust 属于 `docs/rust-core-migration-plan.md` §7 的 P2，不在本次范围内。

### 4.3 跨重启的持续可用

Render 是 detached 常驻（`setsid`、stdio 忽略、不随 Server 退出）。web 重启后：

- Render：`hello` 校验 `protocolVersion` → `list` 重建内存快照 → 按 `afterSeq` 补洞（`chunks` 有界重放窗口）。
- legacy：同一套（`TerminalDaemonClient` 的 reconnect + reconcile），并顺带
  `structuredList` / `structuredAttach` 重新接上结构化的活。
- 客户端（Web / Android / iOS / macOS / 扩展）**一行代码都没改**：REST/WS 契约
  （`init`/`output`/`ping`/`resync_required`/`pty_error`）保持不变。

### 4.4 legacy `terminald` 什么时候可以不再用 / 退出

- **停止路由的条件**：它不再持有任何 running 会话 —— 即 PTY `list` 与 `structuredList` 里都没有 running。
  「会话自然结束后停止路由」这件事必须由两侧**同时**为空才会发生。
- **进程退出**：`terminald` 只在 `SIGINT`/`SIGTERM` 上退出，而它的退出处理器会
  `forget()` 掉**全部**会话（PTY 会被杀）——所以「让它退出」只能发生在确认空仓之后，
  绝不能在还有会话时 SIGTERM。当前 `src/` 没有实现这个自动退出（见 §10「集成缺口 2」）；
  保守做法是**让它继续活着**（空仓的 daemon 不占资源、不影响任何功能），
  由机器重启自然回收。
- **升级批次内禁止改动 legacy daemon 协议**：`TERMINAL_DAEMON_PROTOCOL_VERSION` 必须保持 2。
  老 `terminald` 用的是升级前加载的内存代码，新 Server 只有说同一个协议才能 adopt 它；
  改这个常量会让正在升级的用户当场丢会话（旧 daemon 里还有活动 PTY，且没有可用工具把它搬走）。

---

## 5. 引擎开关与协议握手

### 5.1 开关

| 位置 | 键 / 变量 | 值 | 说明 |
| --- | --- | --- | --- |
| `config.json`（部署项） | `render.engine` | `auto`（默认）/ `rust` / `legacy` | 决定 PTY owner；只在启动时读 |
| `config.json` | `render.binaryPath` | 路径（可选） | 显式二进制；非可执行文件时**报错**，不静默回落 |
| 环境变量 | `WAND_RENDER_ENGINE` | 同上 | 优先于 config；非法值忽略并告警 |
| 环境变量 | `WAND_RENDER_BIN` | 路径（可选） | 与 `render.binaryPath` 同级；同样用于就位脚本的源解析 |

`config.json` 只**新增键**（`render`），旧文件没有该键时按默认值处理，不会因为新字段启动失败；
`wand.db` 无 schema 变更。

### 5.2 启动决策表

| 引擎 | 已存在 `terminald` | `wand-render` 可用 | 结果 |
| --- | --- | --- | --- |
| `legacy` | 有 | 任意 | adopt（或 spawn）legacy，老行为；**不启 Render** |
| `auto`/`rust` | 有 | 有 | adopt legacy + adopt/spawn Render → `CompositeTerminalHost`（旧会话 legacy，新会话 Render） |
| `auto`/`rust` | 无 | 有 | 只有 Render（新机器，没有历史会话要兼顾） |
| `auto` | 任意 | 无（找不到二进制 / 平台不支持） | **warning + 用 legacy**（旧会话仍在 legacy，功能不降级） |
| `rust` | 任意 | 无 | **报错启动失败**（显式要求必须满足，不偷偷降级） |
| `auto` | 任意 | 有但起不来（协议不符 / 活着但 socket 不可用） | warning + 用 legacy；**不会**再 spawn 第二个 Render |
| `rust` | 任意 | 同上 | **报错启动失败** |

### 5.3 协议版本握手规则

- 每个请求都带 `protocolVersion`（当前 `RENDER_PROTOCOL_VERSION = 1`，双向镜像：
  `src/render-protocol.ts` ↔ `render/crates/wand-render-protocol/src/lib.rs`）。
- 连接后第一个请求必须是 `hello`；对端上报的 `protocolVersion` ≠ 本地要求
  → **抛错并标记 fatal**（后续请求直接失败），**不降级运行**（协议 §6：
  「协议版本不匹配 → 明确报错，不做降级运行」）。
- `engine=rust` 下这个错误直接让启动失败；`engine=auto` 下会 warning + 回落 legacy
  （这是 auto 的定义：能起就起，起不来别把用户的终端弄丢）。要「必须报错」就把引擎设成 `rust`。
- **二进制过旧 → 先就位再启动**：启动自检按版本替换 `<configDir>/bin/wand-render`，
  所以「协议升级 + 二进制升级」在同一次 Server 启动里完成；替换不影响正在跑的旧 Render 进程，
  那个进程会在下一次「本来就会重启」的时机（机器重启 / 会话全空 / 显式 `shutdown drain`）换成新二进制。
- **双向升级的前提**：协议 bump 必须与二进制、TS 镜像在**同一个 npm 版本**里发布；
  跨版本混跑（新 Server + 旧 Render）只能靠「版本不匹配就报错」暴露出来，
  所以不要指望「新 Server 自动把旧 Render 迁过来」——那需要旧 Render 自己的 `shutdown drain`，
  而 drain 也得说得上话（见 §10「集成缺口 3」）。

---

## 6. 回滚

### 6.1 一步回滚（引擎）

```bash
# 1) 改部署项（不动 DB、不动会话）
#    config.json: { "render": { "engine": "legacy" } }
wand service:restart        # 没装服务就重启 wand web
```

回滚后的行为：

- 立即回到「PTY 由 legacy `terminald` 持有」的老路径（adopt 已有 daemon，没有才 spawn）。
- **不杀任何 PTY**：`terminald` 里的旧会话继续服务；`wand-render` 里的会话**也继续活着**
  ——Render 进程不会因为 Server 换引擎而被杀，它会一直持有这些 PTY 直到会话自然结束。
  （`engine=legacy` 下 Server 不再新建 Render 会话，`render` 侧只做「不打扰」。）
- 也可以用环境变量瞬时覆盖（排查用，别当长期配置）：`WAND_RENDER_ENGINE=legacy`。

### 6.2 二进制回滚

```bash
# 回到指定旧二进制（下次 spawn 生效；正在跑的进程不受影响）
node "$(npm root -g)/@co0ontty/wand/scripts/install-render-binary.js" \
  --force --from /path/to/old/wand-render -c ~/.wand/config.json
# 或者干脆删掉，让启动自检从包里重新就位
rm -f ~/.wand/bin/wand-render ~/.wand/bin/wand-render.version
```

要点：不要 git checkout / 手动覆盖 `~/.wand/bin/wand-render`（绕过原子替换可能留下半截文件）；
用 `--force --from` 或删除后重新就位。

### 6.3 不需要回滚数据

| 项 | 为什么不用回滚 |
| --- | --- |
| `wand.db` | 本次改动没有 schema 迁移（迁移只加不删的约定也没被触碰） |
| `config.json` | 只**新增** `render.*` 键；回滚 = 把 `engine` 改回 `legacy`（或删掉整个 `render` 键走默认 `auto`） |
| `sessions/<id>/` 制品 | 文件名与格式未变（原始输出 / 结构化流事件 / 诊断材料） |
| 会话历史与 resume 标识 | 存在 DB 与各 provider 历史目录里，与 PTY owner 无关 |
| `terminald` 的 token/pid/socket | Render 用**另一套**文件名（`.render-<suffix>.*` / `wand-render-<uid>-<suffix>.sock`），两侧互不覆盖、互不领养；回滚只意味着 Render 那套文件不再被创建/读取 |
| 客户端 | 契约未变，无需随服务端回滚 |

---

## 7. 状态对照表

| 维度 | 升级前（现状：只有 Node `terminald`） | 升级后（`render.engine=auto`/`rust`） | 回滚后（`render.engine=legacy`） |
| --- | --- | --- | --- |
| 新 PTY 的 owner | `terminald`（Node） | `wand-render`（Rust） | `terminald`（Node） |
| 升级前已存在的 PTY | `terminald` | `terminald`（复合路由，直到自然结束） | `terminald` |
| `wand-render` 里的 PTY | 不存在 | `wand-render`（一直持有到自然结束） | `wand-render`（**继续活着**，只是不再新建） |
| 结构化 CLI run | `terminald` | `terminald`（新旧都算，Render v1 不做 structured） | `terminald` |
| 常驻进程 | `wand web` + `wand terminald` | `wand web` + `wand terminald` + `wand-render` | `wand web` + `wand terminald`（+ 可能仍在的 `wand-render`） |
| 二进制位置 | `dist/`（Node，随 npm 包） | npm 包 `native/<triple>/` → 就位到 `<configDir>/bin/wand-render` | 保留（与 legacy 无关） |
| 运行时元数据文件 | `.terminald-*.token` `.terminald-*.pid` `/tmp/wand-terminald-*.sock` | 两套并存（名字不同） | 只剩 legacy 那套；Render 的由 Render 退出时清理 |
| `config.json` | 无 `render` 键 | 可含 `render.engine` / `render.binaryPath` | `render.engine=legacy`（唯一差异） |
| `wand.db` / `sessions/` | — | **不变** | **不变** |
| 客户端 REST/WS 契约 | — | **不变** | **不变** |
| web 重启时 PTY | 不丢（daemon 持有） | 不丢（两个 daemon 各持自己的） | 不丢 |
| 升级/回滚代价 | — | 换包 + 重启 web（PTY 不断） | 改一个键 + 重启 web（PTY 不断） |

---

## 8. 边界与故障模式

| 症状 | 行为 | 用户该做什么 |
| --- | --- | --- |
| 找不到 `wand-render` 二进制（`auto`） | `WARNING: render.engine=auto but no wand-render binary was found; PTYs stay on the legacy terminald.` → 用 legacy 起 | 想用 Rust 引擎：`npm run build:render-native`（开发）或重装 npm 包；`render.binaryPath` / `WAND_RENDER_BIN` 指定路径 |
| 找不到二进制（`rust`） | 启动失败，错误里列出所有查过的位置 | 同上，或改回 `auto`/`legacy` |
| 平台不支持（win32） | 就位脚本退出码 1 + 明示；引擎保持 legacy | 无需处理（第一阶段不支持） |
| Render pid 活着但 socket 不可用 | **等待就绪（5s），不另起第二个 daemon**；仍失败→`rust` 报错启动失败，`auto` 打 warning 后用 legacy（旧会话不丢）。两种情况都不会静默降级到「不知情的第二个 Render」 | 看 `<configDir>/.render-<suffix>.pid` 对应进程；必要时 kill 该 pid 后再重启 web |
| 上一轮 `renderd` 崩溃留下孤儿 socket 文件 | 探明「没人监听」后**删掉 socket 文件**再 spawn（否则会永久等一个不会就绪的 socket） | 无需处理 |
| 协议版本不匹配（adopt 被拒） | `engine=rust` → 启动失败并打印双方版本；`engine=auto` → warning + legacy；**不会**起第二个 Render | 统一版本（装同一个 npm 版本）后重启；别用跨版本混跑 |
| token 不符 | 连接被立即关闭（协议 §2，token 文件 0600） | 检查是不是 `-c` 指到了别的 config（不同 config 有不同 token/socket） |
| 就位时磁盘只读 / 无写权限 | 退出码 3，打印 `EACCES`/`EROFS` 等 errno；**已安装的旧二进制未被破坏** | 修权限，或把 `render.engine` 设成 `legacy` 先保证能用 |
| 目标版本与源版本相同但其实是不同构建 | 判定为「一致 → 跳过」（幂等优先） | 开发态用 `--force` |
| 多实例（`-c /tmp/x/config.json`） | 各自独立：socket/token/pid/meta 全按 config 路径派生（sha256 前 12 位），两侧命名也不同 | 隔离测试按项目约定用独立 config，不要读到默认实例 |
| 手工 `kill -9` 掉 `wand-render` | PTY 随之消失（进程被杀，子进程收到 SIGHUP）；Server 侧旧客户端重连后（token 会轮换，客户端每次 connect 重读 token 文件）把会话合成为 `failed` 并落库 | 别杀；要停就分清「drain（保留运行中会话）」与「now（杀 PTY，仅在明确要求时）」 |
| 对 `wand-render` 发 `SIGTERM` / `SIGINT` | **第一次 = drain**：不再接受新会话、已退出会话释放，但**进程继续运行**（运行中 PTY 全部保留，`attach` 仍能拿到 running 会话）。已经处于 drain 状态后再收到一次 drain 请求（信号或 `shutdown {mode:"drain"}`）才升级为 `now`：杀掉所有 PTY 并退出 | 只想升级二进制时发一次即可；确认没有运行中会话后再发第二次 |
| 对 `wand-render` 发 `shutdown {mode:"drain"}` | 与第一次 SIGTERM 相同：进程不退出。真正的退出要走 `{mode:"now"}` 或再发一次信号 | Render 自升级流程应当用 drain 做完切换后，再用 `now` 收尾 |
| `list` 的完整响应超过单帧 64MiB | daemon **在同一方法内逐级降级重试**：去掉每会话快照 → 连 `output`/`chunks` 也省掉，降级后 `list` 仍然成功返回并打一行 stderr；只有连元信息都放不进单帧才回 `internal` 错误帧（绝不静默吞掉，也不会让客户端干等 10s 超时） | `list` 只用于启动期建 inventory；屏幕重建走 `attach`。快照为 `null` 时 `ProcessManager` 会用 `output` 重放兜底 |
| 手工 `kill` 掉 `terminald` | 它退出时会 `forget()` 全部会话 → **PTY 全被杀** | 绝对不要在还有会话时停它；确认空仓才动 |
| `npm i -g` 正在运行时 | 运行中的进程持有旧 inode，不受影响；新启动的进程用新版 | 装完重启 web 即可 |

---

## 9. 验证（本次交付实测）

```console
$ node scripts/install-render-binary.js --dry-run -c /tmp/<isolated>/config.json
[wand-render] 平台 darwin-arm64，配置目录 /tmp/<isolated>
[wand-render] 源二进制：<repo>/render/target/release/wand-render（cargo target） v0.1.0
[wand-render] 已安装：无
[wand-render] 需要就位（目标不存在）。
[wand-render] 将写入 /tmp/<isolated>/bin/wand-render，并写版本文件 /tmp/<isolated>/bin/wand-render.version
# 退出码 0；目录里什么都没被创建

$ node scripts/install-render-binary.js -c /tmp/<isolated>/config.json   # 真就位
[wand-render] 已就位 /tmp/<isolated>/bin/wand-render v0.1.0
$ node scripts/install-render-binary.js -c /tmp/<isolated>/config.json   # 再跑一次（幂等）
[wand-render] 版本一致（v0.1.0），跳过：不写磁盘、不重启任何进程。
# mtime/size 前后一致
```

其余已实测的行为：`--check` 在需要就位时退出码 4；`--from` 不存在退出码 2；
只读目录退出码 3；`--help`；win32 / 未知 arch 退出码 1；版本不一致（改 sidecar）→ 重新就位；
sidecar 损坏 → 回落问二进制；跨平台包布局（只有 `native/<triple>/`）能被识别。

`npm pack --dry-run`（不发布）确认 `files` 生效：

```
npm notice 302.6kB native/darwin-arm64/wand-render
npm notice 6B native/darwin-arm64/wand-render.version
npm notice 19.4kB scripts/install-render-binary.js
```

本地命令链路：`npm run build:render-native`（cargo build --release → stage 到 `native/<triple>/` + sidecar）。

**尚未验证（需要真机/CI，见 §10）**：`render/.github/workflows/release.yml` 的实际 runner 行为（本地无法跑 GitHub 矩阵）、
升级过程中活动 PTY 的连续性人工验收（按项目记忆，必须用本机已安装服务 + 连接码走一遍：
PTY 会话不中断、结构化会话不丢、终端可输入、重连/resume 正常）。

---

## 10. 已知缺口与后续工作

按「会不会影响用户」排序。

1. **结构化会话不跨 Server 重启存活（相对现状的功能回退，已披露）。**
   `engine=auto|rust` 下 Render 只接管 PTY；结构化 CLI run 仍由 legacy `terminald` 承载，
   而新引擎**只 adopt 不主动 spawn** 它。所以机器上本来没有 legacy daemon 时，
   `structuredExecHost` 为 undefined → 结构化 run 退化为进程内运行、`recoverDetachedRuns()` 变 no-op。
   升级用户（旧 daemon 仍在跑）不受影响，**新装用户受影响**。
   已在启动时打醒目 WARNING 并给出规避方式（`render.engine=legacy`）。
   正解是下一阶段把结构化 runner 迁到 Render（`docs/rust-core-migration-plan.md` P2），
   或在无 legacy daemon 时按需只为结构化 spawn 一个。
2. **Render 自身的热升级（换二进制而不断 PTY）未实现。** `drain` 现在语义正确（保住运行中会话），
   但真正切换还需要 PTY master fd 的 `SCM_RIGHTS` 交接，或用「新版起新 daemon、旧版活到最后一个会话结束」
   的双实例编排。当前 0.1.0 的升级路径是「无运行中会话时直接换」。
3. **平台覆盖只有 darwin-arm64。** `render-bin/manifest.json` 目前 1/4 个平台；
   darwin-x64 / linux-x64 / linux-arm64 需要由 `render/.github/workflows/release.yml`
   在对应 runner 上构建后才有。在补齐之前，非 darwin-arm64 机器上 `engine=auto` 会回退 legacy。
4. **legacy `terminald` 空仓后不会自动退场**，会一直挂着（不占资源，机器重启自然回收）。
   自动停止必须先确认两侧都没有 running 会话——legacy 的 SIGTERM 会 `forget` 全部会话并杀掉 PTY。
5. **Render 侧没有总会话内存上限。** 单个 1000 列、满回滚的会话 RSS 可达约 350MB；
   `stats.liveBytes` 只统计 output/chunks，严重低估真实占用（网格 + 快照不在内）。
6. **Windows 只有 cfg 拆分与明确拒绝**：`cargo check --target x86_64-pc-windows-msvc` 通过，
   但没有命名管道、ConPTY 与信号语义的实现，也没有 Windows 运行时验收。
7. **客户端 socket 归属校验的宽度与文档不完全一致**：协议要求 0600，
   Node 客户端只拒绝「组/其他人可写」（为了兼容 legacy daemon 建出的 0755 socket）。
   legacy 退役后应收紧到 0600。
8. **`attach()` 目前读本地 inventory 而不是每次都发 RPC。** 启动恢复路径恰好紧跟 `list`，
   所以当前看不到问题；但 `list` 里的快照按协议 §9.1.1 已裁剪到 64KiB，
   需要精确屏幕的调用方必须走 `attach`。
