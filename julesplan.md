# Google Jules Integration and Orchestra Modularization Plan

## Objective

Evolve Antigravity Orchestra into a modular local-and-cloud execution platform with:

- Antigravity as the interactive local implementation worker.
- Jules as the asynchronous cloud implementation worker.
- Codex as the independent design, debugging, and review specialist.
- Gemma as the local classifier, summarizer, and findings distiller.
- Orchestra Core as the provider-neutral workflow and Git control plane.

The integration must preserve existing local behavior while making the codebase easier to extend, test, and maintain.

## Architectural principles

1. Jules must be implemented through provider interfaces, not Jules-specific branches scattered throughout the application.
2. Existing local execution must continue working during every phase.
3. Refactoring should be behavior-preserving and covered by characterization tests.
4. API routes, workflows, providers, persistence, Git operations, and UI features must remain separate.
5. Provider-specific state must not become the application-wide task state.
6. External responses, paths, URLs, branches, and commit identifiers must be validated before use.
7. Cloud-generated code is untrusted until independently reviewed and verified.
8. All long-running workflows must be restart-safe and idempotent.
9. New functionality should be feature-flagged until its complete workflow passes integration tests.
10. No new monolithic coordinator or UI component should replace the existing monoliths.

## Target module structure

```text
orchestra-dashboard/
├── server/
│   ├── api/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── middleware/
│   │   └── sse/
│   ├── application/
│   │   ├── tasks/
│   │   ├── routing/
│   │   ├── review/
│   │   ├── verification/
│   │   └── recovery/
│   ├── domain/
│   │   ├── tasks/
│   │   ├── execution/
│   │   ├── events/
│   │   └── providers/
│   ├── providers/
│   │   ├── antigravity/
│   │   ├── codex/
│   │   ├── gemma/
│   │   └── jules/
│   ├── infrastructure/
│   │   ├── database/
│   │   ├── git/
│   │   ├── processes/
│   │   ├── credentials/
│   │   └── logging/
│   └── bootstrap/
└── src/
    ├── app/
    ├── api/
    ├── features/
    │   ├── tasks/
    │   ├── cloud-execution/
    │   ├── projects/
    │   ├── checkpoints/
    │   ├── settings/
    │   └── monitoring/
    └── shared/
        ├── components/
        ├── hooks/
        ├── types/
        └── utilities/
```

The exact directory names may evolve, but the dependency direction must remain:

```text
API/UI → application workflows → domain interfaces
                                 ↑
              provider and infrastructure adapters
```

## Phase 1 — Establish a behavioral baseline

Before structural changes:

- Run and record the existing build, lint, and test results.
- Add characterization tests for the current local task workflow.
- Cover task creation, routing, execution, review, verification, recovery, commit, and push behavior.
- Record existing SSE event names and payload shapes.
- Add fixtures for successful, failed, interrupted, and disputed tasks.
- Identify supported compatibility behavior that must not change.

Acceptance criteria:

- Existing local workflows have automated regression coverage.
- Later refactoring can be validated without relying on manual testing.
- Any existing test failures are documented separately from new failures.

## Phase 2 — Add modularity rules and dependency boundaries

Define rules for future implementation:

- Route handlers parse input and return responses; they do not implement workflows.
- Workflows depend on interfaces rather than SQLite, Git, or provider processes directly.
- Providers do not write directly to the database.
- UI feature modules do not duplicate server domain types manually.
- Generic task modules do not inspect raw Jules response objects.
- Jules-specific conditionals are allowed only in provider registration, routing policy, and Jules feature presentation.
- Large files are decomposed by responsibility rather than arbitrarily split by size.

Add checks for prohibited cross-module imports where practical.

Acceptance criteria:

- Module ownership and dependency direction are documented.
- New features have an obvious location.
- Circular dependencies are rejected by linting, tests, or architecture checks.

## Phase 3 — Extract shared domain contracts

Create provider-neutral domain models for:

- Task identity and lifecycle.
- Execution target: `local`, `cloud`, or `auto`.
- Worker identity.
- Execution attempts.
- Provider session references.
- Review findings and verdicts.
- Verification results.
- Git integration results.
- Task and timeline events.

Keep Orchestra task state distinct from provider state:

```text
OrchestraTaskState
ProviderExecutionState
JulesSessionState
```

Add an explicit Jules-to-Orchestra state mapper covering:

- `STATE_UNSPECIFIED`
- `QUEUED`
- `PLANNING`
- `AWAITING_PLAN_APPROVAL`
- `AWAITING_USER_FEEDBACK`
- `IN_PROGRESS`
- `PAUSED`
- `COMPLETED`
- `FAILED`

Acceptance criteria:

- Raw provider state cannot be stored as Orchestra task state.
- Unknown future provider states degrade safely instead of crashing.
- State mapping is exhaustively unit-tested.

## Phase 4 — Modularize persistence

Split the current database responsibilities into repositories such as:

- `ProjectRepository`
- `SessionRepository`
- `TaskRepository`
- `TaskEventRepository`
- `ExecutionAttemptRepository`
- `CloudSessionRepository`
- `GitOperationRepository`
- `SettingsRepository`

Introduce versioned, transactional migrations rather than adding ad hoc column checks.

Migrations must:

- Work on existing user databases.
- Be transactional where SQLite permits.
- Be idempotent.
- Preserve rollback or backup guidance.
- Record schema version.
- Include migration tests using older database fixtures.

Acceptance criteria:

- Application workflows no longer issue SQL directly.
- Existing installations migrate without losing tasks or sessions.
- Cloud execution metadata has a dedicated persistence model.

## Phase 5 — Decompose the server bootstrap and API routes

Break `server/index.ts` into:

- Application bootstrap.
- Dependency construction.
- Route modules.
- Request validation.
- Error middleware.
- SSE connection management.
- Shutdown handling.

Keep the bootstrap responsible only for assembling dependencies and starting the server.

Acceptance criteria:

- API behavior remains unchanged.
- Route tests continue to pass.
- Jules routes can be added without expanding the main bootstrap substantially.

## Phase 6 — Decompose the local task workflow

Split the current `TaskManager` responsibilities into focused services:

- Task submission.
- Classification and routing.
- Local execution.
- Provider failover.
- Review orchestration.
- Repair loops.
- Deterministic verification.
- Git finalization.
- Monitoring and health calculation.
- Recovery and user steering.

Use a workflow context object rather than repeatedly reloading and reparsing loosely typed task fields.

Acceptance criteria:

- The existing Antigravity workflow behaves identically.
- Review and repair policy can be tested independently.
- Cloud execution can implement the same workflow contracts without copying the local workflow.

## Phase 7 — Decompose provider execution code

Extract current provider-specific logic into adapters:

```ts
interface ExecutionProvider {
  readonly id: string;
  preflight(context: ExecutionContext): Promise<PreflightResult>;
  start(request: StartExecutionRequest): Promise<ProviderExecution>;
  inspect(reference: ProviderReference): Promise<ProviderSnapshot>;
  sendFeedback?(reference: ProviderReference, message: string): Promise<void>;
  stop?(reference: ProviderReference): Promise<StopResult>;
}
```

Not every provider must support every capability. Capabilities must be declared rather than assumed.

Acceptance criteria:

- Antigravity uses the provider interface before Jules is added.
- Codex and Gemma remain specialist services, not forced into an implementation-worker abstraction that does not fit them.
- Unsupported provider operations return typed capability errors.

## Phase 8 — Modularize the frontend

Break `App.tsx` into:

- Application shell and navigation.
- Task submission feature.
- Execution-target selector.
- Live run monitor.
- Cloud session details.
- Projects.
- Checkpoints.
- MCP management.
- Settings.
- Shared status, card, field, and event components.
- Dedicated API hooks or client modules.

Move event formatting and state presentation out of the root component.

Split CSS by feature or component while keeping shared tokens centralized.

Acceptance criteria:

- Existing views remain visually and behaviorally equivalent.
- A Jules feature panel can be added without modifying unrelated views.
- Server response types are shared or generated instead of manually duplicated.

## Phase 9 — Implement the Jules API client

Create a narrowly scoped Jules adapter supporting the documented API:

- API-key authentication through `X-Goog-Api-Key`.
- List and retrieve sources.
- Create, list, retrieve, and delete sessions.
- List session activities.
- Approve a pending plan.
- Send feedback to an active session.
- Retrieve completed session outputs.

The client must include:

- Request timeouts.
- Abort support.
- Typed response validation.
- Pagination.
- Retry with bounded exponential backoff.
- `429` handling.
- Redacted errors.
- Contract tests using recorded, sanitized fixtures.

Do not assume Jules provides:

- Streaming events.
- Webhooks.
- A cancellation endpoint.
- PR head branch names.
- Resulting commit SHAs.

The current API is alpha, so isolate its types completely inside the Jules adapter. See the official [Jules API reference](https://jules.google/docs/api/reference/overview).

## Phase 10 — Implement secure Jules configuration

Add configuration for:

- Jules API endpoint.
- Jules API key reference.
- Polling interval.
- Request timeout.
- Retry limits.
- Maximum concurrent Jules sessions.
- Plan-approval default.
- Jules feature flag.

Credentials must be read from:

- Environment variables, or
- An OS-protected credential store.

Do not store the raw Jules API key in the existing plaintext SQLite settings table.

Acceptance criteria:

- Secrets never appear in logs, SSE events, task records, or error payloads.
- The application can verify Jules connectivity without exposing the key.
- Revoked and invalid keys produce actionable errors.

## Phase 11 — Add Jules source discovery and repository matching

Before cloud dispatch:

- List sources available to the Jules account.
- Normalize the local GitHub remote.
- Match its owner and repository against a Jules Source.
- Verify the selected starting branch is visible to Jules.
- Detect missing Jules GitHub App installation.
- Present remediation instructions when a source is unavailable.
- Persist the stable Jules source resource name.

Acceptance criteria:

- A GitHub `origin` alone is not considered sufficient.
- Repository identity comparisons reject lookalike hosts and malformed URLs.
- Users can see which repositories Jules is authorized to access.

## Phase 12 — Add the cloud execution persistence model

Persist cloud execution separately from the generic task record:

- Orchestra task ID.
- Provider ID.
- Jules session resource name and ID.
- Jules source name.
- Target branch.
- Immutable dispatch branch.
- Recorded base SHA.
- Current provider state.
- Last processed activity identifier and timestamp.
- Polling lease and next poll time.
- PR URL.
- Resolved PR head SHA.
- Review cycle.
- Repair attempt.
- Failure information.
- Created, updated, and completed timestamps.

Acceptance criteria:

- Multiple provider attempts can belong to one Orchestra task.
- Restart recovery does not depend on in-memory state.
- Sensitive values are not persisted in execution records.

## Phase 13 — Implement deterministic cloud-dispatch preflight

Preflight must verify:

1. The project is a Git repository.
2. `origin` is a supported GitHub repository.
3. The target branch and upstream are known.
4. The exact local base SHA exists remotely.
5. Required task inputs contain no uncommitted or unpushed-only work.
6. The Jules source and starting branch are available.
7. Credentials and quota permit dispatch.
8. No conflicting repository-level Git operation is running.

Because Jules starts from a branch rather than a commit SHA:

- Create a unique dispatch branch at the exact recorded SHA.
- Use a validated name such as `orchestra/jules-base/<task-id>`.
- Push that branch.
- Confirm the remote branch resolves to the expected SHA.
- Pass that immutable task-specific branch to Jules.

Acceptance criteria:

- Jules cannot silently start from a newer commit than the recorded base.
- Dispatch fails safely if the remote branch does not match.
- Temporary dispatch branches have documented retention and cleanup rules.

## Phase 14 — Implement explicit cloud dispatch

When the user selects Cloud:

- Create the Orchestra task and cloud attempt transactionally.
- Call `POST /v1alpha/sessions`.
- Supply the matched source and immutable starting branch.
- Set `requirePlanApproval` from the user or project policy.
- Use `AUTO_CREATE_PR` when Orchestra expects a PR output.
- Persist the returned session reference before monitoring begins.
- Emit provider-neutral timeline events.

Use an idempotency strategy so a timeout does not accidentally create duplicate sessions.

Acceptance criteria:

- Failed dispatch leaves a diagnosable task record.
- Ambiguous timeouts enter reconciliation rather than blindly retrying.
- Duplicate cloud sessions are detected and surfaced.

## Phase 15 — Implement plan review and user feedback

Support:

- Displaying generated Jules plans.
- Explicit plan approval.
- Requests for user feedback.
- Sending user messages through `sendMessage`.
- Recording approvals and messages in the Orchestra timeline.
- Distinguishing deletion from cancellation in UI language.

Acceptance criteria:

- Approval is available only in `AWAITING_PLAN_APPROVAL`.
- Feedback is allowed only while the session supports it.
- Repeated clicks are idempotent or safely rejected.

## Phase 16 — Implement durable activity polling

Use the documented Activities API as a poller:

- Persist a polling cursor or last activity timestamp.
- Handle pagination fully.
- Deduplicate by activity resource name or ID.
- Preserve activity ordering.
- Apply bounded exponential backoff.
- Respect rate limits.
- Slow polling for paused or inactive sessions.
- Stop polling terminal sessions.
- Maintain a per-session polling lease to prevent duplicate pollers.

Translate raw activities into stable Orchestra events inside the Jules adapter.

Acceptance criteria:

- Restarting the dashboard does not duplicate timeline events.
- Multiple dashboard instances cannot poll the same session concurrently.
- Unknown activity types are retained as provider metadata without breaking the task.

## Phase 17 — Implement real crash recovery

Replace the current blanket “mark interrupted tasks failed” behavior with provider-aware recovery:

- Local foreground tasks may retain the existing failure/recovery policy.
- Nonterminal Jules sessions must be reloaded from the database.
- Orchestra must query their current state.
- Polling leases must be reclaimed after expiration.
- Completed sessions must resume at PR import or review.
- Missing or deleted remote sessions must produce a recoverable failure state.
- Recovery operations must be idempotent.

Acceptance criteria:

- A process restart during every Jules state has an integration test.
- No cloud session is automatically declared failed merely because Orchestra restarted.
- Recovery resumes from the last durable workflow checkpoint.

## Phase 18 — Add cloud monitoring UI

Add:

- `Auto`, `Local — Antigravity`, and `Cloud — Jules` selection.
- `/jules <prompt>`.
- `/jules-status`.
- Session state and elapsed time.
- Generated plan.
- Feedback prompt and response.
- Activity timeline.
- Jules session link.
- PR link.
- Retry, delete, and recovery actions with accurate wording.

Keep the generic task monitor provider-neutral. Jules-only detail belongs in a Jules feature component.

Acceptance criteria:

- Local task UI remains unaffected.
- Reloading the page reconstructs cloud state from persisted data.
- Unsupported operations are hidden or disabled with an explanation.

## Phase 19 — Resolve and import the completed PR safely

When Jules completes:

1. Strictly validate the returned GitHub PR URL.
2. Confirm it belongs to the expected owner and repository.
3. Fetch the exact PR head ref.
4. Resolve its full commit SHA.
5. Persist that SHA.
6. Re-fetch and compare before each approval or merge operation.
7. Create a detached temporary worktree at that exact SHA.
8. Never trust a provider-supplied branch name as authoritative.

Use a unique validated worktree path under Orchestra’s managed data directory.

Acceptance criteria:

- Review always targets the recorded PR head SHA.
- A force-pushed PR invalidates prior verification.
- Fork-based and same-repository PRs are handled explicitly.

## Phase 20 — Harden isolated verification

Before executing code from the PR:

- Create a fresh review worktree.
- Detect the project ecosystem.
- Install dependencies from lockfiles using deterministic commands.
- Define whether install scripts are allowed.
- Apply time, output, memory, and process limits.
- Run lint, build, typecheck, and tests when available.
- Store structured results.
- Mark “no verification configured” separately from “verification passed.”
- Terminate spawned processes before worktree cleanup.

For npm projects, prefer `npm ci` when a compatible lockfile exists.

Acceptance criteria:

- Missing dependencies do not cause misleading failures.
- A project with no tests cannot be reported as fully verified.
- Verification results are tied to the exact reviewed commit SHA.

## Phase 21 — Implement independent Codex review

Build a review packet containing:

- Original request.
- Jules plan.
- Base SHA.
- PR head SHA.
- Changed files.
- Diff.
- Verification results.
- Relevant repository instructions.
- Previous review findings, if any.

Codex remains read-only and returns structured findings containing:

- Severity.
- File and location.
- Explanation.
- Evidence.
- Recommended correction.
- Blocking status.

Acceptance criteria:

- A passing review is tied to the exact PR head SHA.
- New commits invalidate the prior verdict.
- Review output is parsed defensively and retained verbatim for auditability.

## Phase 22 — Implement the Jules repair loop

If review or verification blocks the PR:

- Gemma distills findings into concise repair instructions.
- Orchestra sends them through Jules `sendMessage`.
- Polling resumes.
- Orchestra waits for a new PR head SHA.
- Verification and review rerun against the new SHA.
- Attempts are bounded by policy.
- Repeated identical failures trigger user attention.

Acceptance criteria:

- Orchestra never treats an unchanged SHA as a completed repair.
- Each cycle records its input SHA, output SHA, findings, and verification results.
- Users can stop automatic repair without deleting audit history.

## Phase 23 — Implement conflict-safe integration

Separate these concepts clearly:

- Reviewing a PR.
- Approving a PR.
- Merging on GitHub.
- Integrating into the local target branch.
- Cleaning up temporary refs and worktrees.

Before merge:

1. Acquire the repository Git lock.
2. Refresh the remote target SHA.
3. Refresh the PR head SHA.
4. Invalidate stale verification if the head changed.
5. Build an integration result in a temporary worktree.
6. Run final verification on the exact integration commit.
7. Require user confirmation.
8. Push or merge using a clearly documented strategy.
9. Refuse non-fast-forward updates unless an explicit safe policy permits them.
10. Refresh GitHub PR status afterward.

Do not call a local-only operation “Merge Jules PR” unless it actually updates the GitHub PR’s base branch.

Acceptance criteria:

- Target-branch advancement is handled without modifying the primary working tree.
- Branch protection and rejected pushes surface as actionable results.
- The exact verified integration commit is the commit that gets merged or pushed.

## Phase 24 — Implement repository-level concurrency control

Use separate controls for:

- Global task capacity.
- One mutating local worker per project.
- Configurable concurrent Jules sessions.
- One polling lease per cloud session.
- One repository Git-operation lock.

The Git lock must cover:

- Creating or deleting dispatch refs.
- Fetching PR refs.
- Adding, removing, or pruning worktrees.
- Integration testing.
- Merging and pushing.
- Cleanup that changes shared Git metadata.

Acceptance criteria:

- Concurrent Jules execution remains possible.
- Simultaneous completions cannot corrupt refs or worktrees.
- Locks have ownership, expiration, recovery, and diagnostic information.

## Phase 25 — Harden cleanup

Cleanup must:

- Verify that managed paths resolve beneath the configured worktree directory.
- Stop child processes before deletion.
- Retry expected Windows file-lock failures.
- Preserve diagnostic information when cleanup fails.
- Remove only task-owned refs and worktrees.
- Run `git worktree prune` under the Git lock.
- Never delete user branches or directories based on unvalidated provider data.

Acceptance criteria:

- Cleanup is idempotent.
- Failed cleanup does not change task success into an unexplained failure.
- Retrying cleanup after restart is safe.

## Phase 26 — Add Auto routing

Enable Auto only after explicit Local and Cloud modes are stable.

Routing should consider:

- Whether required inputs exist only in the local working tree.
- Task size and expected duration.
- Need for interactive clarification.
- Repository availability in Jules.
- Current provider availability and quota.
- Risk level.
- Dependency or migration scope.
- User preference and project policy.

Gemma may recommend a target, but deterministic rules enforce hard constraints.

Acceptance criteria:

- Routing decisions include human-readable reasons.
- Users can override recommendations.
- Auto never sends unpushed-only context to Jules.

## Phase 27 — Add comprehensive testing

Required test layers:

- Domain state-transition tests.
- Database migration tests.
- Jules response contract tests.
- State-mapping tests.
- Activity pagination and deduplication tests.
- Polling lease tests.
- Restart-recovery tests.
- Temporary-repository Git tests.
- Concurrent completion tests.
- PR head-change tests.
- Verification sandbox tests.
- Repair-loop limit tests.
- API route tests.
- Frontend feature tests.
- End-to-end local and cloud workflow tests.

No live Jules credentials should be required for the default test suite.

## Phase 28 — Observability and operational controls

Add structured telemetry for:

- Jules request latency and status.
- Polling frequency and rate limits.
- Active sessions.
- Session age.
- State-transition duration.
- Recovery attempts.
- Review and repair cycles.
- Verification duration.
- Worktree cleanup failures.
- Git lock contention.

Redact prompts, patches, repository contents, and credentials unless explicit diagnostic logging is enabled.

## Phase 29 — Staged rollout

Roll out in this order:

1. Internal modular refactor with Jules disabled.
2. Jules connection and source discovery.
3. Read-only session listing.
4. Manual cloud dispatch.
5. Plan approval and monitoring.
6. PR import and review.
7. Manual repair feedback.
8. Automated bounded repair.
9. Conflict-safe merge.
10. Concurrent sessions.
11. Auto routing.

Each stage must have a rollback switch that leaves local execution operational.

## Definition of done

The integration is complete when:

- Existing local workflows still pass their regression suite.
- Jules is isolated behind a provider adapter.
- Server bootstrap, task orchestration, provider code, persistence, and Git operations are separate modules.
- The frontend is divided into independently maintainable feature areas.
- Cloud sessions survive application restarts.
- Dispatch is tied to an immutable base commit.
- Review and verification are tied to an exact PR head SHA.
- Concurrent cloud sessions cannot race shared Git state.
- Credentials are never stored or logged in plaintext.
- Cloud-generated code cannot be merged without deterministic verification, independent review, and user confirmation.
- Adding another cloud implementation provider does not require duplicating the Jules workflow or enlarging the original monolithic files.
