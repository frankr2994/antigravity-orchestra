# Jules plan approval and activity polling research

Research date: 2026-08-29

## Summary

Jules sessions can require explicit plan approval and can receive feedback through `sendMessage` while active. The documented activity-list contract supports `pageSize` and `pageToken`; it does not support a `createTime` query filter. Session creation fields such as `requirePlanApproval` and `automationMode` are input-only, so their omission from later `GetSession` responses is not evidence that Jules rejected them.

## Research purpose

Define the provider contract for an Orchestra-owned local review gate that can approve or request revisions to a Jules plan without manual user interaction, and identify the cause of durable polling failures observed in a live cloud session.

## Findings

### Plan approval

- `requirePlanApproval: true` makes the latest plan require an `approvePlan` call before execution.
- Jules may eventually auto-approve a waiting plan on a provider-controlled timer, so Orchestra must reconcile a live state change and a matching `planApproved` activity rather than assuming its approval call is the only possible transition.
- `approvePlan` accepts an empty request body.

### Plan feedback

- `sendMessage` sends additional guidance to an active session.
- Jules documentation describes using feedback to revise plan steps before approval.
- Orchestra may therefore send bounded local-review findings while the session is `AWAITING_PLAN_APPROVAL`, then review the next generated plan as a new immutable plan identity.

### Activity polling

- `ListActivities` documents `pageSize` and `pageToken` pagination.
- A live request containing `createTime` returned HTTP 400 with an unknown-query-field error.
- Orchestra already persists activity identities, so full paginated reads plus durable receipt deduplication provide correct incremental processing without an unsupported timestamp filter.

### Session outputs

- `automationMode: AUTO_CREATE_PR` requests automatic pull-request creation.
- `automationMode` and `requirePlanApproval` are input-only fields.
- A terminal cloud session that was dispatched with `AUTO_CREATE_PR` but has no pull-request output cannot enter local PR review and must fail closed with an actionable error.

## Evaluation

| Concern | Decision | Reason |
|---|---|---|
| Local plan gate | Codex PASS automatically approves | Removes manual babysitting while retaining independent review |
| Blocked plan | Send bounded feedback and await a new plan ID | Supported interaction model; avoids approving known defects |
| Revision limit | Cap automatic review/revision cycles | Prevents an unbounded model/provider loop |
| Poll cursor | Durable receipt identity, not `createTime` | Matches the documented API and remains restart-safe |
| Empty completion | Fail closed | No exact artifact exists for local verification or review |

## Conclusion

Orchestra should own Jules plan approval as a durable local review stage. It should never silently approve malformed or unreviewed plans, and it should never represent a terminal session without a required PR output as locally reviewable work.

## References

- https://developers.google.com/jules/api/reference/rest
- https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage
- https://jules.google/docs/api/reference/sessions
- https://jules.google/docs/api/reference/activities/
- https://jules.google/docs/review-plan/
