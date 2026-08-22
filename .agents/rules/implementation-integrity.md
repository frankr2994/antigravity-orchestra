# Implementation Integrity Rule

This rule is mandatory for implementation, refactoring, debugging, testing, migration,
recovery, and repair work. It supplements the specialized testing, security, and role rules.

## 1. Treat Assigned Scope as a Contract

Before editing code:

1. Identify the authoritative request, plan phase, acceptance criteria, and applicable Codex
   findings.
2. Map each acceptance criterion to the production code and test evidence that will prove it.
3. Identify prerequisites from earlier phases. Do not invent a later-phase substitute for a
   missing prerequisite.
4. If the proposed work primarily belongs to a different phase, stop and report the scope
   mismatch before implementation.

Do not mark a phase complete merely because the change resembles its title or focused tests
are green. Implement the assigned acceptance criteria, not an adjacent feature.

Execution constraints are also part of the contract. If the task requires a foreground-only
turn, do not spawn subagents, start background work, schedule waits, or return while delegated
work is pending. If Orchestra owns review, commit, or push, leave those actions to Orchestra.

## 2. Blocking Findings Stop Dependent Work

A confirmed finding blocks dependent implementation when it invalidates an external contract,
an architectural prerequisite, or a safety invariant involving security, identity, durability,
Git, persistence, concurrency, recovery, or untrusted execution.

- Resolve and verify the blocker before building another phase on the affected behavior.
- Do not defer a blocker merely because a final repair pass is planned.
- Record lower-risk deferred work explicitly, with its reason and impact.
- If the review does not state dependency impact clearly, ask Codex for a blocking decision.

This stop-the-line gate takes precedence over a review-log convention that defers repairs.

## 3. Test the Production Contract

Tests must exercise the production implementation and the boundary named by the test.

- Import production states, schemas, event registries, validators, routes, and policies; do not
  recreate them inside the test.
- An API test must make a request through the mounted API boundary.
- A persistence test must use the real repository/migration boundary against a temporary
  database when feasible.
- A Git safety test must use a temporary repository/remote when the guarantee depends on Git.
- External-service doubles must use authoritative documented or sanitized recorded wire
  fixtures. Never invent a convenient contract and make both code and mock agree with it.
- Architecture checks must analyze real dependencies, include a deliberately illegal fixture,
  and prove that the check fails for the violation.

Mock infrastructure only when doing so does not remove the invariant being tested. Production
bypass flags such as `skipPush`, `skipFetch`, `skipVerification`, or `disableValidation` must not
exist to make safety-critical tests easy; inject a fake port or adapter instead.

## 4. Validate Every Runtime Boundary

Treat HTTP input, provider JSON, database values, persisted historical data, Git/CLI/process
output, filesystem paths, URLs, model output, configuration, and environment values as untrusted
runtime data.

- Parse and validate before creating domain types or performing side effects.
- A TypeScript cast, non-null assertion, or static interface is not runtime validation.
- Provider-specific DTOs and unknown future states remain inside the provider adapter and map
  defensively into provider-neutral domain values.
- Preserve provenance and return stable typed error codes; redact public details.

## 5. Fail Closed and Represent Uncertainty Honestly

Never convert a failed command, timeout, malformed or missing response, empty verification set,
unknown state, parse failure, corrupt persistence, or unavailable dependency into success,
zero, empty data, or a normal working state.

Represent `none`, `unknown`, `not_configured`, `unavailable`, `failed`, `corrupt`, `cancelled`,
and `success` distinctly when they have different operational meaning. Do not claim cancellation
without confirmation, verification without executed checks, or an empty diff when comparison
failed.

## 6. Make Side Effects Durable and Recoverable

For non-idempotent network, provider, Git, filesystem, or process mutations:

1. Persist durable intent and an idempotency/ownership identity before the side effect.
2. Execute the side effect.
3. Persist acknowledgement and the logical state transition atomically when possible.
4. Treat an uncertain response as `ambiguous`; reconcile before retrying or failing over.

All database writes representing one logical transition belong in one transaction or in a
documented outbox/reconciliation protocol. Test failure between writes and between the remote
side effect and its acknowledgement. Durable workflows must resume idempotently after restart.

## 7. Prove Identity, Ownership, and Freshness

Load related task, execution attempt, provider session, review cycle, repair cycle, repository,
ref, worktree, and commit identities through durable ownership relationships. Do not trust loose
IDs supplied independently to belong together.

- Enforce foreign keys, uniqueness, compare-and-set versions, and canonical repository identity
  where applicable.
- Bind review, verification, repair, approval, and integration evidence to the exact full commit
  SHA. A changed SHA invalidates earlier evidence.
- Never fall back to local `HEAD` or a provider-supplied branch when an expected remote identity
  cannot be proven.
- Leases require owner/generation tokens, expiry, renewal, and fenced update/release semantics.
  A stale worker must not mutate state owned by a newer worker.

## 8. Preserve Layer Ownership

- Routes and controllers validate/authenticate/map HTTP only.
- Application services orchestrate use cases and transactions.
- Domain modules contain provider-neutral policies and invariants.
- Provider adapters own provider DTOs, wire validation, and translation only.
- Infrastructure modules implement database, Git, filesystem, process, and credential ports.

Do not create a cross-layer coordinator in a provider or route module simply to make a feature
work. Decompose by responsibility, dependency direction, lifecycle ownership, and independently
testable behavior—not arbitrary file or line counts.

## 9. Treat Security Mechanisms and Model Content as Trust Boundaries

Do not invent cryptography, key derivation, authentication, credential storage, or sandboxing
when the plan requires an established OS/platform facility. A Git worktree is not a security
sandbox. Untrusted code must not run with Orchestra host credentials or its full environment.

When repository text, filenames, diffs, provider data, or model findings enter another model
prompt, treat them as quoted data rather than instructions: validate structure, redact secrets,
bound size, preserve provenance, and bind the packet to the exact task/review/SHA.

## 10. Completion Gate

Before declaring implementation or a phase complete, report:

| Required evidence | What to report |
|---|---|
| Scope | Assigned phase/request and any intentionally deferred item |
| Acceptance | Each criterion mapped to production code and a proving test |
| Boundaries | Runtime validation and authoritative fixtures used |
| Failure behavior | Relevant malformed, nonzero, timeout, partial-write, duplicate, restart, stale-owner, changed-SHA, and cleanup cases |
| Verification | Exact commands run, their results, and pre-existing failures kept separate |
| Review gate | Applicable Codex findings and whether any dependent blocker remains |

Do not use `secure`, `isolated`, `immutable`, `cancelled`, `verified`, `compatible`,
`end-to-end`, or `complete` unless the stated property was actually demonstrated. If evidence is
partial, state exactly what remains unproved.
