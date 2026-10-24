# Wand 文档索引

根 [README](../README.md) 是安装与使用入口，[AGENTS.md](../AGENTS.md) 是项目规则真源，[DESIGN.md](../DESIGN.md) 与 [PRODUCT.md](../PRODUCT.md) 分别记录视觉与产品上下文。本页按主题索引 `docs/`；标注「提案」或「历史」的文档不属于当前实现合同。

## 使用与协作

- [招聘与入职](employee-onboarding.md)：手动创建员工、HR 起草与确认边界。

## 会话与执行

- [tmux 执行与恢复](tmux-execution.md)：CLI 所有权、执行切换与安全重启。
- [新建会话契约](session-creation.md)：`POST /api/sessions` 的 `kind`、回执与错误语义。
- [删除会话时清理 CLI 文件](cli-session-cleanup.md)：按 provider 原生 session ID 清理的范围。
- [Claude Code 后台生命周期](claude-background-lifecycle.md)：后台 agent 未结束时不得判定完成。
- [Pi CLI 与 Wand SDK 的加载边界](pi-sdk-dependencies.md)：资源发现、隔离与受限设置。
- [Pi CLI 大结果与解析断点](pi-cli-protocol.md)：流式解析、展示预算与恢复边界。
- [Wand 系统操作 skill](system-skills.md)：`wand-system` 的安装、能力与送达限制。
- [CLI / skill 一次性网页登录](web-login-tickets.md)：短时票据、生命周期与保密边界。

## 定时任务

- [定时任务](scheduled-tasks.md)：单次、每日、每周与小时间隔计划的调度、补跑和接口。

## 客户端与 Web

- [Web 精确定位链接](web-page-links.md)：地址契约、分享与失败行为。
- [iOS APNs 远程提醒](ios-apns.md)：部署条件、订阅边界与投递限制。
- [本地模型管理](local-model-setup.md)：LAYA 与石一的安装、校验和故障边界。
- [加密错误日志接口](feedback.md)：上报链路、隐私边界与任务归并。

## 更新、构建与运维

- [Web 服务更新与一次性恢复](web-updates.md)：渠道选择、执行流程与恢复入口。
- [Web bundle 构建与体积](web-bundle-build.md)：构建入口、模块寻址与预算口径。
- [构建缓存自动清理](build-cache-cleanup.md)：本机 DerivedData 的七天闲置清理。
- [运行存储自动维护](storage-cleanup.md)：临时文件、上传、日志、分发包与迁移快照的保留规则。
- [本机原生开发环境外置](native-build-storage.md)：外盘构建目录、工具链与校验边界。
- [CI performance](ci-performance.md)：CI/发布必须保留的保证与缓存范围。
- [测试策略](testing-policy.md)：分层入口与「测试服务于需求」的取舍。

## 提案与历史记录

- [Web 更新事务设计提案](web-update-transaction-design.md)：尚未实现的事务式更新合同；当前行为见 `web-updates.md`。
- [React Generative UI 可行性研究](research/generative-ui-feasibility.md)：历史研究，未进入当前实现范围。
- [本机运行产物清理记录](local-runtime-artifact-retention.md)：2026-10-18 的一次性清理记录；当前规则见 `storage-cleanup.md`。

架构逐轮工作记录保存在本机忽略目录 `output/architecture-stage2/`，入口为 `WORKLOG.md`，详见根 `AGENTS.md`。
