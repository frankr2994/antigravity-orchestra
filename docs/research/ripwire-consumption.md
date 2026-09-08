# Ripwire integration and model consumption investigation

Investigated September 7–8, 2026 (America/New_York). No paid model runs were launched. The initial diagnostic led to a native Ripwire path fix, a bounded Orchestra wrapper, and a repeatable integration test; end-to-end model-quality and token savings still require a controlled replay.

The opportunity is real, but Orchestra currently combines integration mistakes with Windows-native Ripwire defects. Fix the retrieval foundation before adding more maps or tightening reviewer instructions. The appropriate objective is fewer repeated input tokens and fewer unnecessary retrieval steps at the same review quality, model, and reasoning effort.

## What the actual usage shows

Read-only inspection of the local Orchestra `provider_runs` and `task_events` tables confirmed the reported consumption. Example review rows:

| Run start, UTC | Input | Cached input (included in input) | Uncached input | Output | Total |
|---|---:|---:|---:|---:|---:|
| Sep 8, 03:25 | 395,543 | 334,848 | 60,695 | 1,784 | 397,327 |
| Sep 8, 03:20 | 430,856 | 382,464 | 48,392 | 2,493 | 433,349 |
| Sep 7, 18:14 | 2,376,032 | 2,280,832 | 95,200 | 8,584 | 2,384,616 |

The latest review has nine usage snapshots. Their successive request input counts are 28,198; 29,475; 39,284; 42,477; 48,498; 49,733; 50,972; 52,826; and 54,080. These sum to 395,543. Its last reported context is 54,292 tokens, about 21% of its reported 258,400-token window. Thus 397K is cumulative processing across a turn, not a single 397K context window or 397K newly generated tokens.

The main target is repeated context: the initial input is already 28K, and additional context accumulates through the turn. Removing an unnecessary early retrieval can save its initial input plus its repeated inclusion in subsequent requests. These snapshots do not establish which individual retrievals were unnecessary; the existing logs do not preserve sufficient per-tool size and provenance information to attribute that precisely.

[Codex usage normalization](../../orchestra-dashboard/server/codex-app-server.ts) already separates cumulative `total` usage from `last` context usage. [ProviderRunRecorder](../../orchestra-dashboard/server/application/usage/provider-run-recorder.ts) replaces its usage snapshot rather than summing every cumulative notification. There is no evidence here that the 397K result is simply a cumulative-notification double-counting bug.

Cached input still represents processed context. Do not interpret these numbers as an account charge or convert them to subscription quota savings using API pricing. OpenAI documents API prompt-cache behavior separately; savings for this account require observing its own usage metering. See [official prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) and [Codex App Server events](https://learn.chatgpt.com/docs/app-server).

## Confirmed problems

### 1. The installed Windows binary misses changed files and ignored paths

**Implemented:** Ripwire now normalizes `\\`/`/` and leading `./` consistently at Git joins, ignore membership, graph path matching, and qualified selectors. The new `test/windowspathcheck.sh` fixture covers ignored directories, dirty tracked files, forward-slash selectors, and native Windows selectors. The rebuilt binary and the Orchestra diagnostic now pass all four compatibility checks.

Local source checkout: `F:\Ripwire\ripwire-0.5.0\ripwire-0.5.0`, branch `port/windows-native`, commit `dbb99f83` at inspection. Installed binary reports:

```text
ripwire 0.5.0 (Debug, Clang 22.1.8, built_from=bacfa3b7b+dirty)
```

The executable and checkout therefore cannot be assumed to have identical behavior.

An isolated, newly initialized Git fixture has one tracked TypeScript function changed after its initial commit, plus two ignored directories containing duplicate functions. With the installed executable:

- `--situ` reports zero changed files and describes the working tree as clean despite its own `+dirty` marker.
- Bare `--test-gate` reports `changed="0"` and exits successfully.
- `--skipped` reports `ignore_mode="git"` but does not exclude the two ignored directories.
- `--expand=src/demo.ts:demo` fails. `--expand=.\src\demo.ts:demo` succeeds.

These are reproduced compatibility failures, not merely low-confidence rankings. Similar source/generated duplication appeared in the Orchestra map. A separate fixture confirmed that changing the crawl root between `.`, an absolute forward-slash path, and an absolute backslash path did not fix ignored-directory filtering.

The repair normalizes the identities used by Git, filesystem traversal, selectors, and graph lookups. Git emits forward-slash paths while maps emit Windows paths. An earlier shell-quoting hypothesis was not established: the checkout's `shSingleQuote` already has a Windows branch.

Do not use a successful process exit or `changed=0` as evidence that a dirty change needs no review or tests. Cross-check report coverage against Orchestra's independent Git manifest.

### 2. Orchestra supplies the wrong task-map budget flag

**Implemented:** Orchestra now passes `--token-budget=N` to `--for` and does not append `--no-ignore`. The wrapper test asserts the command shape and runs the task map against a temporary Git fixture.

[server/ripwire.ts](../../orchestra-dashboard/server/ripwire.ts), lines 71–90, uses `--for=... --max-tokens=N`. The executable explicitly warns that ordinary `--for` does not read `--max-tokens`. The supported shaping flag for this lens is `--token-budget=N`.

On Orchestra, the requested 2,000-token map emitted 11,229 bytes, estimated by Ripwire at 4,492 tokens. A probe combining `--token-budget=2000` with explicit exclusion of generated `dist-server` and audit scratch paths emitted 4,557 bytes / 1,823 estimated tokens and no `dist-server` matches: 59.4% fewer bytes for that map. This comparison changes both filtering and budgeting; it is not an isolated causal estimate for either change and is not an end-to-end model quality benchmark.

Different verbs have different budgeting semantics. Do not mechanically append `--max-tokens` or `--token-budget` to every report. Test each verb's shaping, gating, and disclosure behavior against the pinned executable.

### 3. Useful nonzero report exits are discarded

**Implemented:** The wrapper accepts only the documented informative exits (`--test-gate` 4 and `--quality-delta` 2), preserves their stdout, and labels them as `findings`. Other failures still degrade to ordinary evidence. Review telemetry records the verb and exit code.

`runRipwire` returns null for every nonzero exit (`server/ripwire.ts:62`). Ripwire's local command documentation specifies:

| Verb | Informative exit | Meaning |
|---|---:|---|
| `--test-gate` | 4 | Test obligations or untested impact remain |
| `--quality-delta` | 2 | Major, unacknowledged regression in an existing symbol |

Preserve these report payloads as findings, while keeping genuine execution errors, invalid requests, cancellation, and timeouts separate. Acceptance must be verb-specific and validate the report, not accept all nonzero stdout. The exit contract is documented in the local source; the Windows changed-file failure prevented the minimal fixture from demonstrating a meaningful obligation report.

### 4. One explicit cache file defeats Ripwire's lean/rich separation

**Implemented:** Orchestra stores root-hashed caches under the system temporary directory, with separate `lean` and `rich` files. `--for` and `--pr-context` use the rich family; situational, quality, and test-gate reports use lean. The integration test exercises rich → lean → rich without a parser-version rejection.

Every Orchestra wrapper invocation uses `<root>/.ripwire.lean.ripwirecache`, regardless of verb. The filename does not make its contents lean. Ripwire's auto-cache deliberately separates parser families; explicitly using one file bypasses that separation.

A sequential fixture reproduced `--for` → `--expand` → `--for` rejecting the shared cache at both family switches. Each rejection reports full reparsing. The same probes using separate rich and lean cache files had no rejection. Source explanation: Ripwire `src/main.cpp` near `defaultCachePath` and `src/ingest_cache.h` near `parserVerFor`.

Keep caches outside the reviewable source tree and use the executable's supported family separation. Prefer its auto-cache once Windows cache-directory behavior is verified, or a tested explicit per-root/per-family cache policy. Prewarm required families once. Avoid concurrent cold processes contending over one cache; do not build a new long-lived cache of analysis results without content-based invalidation.

The review stage starts three probes concurrently and runs quality/test probes again before repair on essentially the same source state. Reuse validated results for the identical snapshot and recompute after mutation. This mainly saves local time; token savings depend on avoiding duplicate report injection too.

### 5. Existing prompt guidance disables a useful optimization

**Implemented:** Agent guidance now permits qualified `path/to/file:Symbol` selectors when names are ambiguous and explains why `--top-k=0` is appropriate for a targeted body. It no longer forbids the selector form Ripwire itself emits.

[agent-prompt-context.ts](../../orchestra-dashboard/server/application/context/agent-prompt-context.ts) requires bare symbols, forbids `FILE:SYMBOL`, and always recommends `--top-k=0` for expansion. Ripwire supports qualified selectors and, absent explicit `--top-k`, can choose the smaller of the requested bundle and its containing file.

The verified fixture returned the same requested function in 224 bytes (58 estimated tokens) with native qualified expansion, versus 1,191 bytes (303 estimated tokens) with forced `--top-k=0`: 81.2% fewer bytes. This is a tiny-file example, not a repository-wide savings forecast.

Use qualified selectors after fixing/normalizing Windows paths, ideally copying a verified selector from the map. Let automatic representation choice work for normal exact requests. Preserve explicit payload-only or body-slice selection when needed. Bare names can return multiple unrelated definitions, including generated duplicates.

### 6. Ripwire is often additive context instead of a replacement for retrieval

**Implemented in this pass:** Review and repair now reuse the same Ripwire quality/test evidence when the snapshot is unchanged. Situational and test-gate calls receive Orchestra's authoritative changed-file manifest, so ignored or path-spelling mistakes cannot silently change review scope. Full packet compaction and snapshot-aware evidence records remain follow-up work.

[Stage 7](../../orchestra-dashboard/server/application/tasks/pipeline/7-review-audit-stage.ts) gets the original-base diff on every cycle, adds local triage and implementation summary, then appends quality, test, and situational reports. [The review envelope](../../orchestra-dashboard/server/application/context/review-prompt-envelope.ts) cuts those reports to 3,000 / 2,000 / 3,000 characters using head/tail truncation.

This can preserve a long legend while cutting useful middle rows, break structured output, and require follow-up retrieval. The prior review is also truncated to 3,000 characters, which can lose unresolved findings. Source diffs are initially bounded at 80,000 characters and the final envelope at 48,000; omitted evidence needs explicit retrieval references and coverage tracking.

Ripwire report estimates use `text.length / 4`, while the review envelope uses `/ 2`; neither is a measured model-token count. Prefer Ripwire's own estimate when present, mark fallbacks as estimates, and use provider telemetry to evaluate actual consumption.

### 7. Review scope and Ripwire baseline are not aligned

**Implemented in this pass:** `--situ` and `--test-gate` receive the same changed-file list used by the review diff. `--quality-delta` remains a working-tree report; it is intentionally not presented as a committed `baseSha..HEAD` comparison.

The reviewer receives a diff against `reviewBaseSha`. The supplied `--situ`, `--test-gate`, and bare `--quality-delta` use their own default change/baseline rules. Changes committed since the original base can consequently be absent from those reports.

`runRipwirePrContext(root, baseSha)` exists but has no caller. Wire base-aware context only after its Windows behavior is tested. Use the authoritative changed-file manifest for explicit impact/test selection, including staged, unstaged, untracked, deleted, and renamed paths. Critically, `--quality-delta=A..B` compares committed trees; it does **not** include uncommitted repairs. Keep committed-range and working-tree evidence distinct, or analyze materialized snapshots with explicitly defined baselines. Do not make automatic commits merely to satisfy the tool.

### 8. Availability and timeout reporting hide the problem

**Implemented in this pass:** The wrapper timeout is 60 seconds to cover measured Windows cold scans, and accepted reports retain stderr, exit code, and status for telemetry. Availability remains a reachability check; a controlled task replay is still needed to measure wall-time effects.

Capability detection checks executable existence, not whether it can map the active repository correctly. Errors and stderr warnings disappear into `null`. Several full-repository probes took roughly 29–37 seconds, against a 30-second wrapper timeout. Later runs also showed cache-family rejection. Timing varied, and some exploratory probes overlapped; these measurements demonstrate timeout exposure, not a controlled speedup or an attribution of all latency to Debug compilation.

Pin a tested Release executable and its build identity, but do not assume Release compilation alone fixes correctness. Record successful, findings-bearing, partial, unavailable, timeout, and failed probes separately. A healthy map requires compatible behavior and coverage, not just a reachable binary.

## Recommended integration

Use Ripwire as the first layer of a progressively expandable evidence service. Give both models the same retrieval mechanism; let the orchestrator perform indexing and cache writes outside Codex's read-only review session.

| Step | Evidence served | When to expand |
|---|---|---|
| Orient | Short task-specific symbol/path map and coverage warnings | Low confidence or relevant paths missing |
| Inspect | Changed function body, exact diff hunks, imports and nearby contracts | An invariant depends on other code |
| Trace impact | Callers, callees, uses, tests, relevant config/routes | Dynamic wiring or unresolved graph edges |
| Repair | Stable finding IDs, exact prior evidence, repair delta, verification results | Finding remains unresolved or repair changes scope |
| Re-review | Repair delta plus unresolved findings and impacted contracts | Broader changes invalidate prior evidence |

Useful existing Ripwire capabilities include `--for`, `--expand`, `--outline`, `--callers`, `--callees`, `--uses`, `--impact`, `--recall`, `--from-trace`, `--pr-context`, and coverage diagnostics such as `--skipped`. Consider its batch or read-only MCP support after compatibility testing; do not expose every tool merely because it exists. A small typed retrieval interface can normalize paths, share caches, retain diagnostics, and avoid repeated shell-discovery failures without adding a large tool catalog to every prompt.

Each response should identify repository/snapshot, query, paths/symbols shown, total/shown/capped counts, relevant ambiguity/unresolved indicators, and how to obtain omitted evidence. Use content hashes including working-tree and untracked file content, not HEAD alone, to validate reuse. Never hash only a truncated diff to establish full snapshot identity.

Keep exact source and complete diff artifacts retrievable. Select complete records within a packet; avoid slicing XML and source hunks at arbitrary character offsets. Preserve acceptance criteria and all unresolved findings as structured records, rather than repeatedly summarizing or tail-cutting them. Quality scores remain advisory: a complexity report is not a correctness review and a static graph is not complete for dynamic dispatch, callbacks, generated code, reflection, or external contracts.

The existing Codex review prompt restricts inspection until there is a specific finding at a precise line. That is too restrictive for discovering missing behavior. Replace it with a retrieval order and coverage obligations, allowing broader inspection whenever evidence is incomplete. Keep the same model and reasoning effort. Keep required deterministic verification and independent final review.

Do not blindly resume all Codex reviews into a growing thread: current review calls intentionally start fresh ephemeral threads, while Antigravity repairs can reuse a conversation. First make the evidence handoff complete and compact. Then compare fresh review packets with a short-lived reviewer thread plus snapshot-aware repair deltas; choose based on actual tokens, time, and missed defects. Preserve independence from builder assertions in either design.

## Implementation order and acceptance gates

1. **Repair and pin native compatibility.** The cross-platform normalization fix, fixture gate, and rebuilt debug binary are complete. Worktree, non-ASCII, deletion/rename, and Release-build coverage remain useful hardening gates.
2. **Correct Orchestra's wrapper.** Verb-specific shaping, informative exits, default Git-ignore behavior, separate caches, manifest-aligned impact/test probes, diagnostics, and a wrapper integration test are complete. A failure still degrades to ordinary evidence rather than a clean bill of health.
3. **Replace repeated discovery with evidence retrieval.** Review/repair reuse unchanged deterministic reports and agent guidance now supports exact selectors. Structured snapshot records, omission navigation, and a controlled end-to-end token/quality comparison remain the next phase. This is where the largest model-token savings should come from, but the magnitude remains unmeasured.
4. **Measure controlled end-to-end results.** Replay a fixed set of representative tasks at the same starting commit, model, reasoning effort, and verification requirements. Include known seeded defects and integration/configuration changes. Compare verdict correctness, missed blockers, false positives, repair-cycle count, first-request input, cumulative input, cached/uncached input, output/reasoning, tool calls/output sizes, compactions, Ripwire failures, and wall time. Preserve individual run results and repeat enough tasks to distinguish variance from improvement. Deploy only with acceptable quality parity and measured consumption improvement.

For the latest 397K review, the first comparison should ask whether the 28K starting input and subsequent growth to 54K can be reduced while detecting the same defects. Do not promise a fixed percentage from Ripwire's retrieval benchmarks or lower model effort to manufacture the result.

## Reproduce

Added [probe-ripwire-context.mjs](../../orchestra-dashboard/scripts/probe-ripwire-context.mjs). It uses only local subprocesses, creates a temporary Git fixture, writes no target-repository changes, retains its scratch directory for inspection, and optionally writes JSON. It does not contact models or modify either installed binary.

```powershell
node orchestra-dashboard/scripts/probe-ripwire-context.mjs --exe F:/Ripwire/ripwire-0.5.0/ripwire-0.5.0/build/ripwire.exe --out .cache/ripwire-audit/contract-report.json
```

Add `--root F:/orchestra` for sequential full-repository budget/cache measurements. The optional repository probe measures the specified map only; it is not a model-quality evaluation. Exit 1 means a compatibility check failed.

Before the fix, the installed binary reported: ignored-path check **failed**; changed-file detection **failed**; forward-slash selector **failed**; native qualified selector **passed**. After rebuilding the patched source, the same diagnostic reports all four checks **true**. Its cache-switch probes still show rejection only when deliberately forcing one shared cache across lean/rich verbs; Orchestra now uses separate family paths.

## Sources and limits

- Orchestra source files linked above and local read-only database telemetry; no raw user prompts are included in this report.
- [Ripwire Windows branch](https://github.com/frankr2994/ripwire/tree/port/windows-native), inspected through the local checkout because the supplied GitHub page could not be fetched. The local `README.md`, `docs/COMMANDS.md`, cache implementation, and CLI experiments were the authoritative evidence for this investigation. Remote branch parity was not verified.
- [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server) for thread usage and per-item notification capabilities; [prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching) for the distinction between cached processing and API cache behavior.
- No claim of equal end-to-end model quality, quota reduction, or production speedup has yet been demonstrated. Runtime fixes and the controlled evaluation above remain implementation work. The measured retrieval savings and compatibility failures are reproducible starting points for that work.
