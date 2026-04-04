# 文档索引

这组文档用于从“运行时逻辑”和“依赖关系”两个角度梳理 wand 项目，重点帮助后续维护者快速理解：命令如何启动、服务如何组装、会话如何管理、Claude 输出如何被结构化、状态如何持久化，以及浏览器界面如何与后端通信。

## 阅读顺序

1. [架构总览](./architecture-analysis.md)
2. [启动与 CLI](./runtime/startup-and-cli.md)
3. [服务端与 API / WebSocket](./runtime/server-and-api.md)
4. [ProcessManager 与 PTY / Claude Bridge](./runtime/process-manager-and-pty.md)
5. [持久化、日志与生命周期](./runtime/persistence-and-lifecycle.md)
6. [Web UI 运行逻辑](./runtime/web-ui.md)
7. [内部依赖图](./runtime/dependency-map.md)
8. [发布与安装流程](./operations/release-flow.md)
9. [清理候选审计](./cleanup/cleanup-candidates.md)

## 文档边界

- 以当前仓库代码为准，不引用历史分支或外部讨论中的结论。
- 关注跨文件的运行时调用链，而不是罗列所有显而易见的目录结构。
- “清理无用文件”部分默认采取保守策略：先记录证据，再决定是否删除。

## 当前代码基线

本组文档主要基于以下文件整理：

- `src/cli.ts`
- `src/server.ts`
- `src/process-manager.ts`
- `src/claude-pty-bridge.ts`
- `src/storage.ts`
- `src/config.ts`
- `src/session-lifecycle.ts`
- `src/session-logger.ts`
- `src/message-parser.ts`
- `src/web-ui/*`
- `src/middleware/*`
- `src/ws-broadcast.ts`
- `src/pwa.ts`
- `README.md`
- `package.json`
- `RELEASE_CHECKLIST.md`
- `install.sh`
- `publish.sh`
