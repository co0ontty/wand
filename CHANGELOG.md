# 更新日志

## v1.2.3 (2026-04-05)

### Bug 修复

- **权限检测逻辑放宽**：改进 Claude PTY 权限提示检测，从严格的三条件全满足改为任意两条件组合即可匹配，修复部分权限提示无法被正确识别的问题
- **自动确认匹配优化**：放宽 `process-manager` 中自动确认的匹配条件，确保更多合法的权限提示能被自动处理
- **Claude 命令识别扩展**：`shouldAutoApprovePermissions` 和 `processCommandForMode` 现在支持 `npx claude` 和绝对路径形式的 claude 命令，不再仅匹配 `claude` 前缀
- **会话删除清理增强**：删除会话时同时清理 `~/.claude/` 下的 `session-env`、`tasks`、`todos` 关联目录，避免残留文件堆积
