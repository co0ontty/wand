# Worker 流式边界独立复审 (protocol-retry)

Status: succeeded
Model: openai-codex/gpt-5.5
Routing: policy=task_first; selected via user; thinking=high; captain remains final judge; user: openai-codex/gpt-5.5 | fallback: anthropic/claude-fable-5 (warning: not probed (lazy fallback)) | fallback: anthropic/claude-fable-5-1 (warning: not probed (lazy fallback))
Fallback models: anthropic/claude-fable-5, anthropic/claude-fable-5-1
Tools: bash, read, write
Requests: 17
Tokens: 457159

## Output

RADIO: status=complete, action=完成只读复审, evidence=read/bash on target files, blocker=none, next=交由 captain 综合

## result_summary

未发现可复现的阻断级 SAX/投影/有界内存漏洞。当前实现与描述基本一致：16K 输入切片、raw SAX 验证、仅保留协议字段、`messages` 只保留 latest assistant、超大真实 payload fail-unknown/no-retry 路径在 pump 中接入。

## evidence_refs

- `src/pi-protocol-reader.ts:12-15,94-103`：16K 切片、256MiB envelope 计数。
- `src/pi-protocol-reader.ts:121-154`：key 长度、root 字段筛选、messages 单项投影、深度限制。
- `src/pi-protocol-reader.ts:160-187`：assistant/有效 payload 8MiB 失败、latest assistant、history 事件例外与最终 line 上限。
- `src/pi-event-projection.ts:3-24`：仅 `PI_PROTOCOL_FIELDS`，`agent_end` 投影到最后 assistant。
- `src/pi-native-event-bridge.ts:35-40,52-55`：native bridge 写入前投影；`agent_settled` 按 Pi 文档/fixture为无 payload 生命周期事件。
- `src/structured-exec-pump.ts:88,122-139,150-164` + `src/structured-pi-adapter.ts:297-298`：`PiProtocolReader` 接入实际 pump，协议错误变 `retryForbidden` + unknown delivery。
- `tests/pi-protocol-reader.test.ts:65-96,106-145`、`tests/pi-protocol-recovery.test.ts:51-80`：覆盖边界、malformed、recovery、native/file-capture replay。

## confidence

中高。只读审查了指定 reader/projection/tests，并额外最小查看 pump/adapter/native bridge 接入；未跑测试，未访问凭据/云模型。

## disagreements

- 无阻断性分歧。
- 小风险：`agent_settled` 在 native bridge 中未投影，但现有 Pi JSON 文档/fixture显示无额外字段；若上游未来扩展该事件，需要同步投影或加测试。

## next_questions

- 是否需要 captain/实现者补一个 `agent_settled` 带冗余字段时仍不写大历史的防未来回归测试？非当前阻断。

```json
{
  "result_summary": "未发现可复现的阻断级 SAX/投影/有界内存漏洞；实现与描述基本一致，协议错误接入 unknown/no-retry。",
  "evidence_refs": [
    "src/pi-protocol-reader.ts:12-15",
    "src/pi-protocol-reader.ts:94-103",
    "src/pi-protocol-reader.ts:121-154",
    "src/pi-protocol-reader.ts:160-187",
    "src/pi-event-projection.ts:3-24",
    "src/pi-native-event-bridge.ts:35-40",
    "src/structured-exec-pump.ts:88,122-139,150-164",
    "src/structured-pi-adapter.ts:297-298",
    "tests/pi-protocol-reader.test.ts:65-96,106-145",
    "tests/pi-protocol-recovery.test.ts:51-80"
  ],
  "confidence": "中高；只读检查，未跑测试。",
  "disagreements": [
    "无阻断性分歧；agent_settled 未投影但当前证据显示无 payload，属于防未来扩展风险。"
  ],
  "next_questions": [
    "是否补 agent_settled 携带冗余字段的防回归测试。"
  ]
}
```
