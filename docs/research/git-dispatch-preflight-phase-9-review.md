# Git dispatch preflight and remote-reference research

Research date: 2026-08-22

## Overview

Commit `86fc10c` creates the outline of deterministic cloud preflight, but it uses abbreviated object IDs, collision-prone branch names, local tracking data, and an unverified ordinary remote branch. These do not establish the plan's exact-base and immutable-dispatch guarantees.

## Research purpose

Evaluate whether the Phase 9 implementation proves that Jules will start from the exact recorded Git commit, safely creates and verifies its task-specific remote branch, and fails closed under Git errors, collisions, and concurrent changes.

## Findings

### Full object identity

Git documents `rev-parse --short` as producing an abbreviated unique prefix with a configurable minimum length. An audit identity should instead use the full object ID resolved and verified as a commit. The reviewed shared status function returns the short form and preflight records it as `baseSha`.

### Branch creation and mutation

Git push refspecs update destination refs and allow normal fast-forward updates. Therefore a successful push does not prove that a task-specific branch was newly created or will remain unchanged. An explicit expected-absence lease can reject an existing ref, and existing-equal recovery must compare the full remote ID.

### Remote verification

`git ls-remote` displays the commit IDs advertised by a remote ref. Reading the exact dispatch ref after push and comparing its full ID is necessary evidence; reading it again immediately before Jules session creation narrows the mutation race.

### Ref validation and collisions

Git supplies `check-ref-format --branch` for validating branch names. Sanitizing and truncating task/SHA text is not collision resistance. A probe produced an identical branch name for distinct inputs.

### Upstream state

`@{upstream}` is local tracking state and may be stale or refer to a remote other than origin. Git/parse errors must fail closed, and the intended remote's advertised IDs should be used for ahead/behind/divergence policy and evidence.

### Jules branch availability

The Jules Sources contract exposes repository branches and requires a `startingBranch` in session source context. After remote ref creation, preflight must verify that the exact branch is visible to Jules before creating the session.

## Evaluation

| Area | Assessment | Notes |
|------|------------|-------|
| Base commit identity | Unsafe | Abbreviated ID is recorded and pushed |
| Branch-name uniqueness | Unsafe | Truncated task and SHA prefixes collide |
| Remote branch creation | Unproven | Ordinary push can update an existing branch |
| Remote read-back | Missing | No advertised-ref comparison |
| Upstream validation | Unsafe | Local, potentially stale, and fail-open |
| Jules branch visibility | Missing | Source match does not inspect branches |
| Quota and repository locking | Missing | Required Phase 13 checks absent |
| Cleanup lifecycle | Missing | No retention or deletion policy |
| Test coverage | Insufficient | Success bypasses all remote operations |

## Conclusion

Use full verified object IDs throughout. Under a repository-scoped lock, create a collision-resistant checked ref with explicit expected-absence semantics, read the full remote ref back, persist that evidence, verify Jules can see the branch, and recheck immediately before session creation. Split planning from execution so tests inject a remote-ref fake rather than bypassing the guarantee.

## References

- https://git-scm.com/docs/git-rev-parse
- https://git-scm.com/docs/git-check-ref-format
- https://git-scm.com/docs/git-push
- https://git-scm.com/docs/git-ls-remote
- https://jules.google/docs/api/reference/sources/
- https://jules.google/docs/api/reference/types/

## Related repair items

See R-058 through R-066 in `repair.md`.
