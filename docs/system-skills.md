# Wand 系统操作 skill

`wand-system` 让已有命令执行权限的会话调用 Wand 本机功能，而不需要在聊天中取出管理员密码。

## 安装与发现

```sh
wand system:skills
# 可选：只安装指定 CLI 的发现入口
wand system:skills --providers pi,claude
```

管理源位于配置目录的 `skills/wand-system/`，各 CLI 的用户技能位置共享链接。
安装保留同名外来技能与用户改动；不会修改 provider 设置、工具权限或会话的 Skills 白名单。
新建会话/刷新资源后发现技能，显式限制资源的会话仍须按原方式选择它。
npm 包包含技能源和脚本，升级后再次运行命令更新，不覆盖用户自定义版本。

安装时 `.runtime.json` 只记录本机 Node、CLI 和配置路径，不存密码/token。
helper 固定这些路径，不允许传 `-c/--config` 覆盖。它复用本地 CLI 所有者认证，**不是会话级最小权限 API token**。
只有被允许执行命令、且获用户授权操作本机 Wand 的会话才能使用；技能本身不是提权或系统控制授权。

## 已支持

- `employee:list`：员工定义列表（不读取独立知识库）。
- `workspace:list`：工作区与目录。
- `session:create --stdin`：指定员工、项目及输入创建结构化会话，沿用员工配置。
- `session:resume <Wand ID> --stdin`：精确续接原结构化会话，沿用历史和身份；有执行/审批/队列时拒绝，不停止或插队。
- `schedule:list/read/create/update`：单次/每日/每周、查询执行记录、修改、暂停、恢复与取消。
- 原有 `session:list/read/wait` 同样可从 helper 使用。
- helper 的 `session:current` 读取运行时绑定的非秘密会话 ID。新版 structured runner 为每次执行覆盖绑定，避免嵌套执行沿用父 ID；旧的在途执行不会凭空获得新上下文。

详见 [技能说明](../skills/wand-system/SKILL.md) 与 [命令/JSON 契约](../skills/wand-system/references/operations.md)。
上述新 CLI 命令也可直接调用，支持原有 `-c/--config` 选择本机配置。

## 延迟复查与条件续接

“2小时后检查是否正常，不正常恢复现在这个会话”按以下步骤执行：

1. 从当前运行环境/可信当前上下文取得原 Wand ID，核对原会话和工作区。
2. 定义可执行的客观检查与正常标准；缺必要信息再询问。
3. 查询员工，按职责、工具权限、既定候选与费用约束选择检查者。
4. 创建带稳定 requestId 的一次性计划，runAt = 当前时间 + 2小时；完整 prompt 固定原 ID/检查/分支/授权范围。
5. 检查正常则结束；明确异常且原会话空闲才续接一次，附检查证据。
6. 无法判断、权限不足、原会话忙或送达未知则报告阻塞，不循环唤起。

服务端复用已有 ScheduledTaskService、ConversationService 和 structured 输入所有者，不另建计时器、执行引擎、权限系统或历史副本。
定时任务到点启动一个检查会话；**条件判断由检查员工按明确步骤执行，不是服务端条件表达式或自动 on-failure 回调**。
检查员工本身未启动/崩溃时只有失败记录，不能承诺必定补偿唤起。需要严格的服务端失败补偿时须另行实现持久工作流，而不能靠 prompt 假装具备此保证。

## 送达与限制

- 创建计划用 requestId 幂等，编辑用 revision；创建成功/accepted 不等于检查通过。
- 会话创建/续接无跨请求永久幂等或事务；响应未知先回读，不重发。
- 续接空闲已归档 structured 会话先取消归档，再走原输入入口；中途失败时回读。
- 不支持在此入口恢复 PTY、已删除会话或脱离 Wand 管理的原生历史，不替换成新建会话冒充。
- 主机/Wand 必须运行，调度精度与恢复规则见 [定时任务](scheduled-tasks.md)。本 skill 不会自行重启服务。
- 本轮是 Server/CLI/skill 能力，无客户端界面改动；Web/Mac 与 Android/iOS 均使用同一服务端能力，无单端新交互。
