# Web / Android 架构精简实施记录

最后更新：2026-09-28。状态：实施中。第一轮体积与构建精简见 `repository-slimming.md`。

用户本轮要求完成 Web 与 Android 的架构优化，并更新全局 agent 说明。本轮保留现有产品交互、HTTP DTO、数据库历史和原生签名；iOS/macOS/Render 实现不在修改范围。

## 实施队列

| 编号 | 目标 | 状态 | 验收 |
| --- | --- | --- | --- |
| T1 | 任务元数据唯一归 wand_tasks，容器字段归 workspace_tasks | 实施中 | 真实 SQLite 与两种路由行为、历史数据与归档、投影 fingerprint |
| T2 | Web composer 的草稿、附件与提交恢复由单一模块持有 | 实施中 | 切会话、失败/未知投递、迟到结果、队列与 native PTY 契约 |
| T3 | Android composer 从页面状态/副作用中收敛到会话模块 | 实施中 | 失败恢复、重复提交、附件/语音、会话切换与迟到结果 |
| T4 | Android 语音编译依赖只保留固定来源的 JVM API | 实施中 | 可复现提取与 SHA、轻量 fixture、官方产物完整性、Gradle/Beta |
| T5 | 本机已安装服务与原生 Beta 分发验收 | 待执行 | Web 真实流程；APK versionName/大小/SHA/更新端点 |
| T6 | 更新仓库和全局 agent 指南 | 待完成 | 所有权规则、按需构建、续接入口、正确的回滚路径 |

## 任务模块设计决策

已按 codebase-design 的 Design It Twice 比较三个方案：少入口命令模块、可编辑事务聚合、既有 storage 的规范投影。采用第三种，吸收事务聚合的不变量要求。

- `wand_tasks` 唯一拥有标题、状态、目录归属、迭代、Agent 等任务元数据。
- `workspace_tasks` 唯一拥有 cwd、worktree、layout、layout revision、last opened 等运行容器数据。
- 旧 DTO 与 ID 保持兼容；旧重复列只为历史 schema 保留，正常读取根据明确关联 ID 投影。
- 正常会话归属以 `command_sessions.workspace_task_id` 为准；历史绑定表不再决定当前独占归属。
- 两种创建与修改入口由 storage 统一事务处理，调用方不再自行排 sync/ensure 顺序。
- 新写入使用默认迭代；历史 NULL 保留，读取时兑底。重复关联采用原查询的 updatedAt 优先规则并加 rowid 决胜，不按标题合并。
- 单卡读取改为 SQL 定点查询；列表 fingerprint 读取规范投影；正常请求不再全量修补双方任务。

确定问题一并修复：任务移动可能被旧看板项目写回；两表创建/修改缺少完整原子保障；getWandTask 每次扫描全表。

## 验证与进度

尚未执行本轮修改后的验证。源码基线保存于忽略目录 `output/architecture-stage2/baseline/`，用于区分已有用户工作与本轮修改，不能用它覆盖当前工作树。

## 续接步骤

1. 先读根 `AGENTS.md`、本文与各项最新验证记录。
2. 保留所有已有未提交改动；修改时按文件与行为边界合并，不 reset/clean。
3. 从队列中未完成项继续。最终运行 check/test/build；Web 验收使用私密 acceptance 文件指定的已安装服务。
4. Android 必须使用带版本的 Beta 构建部署到全局更新目录，并验证更新端点；默认不安装到设备。
5. 记录实际修改、删除数量、迁移策略、验收结果、客户端提交/推送与文档更新位置。
