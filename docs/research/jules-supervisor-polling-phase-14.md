# Jules supervisor and durable polling research

Research date: 2026-08-22

## Overview

Commit `c37d24a` adds an in-memory interval supervisor and an expiry-only SQLite polling lease. It is not connected to production startup, does not implement the plan's Phase 14 dispatch guarantees, and does not yet satisfy the durable, rate-aware, ownership-fenced polling required by planned Phases 16, 17, and 24.

## Research purpose

Assess whether the new supervisor can safely poll Jules sessions across failures, restarts, and multiple Orchestra processes, and verify the output/activity assumptions it inherits against the published Jules API.

## Research findings

### Poll scheduling and error semantics

The Jules API can return transient errors and rate-limit responses. A durable poller therefore needs persisted next-attempt state, bounded exponential backoff with jitter, rate-limit handling, and slower polling for inactive states. The reviewed supervisor snapshots every nonterminal row on every fixed interval and has no durable `nextPollAt`, retry count, last-error classification, or jitter.

`JulesSessionManager.pollSession` represents configuration, lookup, and transient request failures as `{ ok: false, error }` rather than throwing. The supervisor does not inspect `ok`; it increments `polled`, reports zero errors, releases the lease, and immediately makes the row eligible for the next interval. A runtime probe returning a simulated 429 result produced `{ polled: 1, active: 1, errors: 0 }`.

### Lease ownership and fencing

The database stores only `polling_lease_expires_at`. Acquisition does not issue an owner ID, lease token, or generation; there is no renewal operation; and release clears the column by session ID alone. If worker A exceeds the lease duration, worker B can acquire the expired lease, after which A's unconditional release erases B's live lease. A probe acquired a 1 ms lease, acquired a new 60-second lease after expiry, performed the old holder's release, and then immediately acquired a third lease successfully.

This violates the plan's Phase 24 requirement that locks have ownership, expiration, recovery, and diagnostic information. An expiring lease must use an opaque fencing token and compare that token for renewal, state writes, and release. Long polls and terminal handoffs must either renew safely or be bounded below the verified lease window.

### Failure, stop, and restart behavior

`isTickInProgress` is reset only on the normal return path. Failures from session listing, lease acquisition/release, or an exception thrown by `onError` escape the loop and leave the flag true. A probe made `listNonTerminal` throw once; every later tick returned zero work.

`start` creates an `AbortController`, but its signal is never passed to the session manager, Jules client, lease work, or callback. `stop` clears the timer without awaiting an active tick, so API calls and terminal callbacks can continue against resources being shut down. Startup also waits one full interval before the first poll, and no production bootstrap constructs or starts the supervisor in the reviewed commit. The interval itself is process memory rather than durable scheduling, and there is no startup recovery workflow.

### Terminal handoff durability

The session manager persists a terminal cloud state and marks the task `completed` or `failed` before the supervisor calls `onTerminal`. If the callback fails or the process exits in that gap, the session is excluded by the next `listNonTerminal` query, so PR import/review cannot be retried. A probe that persisted `COMPLETED` and threw from `onTerminal` produced one error on the first tick and zero active sessions on the second.

The reverse risk also exists: lease expiry can allow concurrent holders to deliver the callback more than once. There is no durable terminal-handoff state, outbox record, idempotency key, or compare-and-set transition tying the exact output SHA to downstream import and review. Completion must remain an intermediate provider result until the planned PR validation, import, verification, and independent review finish.

### Published session and activity shapes

The official Sessions reference defines `outputs` as a list of session outputs. A pull-request output contains its URL and descriptive fields; the published schema does not expose the reviewed code's object-shaped `outputs.pullRequest.headCommitSha`. The focused test recreates the implementation's incompatible object shape, so it cannot detect the mismatch.

The official Activities list method is paginated and returns a `nextPageToken`. The reviewed client returns only the first page, while the session manager deduplicates primarily by timestamp and can suppress activity errors. Those inherited issues are already recorded in R-068, R-070, R-071, and R-073; adding an interval around them makes the loss continuous rather than repairing it.

## Evaluation

| Area | Evaluation | Notes |
| --- | --- | --- |
| Planned Phase 14 dispatch | Not implemented | No transactional dispatch, idempotency, ambiguous-timeout reconciliation, or duplicate detection |
| Production lifecycle | Missing | Supervisor is exported but has no production caller or startup recovery |
| Poll scheduling | Unsafe | Fixed interval, no durable due time, backoff, jitter, or rate-limit state |
| Error accounting | Incorrect | `{ ok: false }` is counted as a successful poll |
| Lease safety | Unsafe | No owner/fencing token, renewal, or owner-checked release |
| Stop semantics | Incomplete | Abort signal is unused and active work is not awaited |
| Terminal handoff | Lossy | Terminal state is committed before a non-durable callback |
| Jules wire contract | Incompatible | Output shape and activity pagination do not match the published API |
| Modularity | Weak | Scheduling, leasing, provider polling, output extraction, callbacks, and error policy share one concrete class |

## Conclusion

Keep planned Phase 14 open and treat this commit as an incomplete Phase 16/17 prototype. Introduce a provider-neutral durable scheduler, an owner-token lease repository with fencing and renewal, persisted retry/due/error state, and a transactional terminal-handoff/outbox state machine. Keep the Jules adapter responsible only for remote polling and translation, and do not mark the Orchestra task complete until exact PR output has passed the downstream import, verification, and review workflow.

## References

- https://jules.google/docs/api/reference/sessions
- https://jules.google/docs/api/reference/activities/
- https://jules.google/docs/api/reference/overview

## Related repair items

See R-104 through R-112 in `repair.md`.
