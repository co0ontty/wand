# 任务一级容器改造：现状与多端同步计划

> 创建：2026-08-23。本文是「会话/项目割裂 → 任务一级容器」改造的**单一事实来源**：
> 目标形态、服务端契约、各端进度、已发现问题与排期。深入行为分析仍见
> `server-logic-analysis.md` / `client-logic-analysis.md` / `optimization-plan.md`（切片 6 为本文件的源头条目）。

**状态（2026-08-23）：服务端 + Web + iOS + macOS + Android 全部完成。**
三端均已推送到各自 master；Android beta APK 已出包部署并验证本地分发接口。
剩余工作见 §6 遗留问题（Missions 并入、分页、批量删除等）。

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

### iOS（进行中）

| 项 | 状态 |
| --- | --- |
| `createWorkspaceTask` 增加 `worktree: Bool?`（缺省不发，显式 false 才发 `worktree:false`） | ✅ |
| 模型 `WorkspaceTaskSummary` + `TaskDirectoryGroup`（含 `isSynthetic`） | ✅ |
| API `listTaskGroups()`（GET /api/tasks） | ✅ |
| Store：`taskGroups` published + `loadTaskGroups(force:)`（失败静默降级保留旧数据）+ `createTask(name:directory:worktree:)`（find-or-create 项目 → 建任务 → 刷新聚合） | ✅ |
| 单测：worktree 参数省略/显式 false、聚合 JSON 解码（合成组、isolated、standalone） | ✅ 全过 |
| UI：新建任务 Sheet（名称 + 目录建议 + worktree Toggle），替换原 alert（alert 放不下 Toggle） | ✅ |
| UI：「任务 / 项目」分段视图，任务模式消费 `/api/tasks` 聚合；根分区「项目」改名「任务」；未分组会话折叠区 | ✅ |
| 顺带修复存量 409 恢复 bug（见问题 #1）；全量 94 测试通过；已推送 `0a470e1` | ✅ |

验证方式：`cd ios && xcodebuild test -project Wand.xcodeproj -scheme Wand -destination 'platform=iOS Simulator,name=Wand Debug'`

### macOS（✅ 已完成）

- 与 iOS 同套改造：API/Store/模型（worktree 开关 + /api/tasks 聚合）+ 任务/项目分段视图 + 新建任务 Sheet（名称/目录/worktree Toggle）
- 侧栏分区与主按钮改为「任务 / 新任务」；主区空态改引导建任务
- 新增契约测试 WorkspaceTaskContractTests（对齐 iOS，防两端漂移）

### Android（✅ 已完成，beta 已出包部署）

- WorkspacePort/WandApi：createWorkspaceTask(worktree 开关) + listTaskGroups + 三个新模型
- WorkspaceListScreen：项目卡片「＋ 新任务」对话框（名称 + worktree Switch），创建后直接打开任务
- 修复 SessionListState 的 409 恢复 bug（同 iOS）
- beta APK `wand-v4.47.0-debug.08231847.apk` 已部署 `~/.wand/android/`，`/api/android-apk-update?channel=beta` 验证返回 `source:"local"` 新版本

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

**状态（2026-08-23 二次迭代）：#1–#6 全部完成。**

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | 原生客户端同步 | ✅ 三端完成（见 §4） |
| 2 | Missions 并入任务模型：`Mission.taskId` 可选关联；关联任务的派发直接落在任务目录（不叠加隔离）且会话绑定 `workspaceTaskId`；Web 打开并行任务时若处于任务上下文自动关联并提示 | ✅ |
| 3 | 批量删除入口：任务展开区提供「清空会话(n)」（两段确认），走 batch-delete 接口 | ✅ |
| 4 | `/api/tasks` 参数化：`workspaceId` 过滤、`limit`（每目录任务数）、`maxSessions`（每任务内嵌会话数，附 `totalSessions` 真实总数） | ✅ |
| 5 | `.session-directory-*` 死样式清理：确认 React 层与 legacy 浏览器层均无使用方后整体删除；服务端 `/api/session-directories` 与 `session-directory-tree.ts`（workspace binding 在用）保留 | ✅ |
| 6 | 任务内建会话布局竞态：`openTask` 返回恢复完成的 Promise，侧栏「＋」建会话前先 await，不再被旧快照覆盖选中态 | ✅ |
| 7 | 旧版回滚层（`?reactUi=0`）仍是旧 UX，属预期，不做同步 | 📌 保留 |

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
