# Codex independent review automation research

Research date: 2026-08-22

## Overview

Commit `1dc1d32` adds a useful read-only Codex review prototype, but reliable automated gating needs an exact-SHA workspace, schema-constrained output, defensive semantic validation, durable raw evidence, accurate execution metadata, and explicit cancellation/failure states. The current implementation can return PASS alongside a parsed blocking finding and can lose the diff and reviewer instructions through packet truncation.

## Research purpose

Compare the commit's Codex invocation, evidence packet, output parsing, and persistence with current official OpenAI automation guidance and the independent-review requirements in `julesplan.md`.

## Research findings

### Read-only automation

Official OpenAI documentation identifies `codex exec` as the non-interactive automation surface and states that it runs read-only by default. It also documents explicit sandbox selection. The repository's shared app-server runner requests `approvalPolicy: never`, an ephemeral thread, and a read-only/no-network sandbox, which is directionally appropriate.

That sandbox does not by itself bind the reviewer to the intended PR commit. The caller must set the review root to a worktree at the exact persisted head SHA and validate that identity before invocation. The reviewed helper accepts arbitrary SHA strings, a caller-provided diff, and an ordinary `projectRoot`, with no durable correlation.

### Machine-readable review output

Official OpenAI automation guidance documents JSON Lines for event consumption and `--output-schema` when downstream systems require stable fields. The Phase 21 plan likewise requires structured severity, file/location, explanation, evidence, recommendation, and blocking status.

The implementation instead asks for Markdown and parses single-line bullets with regular expressions. A probe supplied `VERDICT: PASS` plus a `[BLOCKING]` finding; the parser returned `verdict: PASS`, `blocked: false`, and a blocking finding. Schema-constrained output followed by runtime validation and semantic consistency checks would prevent this contradictory gate result.

### Packet bounds and untrusted content

Bounded inputs are necessary, but each section must have an independent budget and explicit truncation metadata. The current implementation builds variable-size sections and then slices the whole packet to 100,000 characters. A probe with long legal input entries removed the entire diff and final reviewer instructions while still producing a syntactically ordinary packet.

The packet also omits the Jules plan and applicable repository instructions required by the implementation plan. Its provider-oriented redactor recognizes only a few token patterns. A probe confirmed that an `sk-proj-...` credential remained in the packet. File names, verification command labels, base/head strings, and Markdown boundaries are not normalized or escaped.

### Audit and execution identity

Official documentation notes that non-interactive runs can expose machine-readable events and the final response, and that automation credentials must be isolated from untrusted code. Orchestra additionally needs to persist its own review aggregate: exact head/base SHA, review cycle, requested and actual model, execution/thread identity, packet/artifact hashes, structured findings, raw final text, verification linkage, and failure/cancellation state.

The current event records only verdict, blocked, requested model, finding count, and a 500-character summary. Raw output is merely returned to the caller, Store is optional, and no production caller exists at the reviewed commit.

## Evaluation

| Area | Evaluation | Notes |
| --- | --- | --- |
| Codex permissions | Partially sound | Shared runner requests read-only/no-network execution |
| Exact commit binding | Missing | Arbitrary strings and ordinary project root are accepted |
| Packet completeness | Incomplete | Jules plan and repository instructions are absent |
| Packet bounds | Unsafe | Global slicing can remove diff and reviewer instructions |
| Secret handling | Incomplete | Common credential formats and unescaped fields remain |
| Output contract | Unsafe | Markdown regex parsing permits contradictory PASS results |
| Audit persistence | Missing | Raw output, SHA, findings, cycle, and execution identity are not stored |
| Lifecycle integration | Missing | No production caller or crash-recoverable review state exists |

## Conclusion

Treat the module as partial Phase 21 work rather than completed Phase 12. Run Codex read-only in the exact immutable review worktree, use a strict output schema and runtime validation, fail closed on every contradictory or incomplete result, and persist a versioned review aggregate before any task transition. Budget and hash packet sections independently and use a general secret-scanning policy rather than a small provider-token regex list.

## References

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/developer-commands

## Related repair items

See R-086 through R-093 in `repair.md`.
