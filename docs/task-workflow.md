# Task workflow: two-level acceptance

Implementation contract for the approved full task-panel design (`scripts/design-previews/taskboard-dashboard/README.md`). This file describes the target protocol; verification evidence is recorded in TASK-76, not implied by this document.

## Shared DTO

- Active stages, ordered: `backlog` 待立项, `todo` 等待认领, `doing` 执行中, `review` 待验收（AI）, `ready` 待归档（AI 已通过，等待人工确认）. `archived` is a separate collection.
- `done` is a legacy stored value only, NOT proof of AI approval. HTTP DTOs project legacy done to `review`, with `legacyReview: true`; reads never rewrite the database.
- HTTP task DTOs advertise `workflowVersion: 1`. Updated clients require this marker and the matching task ID in a workflow response, instead of treating an older server's ignored PATCH as a successful receipt.
- Add optional `deliveryRevision: number` (default 0) and `verification: { verdict: "passed" | "failed" | "unverified", evidence: string, blocker: string, reviewedAt: string, revision: number, sourceSessionId: string | null, reviewerId: string | null } | null`.
- Existing `acceptance: { evidence, blocker, acceptedAt }` stays readable, adding optional `confirmedRevision: number`. A trustworthy new human acceptance requires `acceptedAt != null` AND `confirmedRevision === deliveryRevision`. Older records are preserved and marked historical/unconfirmed, not automatically accepted or AI-passed. Old archives stay in the archive collection; their historical acceptedAt alone is not promoted to a new actor-attributed confirmation, so completion metrics can decrease until records are explicitly checked.
- AI verification is current only when `verification.revision === deliveryRevision` and verdict is passed. Changing scope/delivery or returning work invalidates current approval; past results stay in workflow event history.

## Mutation

Use existing `PATCH /api/wand-tasks/:id` with **only** this body:

```json
{
  "workflow": {
    "action": "submit",
    "requestId": "a-stable-uuid-created-once-per-user-intent",
    "expectedUpdatedAt": "the-clicked-task.updatedAt",
    "evidence": "delivery/report/actual verification evidence",
    "blocker": ""
  }
}
```

Actions:
- `submit`: doing → review. Requires evidence and no blockers. Does NOT launch a model.
- `pass`: review → ready. Requires evidence, no blockers, current delivery and child AI checks. Records AI verification, NOT human acceptance.
- `fail`: review → doing. Requires a blocker, preserving evidence and an auditable result (unable-to-verify uses this path with an explicit reason).
- `return`: ready → doing. Requires human rejection reason; clears current AI/human approval while keeping history.
- `accept`: ready → archived. Explicit **确认并归档**, human-only, records acceptance with confirmedRevision and archives atomically. Requires current AI approval, accepted children and no active/pending execution.

Every client must keep the clicked snapshot, retain the same requestId when checking/retrying an unknown receipt, retain drafts on rejection/conflict, refresh instead of replaying a stale intent. UUID is fine for requestId. This action cannot be mixed with arbitrary task patches. Response is the normal fresh task DTO. No automatic model dispatch, no production simulation buttons.

Direct PATCH remains for draft evidence/metadata and backlog/todo/doing planning changes. Direct ready, new done, acceptance.acceptedAt and archive shortcuts must not bypass the workflow. Existing archive/restore/history APIs remain conservative and preserve data. Creating a task only permits planning stages, not pretending it already passed. An explicitly deleted project may collect unaccepted task history through the separately named storage removal operation; it records a project-removal comment and never writes human acceptance or counts that collection as completion.

## UI

Follow the approved HTML with real data and existing components: completion + factual summary, five clickable metrics, user-confirmation queue before project analysis, AI-review queue, execution/repair, priority, completion trend, upcoming due dates and owner delivery counts. Board/list/gantt/filter/child summaries share the same five stages. A passed AI review never increases human completion. Do not invent missing Gantt start dates (there is no server start-date field yet; show real due-date milestones / unscheduled tasks instead).

Keep existing task creation, drafts, selection, comment dispatch, permissions, live execution ownership and theme/motion behavior. Detail edits use the existing owner. Restore legacy records without claiming new acceptance. Native implementations may use platform-native layouts but must support the same stages, safe actions and honest completion semantics.

## Explicit AI-review dispatch

When the task is in `review`, selecting an employee in the comment composer sends structured `purpose: "review"`. The persisted comment records the purpose and delivery revision; the queue preserves the review phase and rejects a late queued review of a different delivery. Ordinary comments remain ordinary comments, and normal execution does not acquire review intent by matching its text. Receipt retries retain the original purpose. Clients check review-protocol support before a review dispatch; unsupported peers keep the draft/request identity and never fall back to ordinary execution. This check must not gate on the current phase: the server must replay an already accepted request before validating a new request's phase. Compatibility execution remains explicitly ordinary execution, separate from review comments. A frozen review without a matching durable pass/fail event is shown as “验收结论待回填”, not as an accepted task.

## AI write-back

A separate session-scoped runtime capability supports only `submit/pass/fail` on the exact bound task through `wand task:workflow <task-id> --stdin`; human accept/return are never granted to employees. Capabilities are ephemeral, revoked on execution completion/interrupt, validated against persisted task/session/employee binding and delivery revision. Never put credentials in prompts, task DTOs, persisted reports or logs. Owner CLI authentication is not an employee authorization boundary. Workflow history and request receipts remain auditable without credentials.
