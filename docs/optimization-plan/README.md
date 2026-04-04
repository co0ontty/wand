# 优化与排查计划

这个目录不解释“系统现在怎么工作”，而是专门回答另一件事：**当前实现中哪些部分不合理、为什么有风险、应该如何优先排查，以及后续如何分阶段优化。**

## 文档结构

- [系统审计与优化总计划](./system-audit-and-optimization-plan.md)
- [执行版任务拆解](./actionable-task-breakdown.md)
- [排查清单](./investigation-checklists.md)
- [重构路线图](./refactor-roadmap.md)
- [ProcessManager 职责地图](./process-manager-responsibility-map.md)
- [Claude PTY 样本与回放计划](./claude-pty-sample-replay-plan.md)
- [前端同步通道矩阵](./frontend-sync-matrix.md)
- [Source of Truth 对照表](./source-of-truth-map.md)

## 阅读顺序

1. 先看“系统审计与优化总计划”了解问题全貌与优先级
2. 再看“执行版任务拆解”把计划转成可开工任务
3. 再看“ProcessManager 职责地图”“前端同步通道矩阵”“Source of Truth 对照表”，把 Phase A 的事实源补齐
4. 再看“Claude PTY 样本与回放计划”，为后续 parser / permission / resume 收敛准备验证基础
5. 再看“排查清单”执行具体问题定位
6. 最后看“重构路线图”安排实施节奏

## 范围

本组文档重点覆盖：

- `src/server.ts`
- `src/process-manager.ts`
- `src/claude-pty-bridge.ts`
- `src/storage.ts`
- `src/config.ts`
- `src/session-lifecycle.ts`
- `src/session-logger.ts`
- `src/message-parser.ts`
- `src/auth.ts`
- `src/cert.ts`
- `src/ws-broadcast.ts`
- `src/pwa.ts`
- `src/web-ui/content/scripts.js`

## 文档边界

- 这里的结论是基于当前代码结构做的工程治理建议，不等于立即修改方案。
- 优先强调“先排查、再收敛、后重构”，避免直接对核心运行时做高风险手术。
- 如果后续代码发生明显变化，需要同步更新这里的优先级和证据链。
