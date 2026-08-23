# 任务一级容器改造：现状与多端同步计划

> 创建：2026-08-23。本文是「会话/项目割裂 → 任务一级容器」改造的**单一事实来源**：
> 目标形态、服务端契约、各端进度、已发现问题与排期。深入行为分析仍见
> `server-logic-analysis.md` / `client-logic-analysis.md` / `optimization-plan.md`（切片 6 为本文件的源头条目）。

**状态（2026-08-23）：服务端 + Web + Android + iOS + macOS 任务一级容器已完成。**
各端根页统一为目录组 → 任务 → 会话；「会话 / 项目」与「任务 / 项目」双层切换已移除。实现与验收证据见 §4。

## 1. 目标形态

所有端统一为**任务 = 一级容器**：

1. 新建任务：任务名 + 目录（目录级归属）+ 是否新建独立 worktree（switch 开关）
2. 会话只存在于任务内：建会话不选目录，自动绑定 `workspaceTaskId`
3. 「项目」不再是用户概念：同一目录自动复用隐式项目（find-or-create by cwd）
4. 未绑定任务的旧会话不丢失：按目录归入「未分组会话」

## 2. 服务端契约（已完成，向后兼容）

| 契约 | 说明 |
| --- | --- |
| `POST /api/workspaces/:id/tasks` | 新增 `worktree?: boolean`；显式 `false` 跳过隔离直接跑项目目录；缺省仍自动隔离（git）/降级（非 git） |
| `GET /api/tasks` | 目录组聚合：`[{ workspaceId, workspaceName, workspaceCwd, synthetic?, tasks:[{...task, cwd, isolated, sessions[]}], standaloneSessions[] }]`；未绑定任务的会话按 workspaceId→cwd→合成组归入 `standaloneSessions` |
| 兼容性 | 旧客户端不发 `worktree` 字段行为不变；`/api/tasks` 是纯新增 |

## 3. Web 端（✅ 已完成）

- 侧栏只有「任务」视图：移除会话/任务切换、散会话平铺列表、目录树、管理模式；主按钮固定「新任务」
- 收起窄栏渲染极简磁贴轨（仅「＋ 新任务」）
- 任务面板：目录分组（服务端聚合直出）→ 任务行（展开看会话、行内＋建会话、重命名、删除、Worktree 审查入口）→「未分组会话」折叠区
- 任务行操作按钮悬停显现（触屏常驻）；会话缩进与任务名对齐
- 无任务欢迎页唯一入口「＋ 新建任务」（移除 4 个绕过任务的快捷建会话按钮）
- 底栏 Missions 按钮改名「并行」，避免与新任务视图混淆
- 新建任务对话框：名称 + 目录（补全/最近）+ **worktree switch 卡片**（WandSwitch，动态说明，选中态描边）+ 提交前摘要条
- 测试：496/496 通过；SSR 契约断言全部更新到任务模型

## 4. 多端同步进度

### iOS（✅ 任务一级容器已完成）

| 项 | 状态 |
| --- | --- |
| `createWorkspaceTask` 增加 `worktree: Bool?`（缺省不发，显式 false 才发 `worktree:false`） | ✅ |
| 模型 `WorkspaceTaskSummary` + `TaskDirectoryGroup`（含 `isSynthetic`、`totalSessions` / `listedSessionCount`） | ✅ |
| API `listTaskGroups()`（GET /api/tasks） | ✅ |
| Store：`taskGroups` + `createTask` find-or-create + `clearTaskSessions` + `openTask(preferredSessionId:)` | ✅ |
| UI：根页固定任务列表，移除「会话 / 任务」与「任务 / 项目」分段 | ✅ |
| UI：任务行展开会话、行内「＋」建终端、单独删终端、「清空会话(n)」 | ✅ |
| UI：合成目录也可「＋」建任务；并行任务创建绑定当前 `taskId` | ✅ |
| 单测：聚合 JSON（含 totalSessions 缺省回退）、worktree 参数、409 恢复 | ✅ |

验证方式：`cd ios && xcodebuild test -project Wand.xcodeproj -scheme Wand -destination 'platform=iOS Simulator,name=Wand Debug'`

### macOS（✅ 任务一级容器已完成）

- 侧栏根页固定任务聚合：移除「会话 / 任务」与「任务 / 项目」分段；主按钮固定「新建任务」
- 任务行展开会话、行内「＋」建终端、单独删终端、「清空会话(n)」；合成目录可建任务
- Missions 创建绑定当前任务 `taskId`，并预填任务目录
- 契约测试覆盖 totalSessions 解码与缺省回退

### Android（✅ 任务一级容器已完成）

- 根导航固定为任务视图：删除旧 `SessionListScreen` / `WorkspaceListScreen` 以及两层模式切换，手机与平板共用 `TaskListScreen`
- `TaskListState` 以 `GET /api/tasks` 为任务层级唯一真源；普通会话只显示在任务或目录的「未分组会话」内
- Provider 原生可恢复历史保留为任务列表后的附加折叠分组；通知、launcher 最近会话和 session deep link 继续使用 `SessionListState`
- 全局「新任务」支持名称、目录、最近目录、worktree 开关；按规范化 cwd 复用 workspace，缺失时隐式创建
- 任务行内可新建绑定窗口、重命名、清空会话、删除任务和审查 Worktree；窗口创建会保存任务布局
- Mission 模型与请求补齐 `taskId`，任务详情提供「并行任务」入口，派发会话绑定当前任务
- Chat / PTY 导航保存 `workspaceId/taskId`，重命名、清空、删除和进程重建时保持任务上下文一致
- Android 子仓库提交 `5326bd0` 已推送到 `wand-android/master`
- 验证：`testDebugUnitTest` 211/211 通过，`assembleDebug` 通过；beta APK `wand-v4.47.0-debug.08232030.apk` 已部署，SHA-256 `dd85c9966c6b81a3bbc11dde828127b107dcec39295d15fc03830a7ddbc4f131`
- `/api/android-apk-update?currentVersion=0.0.0&channel=beta` 返回 `latestVersion:"4.47.0-debug.08232030"`、`source:"local"`，分发目录只保留最新 APK
- API 36 AVD `wand_pixel_8_api_36` 安装并连接真实本机 Wand 服务完成冒烟：任务根页无旧切换、目录/任务/未分组会话可达、未分组 PTY 打开与返回、新任务表单、任务详情和关联任务 Mission 均通过；截图保存在 `/tmp/wand-android-*.png`

### 提交工作流（submodule）

每端完成后：submodule 内 commit → `git push git@github.com:co0ontty/wand-<platform>.git HEAD:master` → 主仓库 `git add <dir>` 提交指针。

## 5. 工作中发现的问题

| # | 问题 | 状态 |
| --- | --- | --- |
| 1 | iOS 存量测试失败：`AlignmentParityTests.testSessionListStoreRefreshLoadMoreAnd409Recovery` 在干净 master 上同样失败。根因：**loadMore 遇 409 后的恢复刷新复用了过期 revision**，契约要求恢复刷新带 `revision: nil`。同一 bug 也存在于 Android `SessionListState.kt`，两端同步修复；macOS 无分页列表不受影响 | ✅ 双端已修 + 契约断言锁定 |
| 2 | Swift 协议见证坑：给 `createWorkspaceTask` 实现加第 4 个带默认值参数后协议不合规报错指向错误位置。解法：协议要求直接声明完整参数签名，不用带默认值的便捷方法当 witness | ✅ 已解决并记录 |
| 3 | tsx 测试路径的 JSX 经典转换问题：根 tsconfig 不含 web-ui 目录，tsx 回退 classic transform，无 `import * as React` 的组件在 SSR 渲染即炸。解法：SSR 可达的组件必须显式导入 React | ✅ 已解决并记录 |
| 4 | Missions 与任务概念撞名：底栏按钮已改「并行」，后续并入（见遗留 #2） | 📌 已缓解 |

## 6. 遗留问题（承接 optimization-plan 切片 6）

**状态（2026-08-23 三次复核）：#1–#6 已完成；Android 收敛与交付证据见 §6.1。**

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | 原生客户端同步 | ✅ iOS / macOS 已接入；Android 已完成任务一级根导航、创建/会话/Mission 绑定与 beta 交付（见 §4、§6.1） |
| 2 | Missions 并入任务模型：`Mission.taskId` 可选关联；关联任务的派发直接落在任务目录（不叠加隔离）且会话绑定 `workspaceTaskId`；Web 打开并行任务时若处于任务上下文自动关联并提示 | ✅ |
| 3 | 批量删除入口：任务展开区提供「清空会话(n)」（两段确认），走 batch-delete 接口 | ✅ |
| 4 | `/api/tasks` 参数化：`workspaceId` 过滤、`limit`（每目录任务数）、`maxSessions`（每任务内嵌会话数，附 `totalSessions` 真实总数） | ✅ |
| 5 | `.session-directory-*` 死样式清理：确认 React 层与 legacy 浏览器层均无使用方后整体删除；服务端 `/api/session-directories` 与 `session-directory-tree.ts`（workspace binding 在用）保留 | ✅ |
| 6 | 任务内建会话布局竞态：`openTask` 返回恢复完成的 Promise，侧栏「＋」建会话前先 await，不再被旧快照覆盖选中态 | ✅ |
| 7 | 旧版回滚层（`?reactUi=0`）仍是旧 UX，属预期，不做同步 | 📌 保留 |

### 6.1 Android 任务一级收敛实施记录

**状态：✅ 阶段 A–D 全部完成，提交 `5326bd0` 已推送，beta `4.47.0-debug.08232030` 已部署并通过 API 36 AVD 冒烟。**

#### 阶段 A：统一数据真源（✅）

1. 新建 `TaskListState`（或等价 Store），任务层级只消费 `GET /api/tasks`；移除任务模式下 `GET /api/workspaces` + 每项目 `GET /tasks` 的 N+1 加载。现有 `SessionListState` 降为辅助源，只服务 provider 原生可恢复历史、通知/launcher 快捷方式和 session deep link，不再渲染托管会话平铺主列表。
2. 模型补齐 `WorkspaceTaskSummary.totalSessions`，并让刷新、重命名、删除、建任务、建会话都回写或重拉同一份 task groups，避免 `taskCache` 与 `taskGroups` 双缓存漂移。
3. 为聚合 JSON、合成目录、未分组会话、截断会话总数和失败保留旧数据补契约测试。

**验收：**根列表一次刷新只有一个聚合请求；任何任务变更返回列表后立即一致；聚合失败时保留上次成功快照并可重试。

#### 阶段 B：收敛根导航与列表（✅）

1. 删除用户可见的 `SessionListViewMode` 和「会话 / 项目」分段切换，根页固定为任务列表；删除 `WorkspaceListScreen` 内「任务 / 项目」二级切换。
2. 单栏与宽屏侧栏共用同一个任务列表组件：目录组 → 任务 → 任务内会话；任务详情继续复用 `WorkspaceTaskScreen`。
3. 完整渲染并允许打开 `standaloneSessions`；把 `SessionListState` 中不在 `/api/tasks` 的 provider 原生可恢复历史作为附加折叠分组放在任务列表之后，同时保留通知、launcher 快捷方式和 session deep link 直达能力。
4. 将旧 `Screen.Workspaces` / 已保存 `workspaces` 导航状态恢复到任务根页，避免升级后落入死页面；移除无入口的项目浏览代码后再清理相关 Saver 分支。

**验收：**应用首页不再出现“会话 / 项目”或“任务 / 项目”切换；普通会话只在所属任务下出现，未绑定旧会话只在对应目录的「未分组会话」出现且可打开。

#### 阶段 C：把“新任务”变成唯一主入口（✅）

1. 顶栏主按钮、空态按钮和 launcher 快捷操作统一改为「新任务」。
2. 新任务 Sheet 收集任务名、目录和 worktree 开关；按规范化 cwd 查找既有 workspace，不存在时以目录名创建隐式 workspace，再创建任务并直接打开。
3. 目录组行内「＋」复用同一 Sheet 并预填目录；合成组也可通过该流程转成真实 workspace，不再因为 `synthetic` 而无法建任务。
4. 全局 `NewSessionScreen` 不再从主 UI 暴露，只保留旧 deep link/兼容入口；任务内「＋」继续通过 `createWorkspaceTaskWindow` 创建绑定 `workspaceTaskId` 的 Agent/PTY/Shell。

**验收：**首次使用且没有项目时也能一步建任务；同一规范化目录不会产生重复 workspace；从主 UI 新建的每个会话都有 `workspaceTaskId`。

#### 阶段 D：兼容、清理与交付（✅）

1. 忽略并清理旧 `wand-session-list-view/mode` 偏好，但继续支持会话通知、最近会话快捷方式和 session deep link。
2. 删除 `WorkspaceModeChip`、项目创建主入口、重复项目缓存与确认无引用的 `Screen.Workspaces`；项目 API 作为内部目录归属实现继续保留。
3. 增加导航恢复、单栏/宽屏、未分组会话打开、创建任务 find-or-create、任务内建会话绑定的测试。
4. 按 Android 流程执行 `./gradlew test`、`assembleDebug`，再生成带版本 beta APK，部署到 `~/.wand/android/` 并验证 `/api/android-apk-update?currentVersion=0.0.0&channel=beta`。
5. Android 子仓库测试通过后 commit/push，再更新主仓库 submodule 指针；最后把本文件 Android 状态改为完成，避免本地提交、远端和主仓库指针再次分叉。

**最终验收：**手机与平板首屏都只有任务一级信息架构；目录只是分组元数据，不再作为独立用户模式；新旧会话均可达；任务创建、会话创建、返回栈、进程重建和 beta 更新链路全部通过。

## 7. 验证基线

```bash
# 服务端 / Web
npm run check && npm test && npm run build
npm run build && node dist/cli.js web -c /tmp/wand-dev/config.json   # 隔离冒烟

# iOS
cd ios && xcodebuild test -project Wand.xcodeproj -scheme Wand \
  -destination 'platform=iOS Simulator,name=Wand Debug'

# Android（收尾）
cd android && SKIP_INSTALL=1 APK_DIST_DIR="$HOME/.wand/android" ./debug.sh
```

已知基线差异：iOS 全量套件在干净 master 上有 1 个存量失败（见问题 #1），以该测试修复或单独豁免为准。
