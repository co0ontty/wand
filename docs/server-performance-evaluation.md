# 服务端性能评估（P3）

最后更新：2026-07-14（Asia/Shanghai）

## 结论

本轮不把 `WandStorage` 迁入 worker thread。P1-2 已将热路径改成每会话固定 1 秒窗口的定向 `UPDATE`，当前同步 SQLite 写入不再与 token/chunk 数量线性增长；实测写入耗时远低于 worker 消息传递、状态复制和生命周期协调所增加的复杂度。

保留同步 SQLite 的前提是继续遵守：流式回调只标记 dirty，不在每个 token/chunk 上直接写 DB；terminal/dispose 路径执行最终 authoritative flush。

## 量化结果

测试环境：macOS、Node 23.10.0 的 `node:sqlite`，临时本地数据库。数据用于判断数量级，不作为跨机器 SLA。

| 场景 | 结果 |
| --- | ---: |
| 1,000 次 `checkpointSessionOutput`，每次 200,000 字符 | 41.32 ms，总计；0.0413 ms/次 |
| 100 次 `checkpointSessionMessages`，每次 10,000 blocks | 50.32 ms，总计；0.503 ms/次 |
| 10,000 blocks + 5 MiB output 转 DTO、窗口化、序列化 | 约 4.9 ms |
| 同一长会话广播给 3 个慢 WS 客户端（各 200-block 窗口） | 约 4.3 ms |

长会话自动化回归位于 `tests/long-session-transport.test.ts`；定向 checkpoint 次数和最终落盘正确性位于 `tests/session-persistence.test.ts`。

## 已采用的替代优化

- Session output/messages 使用独立定向 `UPDATE`，持续流式事件合并到固定 1 秒 checkpoint window。
- provider history 扫描移入 `ProviderHistoryScanner`，以 `(path, mtime, size)` 增量复用 JSONL 摘要；同一启动恢复多个 Codex 会话只建立一次初始索引。
- Session wire DTO 使用显式字段白名单；列表不带 transcript/messages。
- HTTP/WS 详情只发送消息窗口；output 最多发送最近 200,000 字符，并附 `outputOffset`、`outputTotal`、`outputTruncated`。
- 每个慢 WS 客户端维持独立有界队列和 block budget，高水位丢弃后发送 `resync_required`。

## 重新评估 worker 的触发条件

满足任一项时再引入 worker，并先做可取消/可关闭的原型：

- 生产 profiling 显示同步 SQLite 单次 p95 持续超过 10 ms。
- 活跃会话数量使 1 秒 checkpoint 批次连续占用事件循环超过 25 ms。
- 数据库位于明显高延迟文件系统，且 WAL/定向 UPDATE 仍不能控制尾延迟。
- 新功能重新引入大范围事务或全表 JSON 重写。

若触发，worker 必须提供 request ID、按 session 的写入顺序、terminal flush barrier、close/drain 协议和错误回传；不能只把 `DatabaseSync` 包一层 fire-and-forget `postMessage`。
