# Claude Code structured background lifecycle

`ClaudeCliRunner` starts `claude -p --output-format stream-json`. A parent's final
reply or a `result` frame is not the process's completion: Claude may still own
background agents and invoke the parent again on their completion notifications.
Wand retains `status=running` and `structuredState.inFlight=true` until the CLI
execution settles. All four clients consume that shared state; they must not
infer completion from assistant prose.

## Background wait deadline

Claude Code 2.1.296 defaults to stopping background work ten minutes after the
parent's last turn, including children that are still progressing, then exiting
with code 0 and `result.is_error=false`. Wand sets
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` **only for its structured Claude child**
to disable that independent parent-idle deadline. It does not change the service
process environment, other providers, PTY sessions, tools, models, or permission
policy. Explicit user stop and Wand's execution cancellation remain available.
Long-running background work may therefore continue beyond ten minutes until it
finishes or is explicitly stopped; this is not authorization for new model calls
outside the user's task.

The reducer also checks native `result.subagent_stats.killed.system` facts. A
positive integer marks the turn incomplete even if Claude labels it successful.
Earlier content is preserved and the session receives a failure explanation.
This is **not** an upstream input rejection and does not authorize automatic
fallback or replay. Prose, stderr keywords, and user/parent cancellation counts
are not substitutes for the native system-kill fact. Qoder's independent
notification contract is unchanged.

## Verification

`tests/claude-background-wait.test.ts` drives the production runner and session
manager with an isolated controllable exec host. It covers environment scoping,
multiple parent results while children run, actual process completion,
system-killed children with exit 0, and explicit stop. It invokes no real model.

Already-stopped sessions are not rewritten as running or automatically resumed:
check their existing work and obtain continuation authorization first.
