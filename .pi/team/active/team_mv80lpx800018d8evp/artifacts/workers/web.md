# Worker Gemini Web 入口移除 (web)

Status: succeeded
Model: openai-codex/gpt-5.5
Routing: policy=task_first; selected via metadata; thinking=high; captain remains final judge; metadata: openai-codex/gpt-5.3-codex-spark (warning: probe error: probe produced no output) | fallback: openai-codex/gpt-5.5 (warning: not probed (lazy fallback)) | fallback: openai-codex/gpt-5.6-luna (warning: not probed (lazy fallback))
Fallback models: openai-codex/gpt-5.5, openai-codex/gpt-5.6-luna
Tools: bash, edit, read, write
Requests: 24
Tokens: 1541913

## Output

RADIO: status=completed, action=Web Gemini 入口移除已收敛并验证到可报告状态, evidence=rg/git diff check/tsc, blocker=npm run check 被非 web storage TS 基线错误阻断, next=交由 captain 统一整合与测试同步

## result_summary

已在 `src/web-ui/` 源码内移除 Gemini 的 Web 选择入口与专属实现：工具列表、Logo、默认模型/模型目录映射、新会话 runner/权限摘要、任务/mission 指派入口、browser composer/session 映射、登录插画节点、PTY/structured runner 识别等。

复扫结果：`src/web-ui` 内 `gemini|google` 只剩 `provider-identity.ts` / settings 类型里的内部排除过滤字面量，用来阻止 Gemini 作为 active Web provider；没有剩余可选择入口。

## evidence_refs

- 修改核心：
  - `src/web-ui/provider-identity.ts`
  - `src/web-ui/react/provider-logo.tsx`
  - `src/web-ui/react/new-session/{repository.ts,host.tsx,permission-summary.ts}`
  - `src/web-ui/react/settings/{types.ts,tabs.tsx,repository.ts,model-groups-panel.tsx}`
  - `src/web-ui/react/model-catalog.ts`
  - `src/web-ui/browser/{session-engine.ts,new-session-adapter.ts,state.ts,login-visual.ts,pty-paste.ts,pty-system-info.ts,shell-commands.ts}`
  - `src/web-ui/react/issues/task-board-agent.ts`
  - `src/web-ui/react/missions/host.tsx`
  - `src/web-ui/react/workspaces/session-order.ts`
  - `src/web-ui/session-activity.ts`
- 验证：
  - `rg -i "gemini|google" src/web-ui ...`：仅剩内部排除过滤字面量。
  - `git diff --check -- src/web-ui`：通过。
  - `npx tsc --noEmit -p tsconfig.react.json` / `tsconfig.browser.json`：Web 相关 Gemini 类型错误已清掉；剩余失败在非本角色范围 `src/storage-*` / repository 类型错误。
  - `npm run check -- --pretty false`：失败，同样被非 Web storage TypeScript 基线错误阻断。

## disagreements

- 未改 tests（角色边界禁止），但以下测试需要同步预期：provider logo、settings repository/settings browser、new-session permission summary、config/preferences、模型目录/任务指派相关测试。
- `src/provider-catalog.ts` 仍在 Web 目录外导出 Gemini；本角色仅在 Web active provider 层过滤，后续需由对应角色移除全局 provider 真源。

## next_questions

- captain 需要决定：历史 Gemini 会话在 UI 中最终显示为“终端/未知”还是保留只读历史名称。
- captain 需要协调非 Web storage TypeScript 错误的 owner，否则全量 `npm run check` 仍无法通过。

## confidence

中高：Web 可选入口已移除并复扫；未能给出全量绿色检查，因为当前仓库存在非本范围 TypeScript 失败。

```json
{
  "result_summary": "已在 src/web-ui 源码内移除 Gemini 的 Web 选择入口、Logo、默认模型/目录映射、新会话 runner、权限摘要、任务/mission 指派入口及 browser session 映射；复扫仅剩内部排除过滤字面量。",
  "evidence_refs": [
    "src/web-ui/provider-identity.ts",
    "src/web-ui/react/provider-logo.tsx",
    "src/web-ui/react/new-session/repository.ts",
    "src/web-ui/react/new-session/host.tsx",
    "src/web-ui/react/new-session/permission-summary.ts",
    "src/web-ui/react/settings/types.ts",
    "src/web-ui/react/settings/tabs.tsx",
    "src/web-ui/react/settings/repository.ts",
    "src/web-ui/react/settings/model-groups-panel.tsx",
    "src/web-ui/react/model-catalog.ts",
    "src/web-ui/browser/session-engine.ts",
    "src/web-ui/browser/new-session-adapter.ts",
    "src/web-ui/browser/login-visual.ts",
    "src/web-ui/browser/pty-paste.ts",
    "src/web-ui/browser/pty-system-info.ts",
    "src/web-ui/browser/shell-commands.ts",
    "src/web-ui/session-activity.ts",
    "rg -i gemini|google src/web-ui: only internal exclusion filters remain",
    "git diff --check -- src/web-ui: passed",
    "npx tsc --noEmit -p tsconfig.react.json / tsconfig.browser.json: blocked only by non-Web storage errors after fixes"
  ],
  "confidence": "中高：Web 入口和专属映射已清理，验证受非本范围 TypeScript 基线错误阻断。",
  "disagreements": [
    "未改 tests，需由测试角色同步 provider logo、settings、新会话权限摘要、模型目录/任务指派预期。",
    "src/provider-catalog.ts 仍在 Web 边界外保留 Gemini，需要其他角色处理全局 provider 真源。"
  ],
  "next_questions": [
    "历史 Gemini 会话在 UI 中最终应显示为终端/未知，还是保留只读历史名称？",
    "非 Web storage TypeScript 错误由哪个角色修复以恢复全量 npm run check？"
  ]
}
```
