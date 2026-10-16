# 操作契约

以下 HELPER 表示 `node <此技能绝对路径>/scripts/wand.mjs`，不是字面命令。
所有输出是 JSON，失败退出非零；所有写入用 `--stdin` 输入 JSON 对象，不把用户文字拼成可执行 shell。
替换示例 ID、日期与检查内容；示例本身不是执行授权。

## 查询与选择

| 命令 | 返回 / 语义 |
| --- | --- |
| HELPER employee:list | {employees:[…]}，默认不含归档员工；按 id/name/duty/agents 选适合员工，不读取知识 |
| HELPER employee:list --include-archived | 含归档定义，归档员工不能创建执行 |
| HELPER workspace:list | 工作区数组；核对 id/name/cwd，不使用猜测目录 |
| HELPER session:current | 当前执行环境绑定的 {sessionId}，非凭据；未绑定会报错 |
| HELPER session:list | 会话列表，可能含其他任务，只定位已授权目标 |
| HELPER session:read <wand-session-id> | 指定会话详情/消息，核对 sessionKind/employeeId/cwd/status/structuredState/queuedMessages |
| HELPER session:wait <id> --timeout 900 | 有界等待；不将空闲等同业务成功，仍需核对最后一轮结果 |
| HELPER schedule:list | {tasks:[…]}，不含已取消 |
| HELPER schedule:list --include-cancelled | 包含取消记录 |
| HELPER schedule:read <id> | {task,runs}，最近50条执行含 sessionId、接收及实际执行状态 |

## 创建员工会话

```sh
HELPER session:create --stdin <<'JSON'
{"employeeId":"e_实际员工ID","workspaceId":"实际项目ID","cwd":"/实际项目绝对目录","prompt":"已获授权的明确任务"}
JSON
```

返回会话快照，记录 id。使用员工保存的角色、候选、引擎与权限；不能通过此命令覆盖模型或 mode。
省略 prompt 只创建空白会话，不启动业务；有 prompt 则立即接受执行，不等待整轮结束。
cwd 与 workspaceId 应来自同一真实工作区；省略 cwd 时会使用服务默认目录，不要误以为 workspaceId 自动切目录。
创建会话接口不承诺幂等；未知送达先查列表/历史，不直接重建。

## 续接指定结构化历史会话

```sh
HELPER session:resume 原Wand会话ID --stdin <<'JSON'
{"input":"两小时复查证据：<具体结果>。仍不符合<标准>，请沿用本会话已有历史继续处理<已授权范围>。"}
JSON
```

不是 PTY resume，也不创建另一个新会话。命令先回读目标，只接受精确 ID 的结构化会话；
目标运行中、等待审批或有排队消息时拒绝，不停止、不插队。已归档的空闲结构化会话先取消归档，再经原输入入口继续。
沿用原身份、历史与 provider 恢复机制；历史文件缺失等错误可能在启动后出现，响应仅证明接受，回读核对。
没有跨请求事务/永久幂等保证，不用此命令做并发锁；已接受、超时或结果未知后不盲目重复。

## 创建定时任务

```sh
HELPER schedule:create --stdin <<'JSON'
{
  "requestId":"check-20300101-100000-a1",
  "title":"两小时后复查异常",
  "employeeId":"e_实际检查员工ID",
  "workspaceId":"实际项目ID",
  "prompt":"完整复查步骤、正常标准、固定原会话ID、正常/异常/未知分支与授权范围",
  "schedule":{"kind":"once","runAt":"2030-01-01T18:00:00+08:00"}
}
JSON
```

requestId 必须为8–80位 ASCII 字母/数字/下划线/冒号/连字符；每项新计划使用唯一标识（可用 UUID），相同请求保留原值。
runAt 必须在未来并带明确时区。两小时后用当前时间加 2*60*60*1000 算出真实 ISO，不照抄示例。
返回 {task}，记录 task.id、revision、nextRunAt；回读 schedule:read 核实。
同一 requestId + 原始内容幂等；同 ID 换内容会409。若响应丢失，按同 requestId 推导/查询原任务而不是换 ID。
任务ID推导：`sched_` + SHA-256(requestId) 的前32位十六进制。可用本机 Node crypto 计算后 schedule:read 核对原始字段。
requestId 并非认证凭据，但不要把用户隐私塞进标识。

重复计划：
- 每天：`{"kind":"daily","time":"09:00","timeZone":"Asia/Shanghai"}`
- 每周：`{"kind":"weekly","time":"09:00","timeZone":"Asia/Shanghai","weekday":1}`（0周日…6周六）
- 用户只要求一次检查时绝不能擅自改成每天/每周。

绑定 workspaceId 后每次在该项目当时的目录执行，不可用就失败，不退到其他目录。
未绑定项目则使用服务默认目录，交付须说明。到点新建检查员工执行会话，原会话仅在满足条件时由检查员工续接。
关闭浏览器不影响调度；主机/服务必须运行，默认约15秒检查一次，不能承诺准确到秒。
服务恢复时过期单次任务补跑一次；同计划未结束不并发重跑；未知接收不自动重发。

## 更新、暂停、恢复、取消计划

先 schedule:read 获取当前 revision，不能覆盖别人更新。

```sh
HELPER schedule:update 实际计划ID --stdin <<'JSON'
{"revision":1,"enabled":false}
JSON
```

- 恢复：`{"revision":2,"enabled":true}`。已过期单次需同时提供新的未来 schedule。
- 改时间/员工/提示词/项目：revision 加对应字段；其他字段保留。
- 取消：`{"revision":3,"cancelled":true}`；只在用户要求取消时执行。
- 409先重新读取，不盲目覆盖；取消后不能恢复，历史保留。
- 暂停/取消只阻止未来调度，不中断已开始的检查或原会话。

## 无法执行时

不读管理员密码、不改员工配置、不换引擎、不改系统定时器、不自动重启 Wand。
提示 skill 未安装时由已授权的本机 CLI 执行 `wand system:skills`；安装只增加发现入口，不改变任何会话的工具开关或 Skills 白名单。
新会话/资源刷新后可发现；被显式限定资源的会话需用户在原设置里选择该技能，不能绕过选择。
