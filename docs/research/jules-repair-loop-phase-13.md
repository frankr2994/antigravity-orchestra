# Jules repair-loop messaging and lifecycle research

Research date: 2026-08-22

## Overview

Commit `66d65d8` outlines cloud feedback, local takeover, and dispute strategies, but it uses an incompatible Jules messaging endpoint, does not bind a repair cycle to one task/session/head SHA, and does not implement the durable wait-for-new-head loop required by the plan. Several failure paths can start local work after an ambiguous remote message, allowing both engines to proceed concurrently.

## Research purpose

Verify the Jules feedback contract and assess whether the coordinator safely resumes a completed PR through bounded feedback, polling, exact-head change detection, verification, and independent review.

## Research findings

### Jules message contract

The official Jules Sessions reference documents `POST /v1alpha/sessions/{sessionId}:sendMessage` with a required JSON `prompt` field. It describes the operation as sending feedback or additional instructions to an active session. The reviewed client instead calls `:sendFeedback` with `{ "message": ... }`, so the focused mock validates an endpoint and body that are not in the published API.

Session capability must be determined explicitly. The coordinator treats every state except `FAILED` and `CANCELLED` as active, including `COMPLETED`, `PAUSED`, and plan/feedback waiting states. The published API includes `COMPLETED` and `FAILED` as completion states and does not promise that an arbitrary message will restart a completed session. Orchestra should query and validate the exact current state/capability before messaging, then observe the resulting activity/state rather than writing `IN_PROGRESS` locally.

### Activity-based acknowledgement

The Jules Activities API records user messages and subsequent agent/progress/completion events. Activities are immutable and can be used to reconstruct a session. A durable repair request can therefore persist an intent, send one message, and reconcile acknowledgement by polling for the corresponding user-message activity under the existing session cursor.

The current coordinator sends before recording an intent and does not retain a message/correlation ID or acknowledgement boundary. A timeout can mean either rejection or accepted work. Immediately starting a local fallback after such ambiguity risks concurrent cloud and local changes.

### Repair-cycle invariants

The implementation plan requires each repair cycle to record its input head SHA, output head SHA, findings, and verification results; unchanged SHAs must never count as completed repair. It also requires bounded repeated-failure detection and a user stop control that preserves audit history.

The reviewed coordinator derives the cycle from the count of all execution attempts, including initial dispatch and local attempts. It does not persist a repair-cycle aggregate, wait for a new PR head, compare input/output identities, rerun verification/review, detect repeated findings, or model a stop request.

### Local takeover

A local takeover must first establish what code is being repaired and ensure the remote writer cannot race it. The reviewed path only creates a `WORKING` attempt and changes the task target. It does not stop or fence the Jules session, import the exact PR head, start Antigravity, or persist repair instructions. Reporting that result as successful is therefore a scheduling assertion without an executing worker.

## Evaluation

| Area | Evaluation | Notes |
| --- | --- | --- |
| Jules endpoint/body | Incompatible | Uses `:sendFeedback` and `message`, not `:sendMessage` and `prompt` |
| Session eligibility | Unsafe | Completed and paused sessions are treated as active |
| Task/session binding | Unsafe | Independent IDs allow cross-task mutation |
| Message idempotency | Missing | Duplicate cycle calls resend and create attempts |
| Ambiguous outcome | Unsafe | Any message error immediately starts local takeover |
| Cycle accounting | Incorrect | Counts every execution attempt, not repair cycles |
| New-head gate | Missing | No wait, refresh, or unchanged-SHA rejection |
| Local takeover | Incomplete | No worker, exact checkout, or cloud fencing |
| Audit/recovery | Missing | No durable repair-cycle state or acknowledgement |

## Conclusion

Treat this module as an unintegrated Phase 22 sketch. First repair the Jules `sendMessage` adapter. Then implement repair as a versioned aggregate keyed by task, cloud session, review cycle, and exact input SHA: persist intent, send idempotently or reconcile ambiguity through activities, wait for a different validated PR head, rerun exact-head verification/review, and close the cycle transactionally. Local takeover needs its own fenced exact-head execution workflow rather than a target-field update.

## References

- https://jules.google/docs/api/reference/sessions
- https://jules.google/docs/api/reference/activities/
- https://jules.google/docs/api/reference/types/

## Related repair items

See R-094 through R-103 in `repair.md`.
