# Qoder ACP 运行中输入

Qoder 默认使用 `qoder-cli-acp`，由既有 StructuredExecHost 持有独立 worker。旧 print 在途回合继续用旧解码器恢复，结束后才升级 ACP；不重放原 prompt。

## 输入和完成语义

- worker 从真实 ACP `initialize` 协商 `_meta.qoder.promptQueueing === true`，支持时才发出输入边界、将 `inputMode` 投影为 `steer`。没有该能力仍可在整轮结束后自动发送。
- 用户补充消息经原有会话队列 owner 持久预约，再经控制 socket 写入同一原生会话的 `session/prompt`。普通任务来源的队列项留待回合结束，按既有调度自动发送；明确提升队列项可走同一插话入口。
- 该能力是在执行安全边界追加，不中断当前工具，也不承诺立即生效。**worker 的 committed 只表示写入原生通道，不是模型已采用内容的确认。**
- Qoder 1.1.81 的历史真实探测出现过同轮采用插话、却没有插话请求独立响应的行为。因此以原始 prompt 的响应结束该回合，不等待每个插话 ID 的响应，不把主请求响应当作逐条插话确认，不因缺少确认自动重放。主回合结束前到达的插话错误仍保持失败。
- 同一 handoff ID 的已提交记录可回读；pending、冲突或损坏记录不授权重复发送。写入失败保留未知，不能伪造接纳。

## 恢复与送达边界

恢复保留原 activeRequestId，先完成 daemon 清单核对、日志回放和 attach/adopt，再分发补充消息；等待期间消息留在原队列。恢复后自动发送一次，不重新启动原回合。

socket connect 前失败意味着没有写出命令，明确拒收并保留队列供下一回合。connect 后断连、回执解析失败等属于未知送达，不自动重发；原文留作核对。权限裁决和原生表单复用同一控制通道，卡片在 worker 确认后收敛。

## 本轮验证范围（TASK-392）

主仓 `npm run check`、`npm run build` 通过。对主仓及已安装模块执行有界自测，覆盖：

- 连续插话无独立响应，主回合正常结束；工具 use/result 各一次且没有取消；
- 重复、pending 和损坏回执不导致重发；显式原生拒绝保持失败；
- 两条任务输入在回合结束后各一次按序发送；
- 恢复清单暂不可用、attach 在途不抢发，领养后按序发送；
- 连接前失败保留队列，连接后丢回执不自动重发；
- 缺少 promptQueueing 时不宣称支持插话，回合结束后自动发送；
- 旧 print 日志恢复后再升级 ACP；
- 固定真实 Structured Render 与两个独立 Node 观察进程接管同一个 worker、原生会话和请求，离线输出回放、审批和问答继续，原始 prompt/插话各一次。

证据在 `output/task-392-steering-20261103/`：验证脚本、主仓/安装包自测日志、真实 Render 记录、构建日志、部署日志及 `installed-audit.json`（服务 API 返回和关键模块 SHA256）。模拟 ACP 对端不调用模型，不能替代真实 Qoder 同回合采用内容的验收。

Web、macOS、iOS、Android 已有 runner 与 inputMode 投影源码契约分别核对；本轮没有原生源码改动，没有把源码核对说成原生视觉/触控通过。没有调用真实付费模型。后续真实 Qoder 样本须单独取得授权，验证插话采用与主回合完成竞态、断连重启及未知送达；本轮自测不等于独立 AI 验收。
