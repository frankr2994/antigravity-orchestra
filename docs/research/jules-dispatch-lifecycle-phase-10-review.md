# Jules dispatch and lifecycle research for the Phase 10 review

## Overview

This note records the external API-contract research used to review commit `928b102`. The reviewed commit labels itself Phase 10, although `julesplan.md` defines Phase 10 as secure Jules configuration and places explicit dispatch and lifecycle work in later phases.

## Purpose

The review needed to determine whether the new session manager sends and interprets the documented Jules API shapes, whether its polling cursor is compatible with the activity-list contract, and whether its cancellation behavior corresponds to a documented remote operation.

## Findings

### Session creation and output shapes

The official session reference documents `automationMode: "AUTO_CREATE_PR"` in a create request. It does not document an `autoPr` Boolean. A Session's `outputs` field is a list of `SessionOutput` values, not an object with a direct `pullRequest` member.

The documented pull-request output contains `url`, `title`, and `description`. It does not expose the `headCommitSha` field assumed by the implementation. The reviewed request and response types therefore do not match the published alpha contract.

### Lifecycle operations

The documented session endpoints are create, list, get, delete, send message, and approve plan. The reference does not document `:pause`, `:resume`, or a cancel endpoint. A `PAUSED` session state can exist without implying that clients are allowed to create that state through an undocumented action.

Consequently, treating a failed `:pause` request as a successful cancellation is not a valid confirmation that remote work stopped. Delete is a distinct documented operation and should not silently be reinterpreted as cancel without an explicit product policy.

### Activity pagination and persistence

The activities endpoint is paginated and returns a `nextPageToken`; it also supports creation-time filtering. Activities can carry structured artifacts including patches, shell output, and media. Fetching only one page can miss activity history, while persisting the entire upstream object without validation, redaction, or size limits can place code, command output, binary content, or sensitive data in task-event storage.

A durable poller should keep a stable, provider-aware cursor and deduplicate by stable activity identity as well as time. It should not infer the cursor from the final element of an array unless ordering is part of the validated contract.

### Reliability implications

The published create-session reference does not document an idempotency key. This is an inference from the current public reference, not proof that the service has no internal deduplication. Because the existing client retries transient POST failures, Orchestra must persist dispatch intent and reconcile ambiguous outcomes before creating another session; otherwise a timeout after remote acceptance can result in duplicate work.

Local persistence also needs an atomic state transition around the attempt, cloud-session reference, event, and task state. Creating the remote session first and then performing independent local writes leaves no durable record from which to reconcile an orphaned remote session after a database or process failure.

## Evaluation

| Area | Documented contract | Commit `928b102` | Result |
| --- | --- | --- | --- |
| Automatic PR creation | `automationMode: "AUTO_CREATE_PR"` | `autoPr: boolean` | Incompatible |
| Session outputs | `SessionOutput[]` | Object with `outputs.pullRequest` | Incompatible |
| PR commit identity | No documented head SHA field | Reads `headCommitSha` | Unsupported assumption |
| Remote cancellation | Delete is documented; pause/cancel is not | Calls `:pause`, ignores failure, records cancelled | False-success risk |
| Activities | Paginated, structured artifact payloads | First page, raw event persistence | Incomplete and unsafe |
| Dispatch retry | No documented idempotency key | Retryable POST with no reconciliation | Duplicate-session risk |

## Conclusion

The focused test passes because its mock reproduces the implementation's invented shapes and behavior. That success does not demonstrate compatibility with the documented Jules API. The implementation should be treated as an unintegrated prototype until its wire types, durable dispatch protocol, polling cursor, cancellation semantics, trust boundaries, and application-service decomposition are repaired.

## References

- [Jules API: Sessions](https://jules.google/docs/api/reference/sessions)
- [Jules API: Types](https://jules.google/docs/api/reference/types/)
- [Jules API: Activities](https://jules.google/docs/api/reference/activities/)
- [Jules API overview](https://jules.google/docs/api/reference/overview)
