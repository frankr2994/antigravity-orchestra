# Jules source discovery and repository matching research

Research date: 2026-08-22

## Overview

Commit `7ee25d6` establishes a useful source-discovery seam, but reliable dispatch requires stricter canonical GitHub identity parsing, structured Jules Source matching, complete pagination, explicit branch verification, and persistence of the stable resource name.

## Research purpose

Compare the Phase 8 implementation with the current Jules Sources contract and documented GitHub remote forms, with particular attention to false repository matches, missed sources, branch selection, secret leakage, and modular boundaries.

## Findings

### Jules Source identity

The official Source contract supplies an opaque resource `name` plus structured `githubRepo.owner` and `githubRepo.repo` fields. Current official examples use more than one resource-ID layout, so repository identity should come from the structured fields; the resource name should be persisted as an opaque dispatch identifier only after validation.

The reviewed matcher checks a path pattern inside `source.name` first. A probe demonstrated that this can override conflicting structured repository identity and return `connected` for the wrong repository.

### Pagination and retrieval

The Sources endpoint returns `nextPageToken`, supports `pageToken`/`pageSize`, and documents filtering and direct source retrieval. A one-page list is insufficient for determining that a GitHub App/source is absent.

### Branch visibility

The official `GitHubRepo` includes `defaultBranch` and `branches`, with each branch carrying a `displayName`. Jules instructs callers to retrieve available branches before creating a session whose `githubRepoContext` names the starting branch. Discovery should therefore include the exact intended branch and verify it before dispatch.

### GitHub remote identity

GitHub documents HTTPS and SSH clone URL forms. The implementation accepts any URL scheme with hostname `github.com`, including FTP/HTTP, credentials, custom ports, and extra path segments. Repository identity parsing should accept an explicit allowlist of supported clone forms, validate an exact owner/repository path, and return a sanitized canonical identity rather than the raw remote.

### Modularity and API exposure

Pure URL parsing and Source matching should be independently testable. Git command access, Jules network access, credential resolution, orchestration, persistence, and presentation belong behind separate ports or layers. A provider-backed GET that uses credentials should require dashboard authentication and bounded request behavior.

## Evaluation

| Area | Assessment | Notes |
|------|------------|-------|
| Structured owner/repository matching | Unsafe | Opaque name can override conflicting structured identity |
| Pagination | Incomplete | Only the first page is inspected |
| Branch verification | Missing | Starting branch is not an input |
| Stable source persistence | Missing | Resource name exists only in the response |
| Remote parsing | Unsafe | Malformed and credential-bearing URLs are accepted |
| Failure diagnostics | Unsafe | Distinct failures collapse and raw messages are exposed |
| Test isolation | Insufficient | Tests depend on the live checkout remote |
| Module boundaries | Insufficient | Git, vault, provider, orchestration, and UI text are combined |

## Conclusion

Build source discovery as an application service over narrow Git-remote, Jules-source, and persistence ports. Canonicalize only documented GitHub clone forms, match validated structured repository identity across all pages, verify the exact starting branch, persist the opaque Jules resource name, and expose safe typed outcomes through an authenticated route.

## References

- https://jules.google/docs/api/reference/sources/
- https://jules.google/docs/api/reference/types/
- https://jules.google/docs/api/reference/overview
- https://docs.github.com/en/get-started/git-basics/about-remote-repositories
- https://docs.github.com/en/get-started/git-basics/managing-remote-repositories

## Related repair items

See R-050 through R-057 in `repair.md`.
