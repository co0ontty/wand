# 启动与 CLI 运行逻辑

这一部分解释 wand 是如何从一条命令启动成完整服务的，以及配置文件、数据库文件在启动阶段是如何被准备好的。

## 1. CLI 入口只在 `src/cli.ts`

用户侧可以执行的命令都从 `src/cli.ts` 进入。当前支持的子命令有：

- `wand init`
- `wand web`
- `wand config:path`
- `wand config:show`
- `wand config:set <key> <value>`
- 默认 `help`

代码入口流程：

1. 读取 `process.argv.slice(2)`
2. 通过 `readFlagValue()` 解析 `-c` / `--config`
3. 调用 `resolveConfigPath()` 得到配置文件绝对路径
4. 按子命令进入 `switch`

## 2. `-c/--config` 会改变整个运行根

`src/config.ts` 里的 `resolveConfigPath(inputPath)` 有两个重要分支：

- 有 `--config` 时：以当前工作目录为基准 `path.resolve(process.cwd(), inputPath)`
- 没有 `--config` 时：默认使用 `~/.wand/config.json`

这个路径不仅决定配置文件放哪，也间接决定：

- SQLite 数据库位置（`resolveDatabasePath(configPath)`）
- HTTPS 证书位置（`server.ts` 用 `resolveConfigDir(configPath)`）
- 会话日志目录（`ProcessManager` 构造时把 configDir 传给 `SessionLogger`）

所以 `-c /tmp/wand-test/config.json` 本质上是切出了一套新的运行空间，而不只是“换一个配置文件名”。

## 3. `wand init` 和 `wand web` 共享准备逻辑

CLI 中的 `ensureRequiredFiles(configPath)` 负责：

1. `resolveDatabasePath(configPath)` 算出数据库路径
2. `hasConfigFile(configPath)` 检查配置文件是否已存在
3. `ensureConfig(configPath)` 读取或创建配置文件
4. `ensureDatabaseFile(dbPath)` 创建或迁移 SQLite 表结构
5. 输出创建/就绪日志

这意味着：

- `wand init` 只是“显式做一次准备工作”
- `wand web` 也会做同样的准备，因此没有先跑 `init` 也能启动

## 4. 配置文件不是静态模板，而是会被规范化写回

`src/config.ts` 的 `ensureConfig()` 逻辑是：

1. 读取现有 JSON
2. 用 `mergeWithDefaults()` 与默认值合并
3. 重新 `JSON.stringify(..., null, 2)` 生成标准格式
4. 如果文本内容有变化，就写回文件

默认配置由 `defaultConfig()` 提供，关键字段包括：

- `host`, `port`, `https`
- `password`
- `defaultMode`
- `shell`
- `defaultCwd`
- `startupCommands`
- `allowedCommandPrefixes`
- `commandPresets`
- `shortcutLogMaxBytes`

这里有几个后续维护时要记住的事实：

### 4.1 新增配置字段时不能只改类型
如果你在 `types.ts` 给 `WandConfig` 新增字段，但忘了更新 `defaultConfig()` 或 `mergeWithDefaults()`，那这个字段就不会被稳定地写进用户配置。

### 4.2 `commandPresets` 有专门的规范化逻辑
`mergeWithDefaults()` 会：

- 过滤不合法 preset
- 规范 label / command
- 把 `cloud-code` / `cloudcode` / `claude code` 统一成 `claude`

因此这个数组不是原样透传。

## 5. `config:set` 只支持少数简单字段

CLI 的 `setConfigValue()` 目前只支持：

- 字符串：`host`, `password`, `shell`, `defaultCwd`
- 数字：`port`
- 枚举：`defaultMode`
- 布尔：`https`

如果新配置项要支持命令行修改，需要同时更新：

- `setConfigValue()` 的 switch
- 可能还要更新 Web 设置页的 `/api/settings/config`

## 6. 数据库初始化与迁移

`src/storage.ts` 的 `ensureDatabaseFile()` 会：

1. `mkdirSync(path.dirname(dbPath), { recursive: true })`
2. 打开 `new DatabaseSync(dbPath)`
3. 运行 `INIT_SQL`
4. 执行 `ensureCommandSessionSchema()` 做增量 schema 迁移
5. 关闭数据库

初始建表覆盖：

- `auth_sessions`
- `command_sessions`
- `app_config`

而 `ensureCommandSessionSchema()` 负责通过 `ALTER TABLE ADD COLUMN` 补充新列，例如：

- `archived`
- `archived_at`
- `claude_session_id`
- `messages`
- `resumed_from_session_id`
- `resumed_to_session_id`
- `auto_recovered`

也就是说，schema 演进策略是“只加列，不删列，不重建表”。

## 7. `wand web` 启动前后分别做什么

### 启动前
`cli.ts` 负责：

- 找到 config 路径
- 确保 config + db 存在
- 把已经准备好的 `config` 与 `configPath` 传给 `startServer()`

### 启动后
`server.ts` 负责：

- 创建 Express app
- 初始化 `WandStorage`
- 初始化 `ProcessManager`
- 注册 API / WebSocket / PWA 路由
- 监听端口
- 启动背景 startup commands
- 后台检查 npm 新版本

所以 CLI 并不持有长期业务状态，它只是启动阶段的装配入口。

## 8. 开发常用命令与当前事实

根据 `package.json`：

```bash
npm install
npm run check
npm run build
npm run dev
```

含义分别是：

- `npm run check`：TypeScript 类型检查（`tsc --noEmit`）
- `npm run build`：TypeScript 编译 + 复制 `src/web-ui/content` 到 `dist/web-ui/`
- `npm run dev`：直接运行 `tsx src/cli.ts web`

当前仓库没有：

- lint 命令
- formatter 命令
- 自动化测试命令
- 单测/单文件测试命令

因此“验证改动”主要依赖：

```bash
npm run check
npm run build
```

以及必要时手动启动：

```bash
node dist/cli.js init
node dist/cli.js web
```

## 9. 与其他模块的依赖关系

CLI / 启动阶段的依赖图可以简化为：

```text
cli.ts
  ├─ config.ts
  ├─ storage.ts
  ├─ types.ts
  └─ server.ts

server.ts
  ├─ auth.ts
  ├─ cert.ts
  ├─ config.ts
  ├─ process-manager.ts
  ├─ storage.ts
  ├─ message-parser.ts
  ├─ pwa.ts
  ├─ ws-broadcast.ts
  └─ web-ui/index.ts
```

换句话说：CLI 不复杂，但它决定了整个应用运行根目录与初始化顺序，后续所有“配置不生效 / 数据库不见了 / 证书生成到哪里去了”的问题，都应先从这里开始排查。
