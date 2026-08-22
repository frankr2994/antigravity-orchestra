# Git worktree and pull-request review research

Research date: 2026-08-22

## Overview

Commit `c4ab60f` adds a detached-worktree review helper, but safe review requires stronger PR identity binding, strict Git-result validation, task-owned refs and paths, repository locking, and an isolated verification boundary. Several implementation choices can report a successful review of the wrong commit or after Git has rejected the requested comparison.

## Research purpose

Compare the commit's ref fetching, diff calculation, worktree lifecycle, and verification behavior with the current Git and GitHub contracts and with the later safety phases in `julesplan.md`.

## Research findings

### Pull-request head identity

GitHub documents `refs/pull/<number>/head` as the latest commit on a pull request's head branch. A safe reviewer can fetch that ref into a task-owned local ref, resolve its full object ID, and bind all results to that ID. Independently accepting a PR number, branch, and SHA without requiring them to agree breaks that binding. Branch names are particularly unsuitable as authoritative identity because fork pull requests do not necessarily expose their head branch under the upstream repository's `refs/heads` namespace.

The reviewed implementation fetches a PR ref but continues using a separately supplied `headSha` when both are present. A local-remote probe confirmed that it returned success while reviewing a different commit from the fetched PR head.

### Git diff semantics and result checking

Git documents `git diff A...B` as comparing `B` with the merge base of `A` and `B`, not necessarily comparing the two exact endpoint trees. That presentation can be useful for a normal PR, but Orchestra's recorded dispatch base is a security and audit invariant. It must validate that both full IDs are commits, establish the required ancestry/repository relationship, and deliberately choose the intended comparison.

Every Git exit code must be checked. A probe supplied a nonexistent base object; both diff commands failed, but the helper discarded their exit codes and returned `ok: true`, `verified: true`, an empty diff, and no changed files.

### Fetch refs and worktree metadata

Git refspecs with a leading `+` permit forced local-ref updates. The implementation force-updates shared `refs/remotes/origin/...` names, including ordinary branch-tracking names, without a repository lock or task ownership. Concurrent reviews can race or overwrite shared ref evidence.

Git worktrees share administrative metadata in the repository. `git worktree prune` removes stale worktree metadata globally, while worktree locks can protect entries from pruning. Fetch, add, remove, and prune therefore need one repository-level lock and ownership checks rather than best-effort concurrent mutation.

### Verification trust boundary

Cloud-generated code is untrusted. Running package-defined lint, build, or test scripts executes arbitrary code from the PR. The shared process helper inherits the full Orchestra environment, and the review path adds no sandbox, secret-reduced environment, network policy, memory cap, output cap, dependency-install policy, or durable result binding.

An empty or malformed project produces no recognized verification commands. JavaScript's `every` returns true for an empty array, so the implementation reports such a project as verified. This conflicts with the plan's requirement to distinguish “no verification configured” from a passing verification run.

## Evaluation

| Area | Evaluation | Notes |
| --- | --- | --- |
| PR identity | Unsafe | Fetched head can be overridden by an unrelated supplied SHA |
| Missing head behavior | Unsafe | Falls back to the primary workspace's local `HEAD` |
| Base validation | Unsafe | Git failures can become a clean successful result |
| Diff semantics | Ambiguous | Three-dot uses merge base and no ancestry invariant is checked |
| Ref isolation | Unsafe | Forced updates use shared remote-tracking refs |
| Worktree cleanup | Unsafe | Collision-prone paths and global prune have no ownership lock |
| Verification | Unsafe | Executes untrusted scripts on the host and empty checks pass |
| Durability | Missing | Results and exact head identity are not persisted |

## Conclusion

Treat the module as an unintegrated prototype for planned Phases 19 and 20. Resolve and persist PR identity before review, fetch into unique task-owned refs under a repository lock, validate every full commit ID and Git result, use canonical managed paths with ownership records, and execute deterministic checks in a constrained environment. A missing check suite must be an explicit non-passing outcome.

## References

- https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/checking-out-pull-requests-locally
- https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests
- https://git-scm.com/docs/git-fetch
- https://git-scm.com/docs/git-diff
- https://git-scm.com/docs/git-worktree

## Related repair items

See R-077 through R-085 in `repair.md`.
