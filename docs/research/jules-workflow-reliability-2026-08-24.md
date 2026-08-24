# Jules workflow reliability research

Research date: 2026-08-24

## Overview

The current Jules REST contract supports asynchronous session creation, inspection, activity streaming by polling, plan approval, user messages, and session deletion. The provider exposes `PAUSED` as a state, but the public REST references do not document pause or resume mutation endpoints. Orchestra therefore must not claim that it remotely paused Jules when it only stopped local work.

## Research purpose

Revalidate the provider contract before repairing Orchestra's stop, pause, resume, usage, activity, pull-request review, repair, and integration workflows.

## Research findings

### Session controls

- `DELETE /v1alpha/sessions/{session}` is documented by the current Jules Sessions reference and returns an empty response. Orchestra can use it for an explicit, irreversible cloud stop/delete operation.
- `POST /v1alpha/{session=sessions/*}:sendMessage` is the documented interaction endpoint. It can provide feedback to an active session; Orchestra can use focused guidance to continue a provider session that reports `PAUSED` or `AWAITING_USER_FEEDBACK`.
- The provider state model includes `PAUSED`, but neither the Google Developers REST method list nor the Jules Sessions reference publishes pause or resume endpoints. Orchestra must expose the limitation honestly and must not map a local scheduler pause to a remote Jules pause.
- The Jules web application supports pause, resume, and delete. Those web controls are not evidence of equivalent public REST mutations.

### Activity polling and progress

- Jules activities are immutable event records. They include plans, agent/user messages, progress updates, completion/failure events, and artifacts.
- The January 2026 Jules changelog documents a `createTime` activity filter as a range cursor intended for fetching only new activities. Orchestra should persist the latest activity timestamp, request incrementally, and keep receipt-based deduplication for equal timestamps and retries.
- Progress shown to the user should come from the durable local activity/event record rather than issuing a second provider request from the UI.

### Pull requests and local review

- A completed session may expose a pull-request URL through `Session.outputs[]` when `AUTO_CREATE_PR` is used.
- The PR URL is only an identity starting point. Orchestra must resolve the exact GitHub PR head, verify repository and dispatch-base ancestry, fetch that exact commit, run deterministic checks in an isolated worktree, and bind independent review evidence to the exact head SHA.
- Integration is complete only after the reviewed head is safely advanced onto the intended remote target branch and the corresponding local target branch ref is synchronized without overwriting unrelated local work.

### Usage policy

- Jules sessions consume a rolling account allowance, while activity reads are observation requests. Avoid duplicate session dispatches and unnecessary full-history polling.
- A failed local review should return structured, bounded findings to the same Jules session while the cloud-repair budget remains. Repair attempts must count repair requests, not the initial dispatch attempt.
- Automatic local-agent fallback must not be recorded as running unless a local executor was actually queued with the reviewed PR head available locally.

## Evaluation

| Area | Contract-safe behavior |
| --- | --- |
| Cloud stop | Confirm provider deletion before marking the task cancelled |
| Cloud pause | Report provider `PAUSED`; do not invent an undocumented REST mutation |
| Cloud resume | Send focused guidance through `sendMessage`, then reconcile provider state |
| Local pause/resume | Abort and await the local process, preserve task ownership and changes, then resume the same task |
| Progress | Persist incremental activities and render the local event timeline |
| Repair | Reuse Jules with bounded, exact review findings; count only repair cycles |
| Integration | Review exact PR head, push with compare-and-swap invariants, and safely synchronize the local target branch |

## Conclusion

Orchestra should model local scheduler control and remote provider control separately. The Jules workflow remains provider-first, but every irreversible or completion claim must follow a confirmed provider response and an exact Git identity. Durable cursors, idempotent handoff, bounded repair feedback, and safe local branch synchronization are the core reliability requirements.

## References

- https://jules.google/docs/api/reference/sessions
- https://developers.google.com/jules/api/reference/rest
- https://jules.google/docs/api/reference/activities/
- https://jules.google/docs/api/reference/types/
- https://jules.google/docs/changelog/2026-01-26-4
- https://jules.google/docs/running-tasks/
- https://jules.google/docs/tasks-repos
- https://jules.google/docs/code/
