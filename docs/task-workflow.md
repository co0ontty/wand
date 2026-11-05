# Task workflow: autonomous delivery and independent review

Implementation contract for the approved full task-panel design (`scripts/design-previews/taskboard-dashboard/README.md`). The 2026-11-05 user decision supersedes the old idle reclamation and mandatory human-finalization policy. Runtime verification evidence belongs to the task board; this document is the protocol contract.

## Shared DTO

- Active stages, ordered: `backlog` 待立项, `todo` 等待认领, `doing` 执行中, `review` 待验收（AI）, `ready` 历史待人工确认（兼容旧记录）. `archived` is a separate collection.
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
- `progress`: doing → doing. Records progress/repair gaps without advancing deliveryRevision, clearing the failed-review marker or ending responsibility. It does not pause automatic continuation.
- `block`: doing/review → same stage. Explicit external impediment only; requires evidence of attempted remedies and the minimum missing condition. Stores `acceptance.blockerKind="external"`; automation waits until explicitly cleared. Environment/permission failure is not a failed functional review.
- `submit`: doing → review. Requires evidence and no blockers; employee submissions also require a nonempty `selfTest: [{criterion, evidence}]` list covering the complete goal. A field check does not prove correctness; independent review must verify the actual evidence. The enabled scheduler automatically dispatches review after the current execution settles.
- `pass`: review → archived. Requires evidence, no blockers, current delivery and all children delivered. Employee reviewers must have an explicit review dispatch for this version and must not be the submitter. Parent review records approval and completion for delivered non-archived children atomically, preserving already archived child history. Records AI verification, NOT human acceptance, and does not enroll these archives in automatic deletion.
- `fail`: review → doing. Requires a blocker, preserving evidence and an auditable result (functional gaps use this path; external inability to verify uses block without restarting implementation).
- `return`: ready → doing. Requires human rejection reason; clears current AI/human approval while keeping history.
- `accept`: ready → archived. Explicit **确认并归档**, human-only, records acceptance with confirmedRevision and archives atomically. Requires current AI approval for the parent and children, and no active/pending execution. Parent acceptance archives approved children atomically.

Every client must keep the clicked snapshot, retain the same requestId when checking/retrying an unknown receipt, retain drafts on rejection/conflict, refresh instead of replaying a stale intent. UUID is fine for requestId. This action cannot be mixed with arbitrary task patches. Response is the normal fresh task DTO. Enabled automation dispatches eligible doing/review work through the existing employee queue, preserving explicit model choices and permission boundaries. No production simulation buttons.

Direct PATCH remains for draft evidence/metadata, backlog/todo/doing planning changes and user-initiated archive. Direct ready, new done and acceptance.acceptedAt must not bypass the workflow. Archiving (board drag to the archive target, detail/context-menu “归档”) is a direct user action from any active stage after one confirmation dialog: it requires no AI or human acceptance, never writes acceptance, and is blocked only by running/approval/queued/team work (`canArchiveTask`); archived-without-acceptance stays a historical archive, not a completion. Automatic retention archiving keeps its stricter accepted-only rule. Existing archive/restore/history APIs preserve data. Creating a task only permits planning stages, not pretending it already passed. An explicitly deleted project may collect unaccepted task history through the separately named storage removal operation; it records a project-removal comment and never writes human acceptance or counts that collection as completion.

## Automatic closure and continuing ownership

Creating a backlog/todo requirement does not start work. Moving it into doing starts automatic scheduling; entering doing preserves existing running/queued work instead of stopping and recreating it. New tasks without an explicit executor use the configured implementation employee. Existing work uses the latest implementation dispatch's employee and tool snapshot; a review never overwrites implementation ownership. Explicit team/direct-tool assignments are not silently converted to another employee.

Self-test failures stay with the implementer: diagnose, repair and retest all criteria before submitting. Independent functional failures return to doing and the same implementation owner. Ordinary progress preserves failed-review context. There is no fixed retry count that abandons the task; known terminal launch/execution failures have exponential backoff up to 30 minutes. A completed turn without delivery gets a continuation instruction, not replay of prior side effects. Queued/pending/unknown deliveries, running/approval states, cancellations, active teams and descendants prevent conflicting dispatch. Source and execution task ownership are both checked. Persisted request IDs and expectedUpdatedAt provide restart idempotence.

Events wake the scheduler after status changes and execution completion. A ten-second reconciliation observes workflow writes from the separate CLI database connection; the configured interval provides an idle fallback. Automatic scans cover review then doing, at most three dispatches per stage. Todo is only processed by an explicit manual scan or explicit employee assignment. Parents wait for active children; independently completed children allow the parent to continue integration and overall review.

Business stage is independent of runtime activity. The retention sweep must never return idle doing tasks to todo. This supersedes the old TASK-372 reclamation requirement; do not restore it as a regression repair. New requirements supersede obsolete acceptance criteria; compare the current task, parent and comments before implementation/review. Do not batch-rewrite historical states based on guesses.

An external block preserves ownership and stage. Clear it explicitly after supplying the missing condition (or issue a new authorized instruction); ordinary repair difficulty, self-test failure and turn completion are not external blockers. Historic untyped blocker text receives a diagnostic continuation rather than being silently treated as authorization or permanent abandonment. The action inbox only requests human help for explicit external blockers and live permission/question requests.

Independent approval automatically archives the task without recording a human actor or acceptedAt. `taskCompleted` recognizes that approval at the current revision; plain historical archives still do not count. Legacy ready/accept/return remain available for old clients and records, but new pass receipts do not require another human confirmation. Auto-completed archives retain their history and are excluded from automatic deletion.

## Cancel unnecessary work without accepting delivery

`POST /api/wand-tasks/:id/maintenance` and owner CLI `wand task:maintain <task-id> --stdin`
provide explicit user-requested maintenance, separate from the acceptance workflow. They do not
grant an employee workflow capability or imply permission to cancel other tasks.

```json
{
  "action": "close",
  "kind": "duplicate",
  "duplicateTaskId": "the-retained-task-id",
  "requestId": "one-stable-id-for-this-intent",
  "expectedUpdatedAt": "the-reviewed-task.updatedAt",
  "expectedQueuedCommentIds": ["the-reviewed-queued-or-paused-comment-id"],
  "reason": "why this work is obsolete or covered by the retained task"
}
```

Use `kind: "obsolete"` without `duplicateTaskId` for retired work. To cancel only one
unclaimed dispatch while preserving the task, use `action: "cancel"`, `commentId`,
`requestId`, `expectedUpdatedAt` and `reason`; omit the closure fields.

The transaction checks the task version, exact queued/paused instruction set, live sessions,
teams, pending/unknown dispatches, and open children before closing. A claimed dispatch cannot
be recalled. New queue instructions or changed task content cause a conflict, not an automatic
retry. Retried identical request IDs return current facts without cancelling later instructions.
Cancellation retains the original comment, request identity, sessions and workflow history.
The existing wire representation is `state: "failed"` (not delivered), `status: "stopped"`,
with an explicit user-cancellation reason; Web/macOS/iOS/Android already render these values.
It never fabricates a runtime result, AI pass or human acceptance. Closure audit comments name
the reason and retained task. Such archives stay outside automatic deletion eligibility.

## UI

Follow the approved HTML with real data and existing components: completion + factual summary, five clickable metrics, user-confirmation queue before project analysis, AI-review queue, execution/repair, priority, completion trend, upcoming due dates and owner delivery counts. Board/list/gantt/filter/child summaries share the same five stages. A passed AI review never increases human completion. Do not invent missing Gantt start dates (there is no server start-date field yet; show real due-date milestones / unscheduled tasks instead).

Keep existing task creation, drafts, selection, comment dispatch, permissions, live execution ownership and theme/motion behavior. Detail edits use the existing owner. Restore legacy records without claiming new acceptance. Native implementations may use platform-native layouts but must support the same stages, safe actions and honest completion semantics.

## Explicit AI-review dispatch

When the task is in `review`, selecting an employee in the comment composer sends structured `purpose: "review"`. The persisted comment records the purpose and delivery revision; the queue preserves the review phase and rejects a late queued review of a different delivery. Ordinary comments remain ordinary comments, and normal execution does not acquire review intent by matching its text. Receipt retries retain the original purpose. Clients check review-protocol support before a review dispatch; unsupported peers keep the draft/request identity and never fall back to ordinary execution. This check must not gate on the current phase: the server must replay an already accepted request before validating a new request's phase. Compatibility execution remains explicitly ordinary execution, separate from review comments. A frozen review without a matching durable pass/fail event is shown as “验收结论待回填”, not as an accepted task.

## AI write-back

A separate session-scoped runtime capability supports only `progress/submit/pass/fail` on the exact bound task through `wand task:workflow <task-id> --stdin`; human accept/return are never granted to employees. Capabilities are ephemeral, revoked on execution completion/interrupt, validated against persisted task/session/employee binding and delivery revision. Never put credentials in prompts, task DTOs, persisted reports or logs. Owner CLI authentication is not an employee authorization boundary. Workflow history and request receipts remain auditable without credentials.

## Comment execution ownership (protocol v2)

An employee implementation comment on a root requirement atomically creates a direct child and persists `executionTaskId`; the visible instruction remains on the parent. A reply or an explicit child reference continues that child. Request replay returns the same comment/child. Review dispatch keeps its existing review intent and does not create an implementation child.

Parent comment pagination includes direct-child records without copying them. `taskId` remains the real record owner; `activityTaskId` identifies the reading surface. Agents receive both actual execution task ID and parent context ID, read `task:context` / cursor-paginated `task:comments`, and use their exact-task capability to record progress. Session termination alone never means delivered. All children must submit evidence without blockers before parent submission; unresolved or pending/unknown delivery blocks aggregate acceptance.
