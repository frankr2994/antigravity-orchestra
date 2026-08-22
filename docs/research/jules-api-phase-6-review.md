# Jules REST API contract check for commit `a47a233`

## Research question

Does the Jules client introduced by commit `a47a233` match the current official Jules REST API and the client requirements in `julesplan.md`?

## Sources consulted

- [Jules API overview](https://jules.google/docs/api/reference/overview) — base URL, API-key authentication, pagination, resource naming, and standard errors.
- [Sessions reference](https://jules.google/docs/api/reference/sessions) — create/list/get/delete sessions, `:sendMessage`, `:approvePlan`, and session responses.
- [Activities reference](https://jules.google/docs/api/reference/activities/) — activity listing, pagination, activity retrieval, and event/artifact examples.
- [Sources reference](https://jules.google/docs/api/reference/sources/) — source listing/filtering and source retrieval.
- [Types reference](https://jules.google/docs/api/reference/types/) — canonical Session, Activity, Source, output, artifact, and request/response shapes.

Checked: 2026-08-22. The API is alpha, so these references should be rechecked during the final repair pass.

## Findings

- Authentication and the default `https://jules.googleapis.com/v1alpha` base URL match the official overview.
- User feedback is sent through `POST /sessions/{id}:sendMessage` with `{ "prompt": "..." }`; `:sendFeedback` with `{ "message": "..." }` is not the documented wire contract.
- The official Sessions reference documents deletion but does not document pause or resume endpoints.
- Sources and activities return `nextPageToken`; a usable client must return that token or traverse subsequent pages.
- `Session.outputs` is an array. A pull-request output documents URL, title, and description, not head/base branches or a commit SHA.
- Activity events are represented by fields such as `planGenerated`, `agentMessaged`, `progressUpdated`, `sessionCompleted`, and `sessionFailed`, with structured change-set, bash-output, and media artifacts.
- The implementation performs TypeScript casts rather than runtime response validation, and its tests use hand-authored mocks instead of sanitized recorded fixtures.
- Generic retries of session-creation POSTs are unsafe without documented idempotency or reconciliation.

## Recommendation

Treat the provider client as an isolated anti-corruption layer: mirror and validate the official alpha wire schema locally, expose consistent paged results, map it into stable domain contracts, retry safe operations by default, and keep unsupported capabilities disabled. Revalidate the contract and fixtures before the final repair pass because the upstream API is explicitly experimental.

## Related repair items

See R-036 through R-042 in `repair.md`.
