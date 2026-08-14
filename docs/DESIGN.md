# Antigravity Orchestra Design

## 2026-08-12: Project-scoped Tri-Agent Command Center

### Background

The original repository exposed Antigravity and Codex through CLI workflows. The dashboard must provide one local interface where a user selects a repository, submits natural-language work, observes agent activity, and receives verified Git commits without manually opening a terminal in that repository.

### Decision

Use a Windows-first localhost application composed of a React/Vite client and a TypeScript Express service. Persist projects, sessions, tasks, events, and Git state in a local SQLite database. A selected canonical project directory is first-class session state and is the working directory for every subprocess.

Agent responsibilities are fixed:

- Antigravity is the primary orchestrator and only code-changing agent.
- Codex performs read-only design, debugging, test-design, and independent review.
- `gemma-4-e2b-it-qat`, served by LM Studio, classifies requests and generates handoff/commit summaries.

The backend chooses model tiers automatically. Routine work uses Gemini 3.6 Flash; sensitive or deeply complex work escalates to Gemini 3.1 Pro. Codex uses Luna for focused analysis, Terra for normal implementation support, and Sol for deep or sensitive work.

Task execution is persisted as:

```text
queued → routing → preflight → running → reviewing → verifying
       → summarizing → committing → pushing → completed
```

Dirty repositories pause mutating tasks at `baseline_required`. Existing changes are summarized and committed separately before onboarding or task changes. Successful task changes are reviewed, verified, summarized into the tracked `docs/HANDOFF.md`, committed with explicit paths, and pushed to the existing upstream. Failed pushes remain recoverable local commits.

### Reasons

- CLI processes retain their existing authentication, skills, rules, and sandbox behavior.
- Project-scoped working directories prevent cross-repository edits and eliminate manual CLI launching.
- SQLite gives restart-safe local history without introducing an external service.
- Server-Sent Events fit one-way, resumable agent activity streaming.
- Explicit Git file lists protect unrelated user changes and ignored artifacts.
- Automatic model tiers balance latency and capability without requiring model knowledge from the user.

### Alternatives

- Electron: rejected for the first version because a localhost service and PowerShell folder picker provide the required native integration with less packaging overhead.
- Direct provider APIs: deferred because the installed CLIs already encapsulate authentication, project instructions, and tools.
- Running all three models on every request: rejected because Codex is unnecessary for routine work and Gemma cannot safely replace the primary agent.
- Automatic force-push or upstream creation: rejected because it can publish to an unintended branch or rewrite remote history.

### Impact

- The dashboard requires Windows, Node.js 24+, Git, authenticated `agy` and Codex CLIs, and LM Studio on port 1234.
- Selected projects receive versioned Orchestra configuration. Conflicts are backed up under ignored `.orchestra/backups/` before replacement.
- Dashboard state lives under `%LOCALAPPDATA%\AntigravityOrchestra` rather than inside project repositories.
- Provider quota cards show unavailable unless a trustworthy machine-readable source exists; values are never fabricated.

## Historical design: demo-todo

The earlier `examples/demo-todo` design was a workflow dogfooding exercise. It remains independent of the Command Center and is not part of the dashboard runtime architecture.

## 2026-08-13: Evidence-bounded Gemma-first routing

### Background

The local `gemma-4-e2b-it-qat` model was limited to short classification and commit-summary calls even though LM Studio provides a 131,072-token context window. Routine repository questions therefore incurred a remote Antigravity run, and remote answers could overstate planned or opaque behavior without a local evidence check.

### Decision

Use Gemma as the first responder for deterministic, non-mutating, small repository questions. The backend—not the model—collects a path-validated evidence packet capped at approximately 120,000 characters, excluding common generated, binary, secret, and agent-backup paths. The packet prioritizes root documentation, build manifests, prompt-relevant paths, and source files.

Gemma may answer directly only when the deterministic eligibility policy permits local handling and its structured response reports confidence of at least 0.86 with cited evidence files. Otherwise the task escalates to the existing Antigravity/Codex policy. The backend adds the authoritative root label rather than trusting the model to reproduce it.

All structured Gemma calls use LM Studio's `json_schema` response format with task-specific schemas; prompt-only requests for JSON are not treated as a reliable contract at large context sizes.

For escalated read-only work, Gemma performs a postflight comparison against the same evidence packet. Only a concrete `block` verdict at confidence 0.90 or higher prevents delivery; lower-confidence concerns are attached as local validation notes. Deterministic root validation remains independent of the model. Local citations are normalized from repository-relative paths, absolute Windows paths, and `file:///` URIs before the answer acceptance gate runs, and accepted citations must point to files whose contents—not merely names—were included in the packet. Generic repository overviews rank embedded `.agents`/`.codex` metadata below project documentation, build files, and source. A high-confidence draft that fails deterministic completeness or citation checks receives one local repair attempt before escalation. Postflight output is normalized so only actionable errors or corrections can produce warnings; corroborating observations are discarded.

Questions that inherently require live tools—such as commit-history or author queries—bypass Gemma's static repository-evidence answer path and go directly to the configured tool-capable agent. If Antigravity emits a complete, correctly scoped final response for a read-only task and subsequently reports a non-success terminal status, Orchestra preserves the response and records a visible warning. File-changing Antigravity runs remain fail-closed on every non-success terminal status.

The dashboard token is intentionally process-scoped and rotates when the backend restarts. The browser client treats a `403` from an authenticated API request as a possible rotation, obtains a fresh token from the loopback-only bootstrap endpoint, and retries the rejected request once. Authentication middleware runs before mutation handlers, so this retry cannot duplicate a partially executed operation.

Conversation summaries are persisted on sessions and refreshed locally when unsummarized history exceeds 8,000 characters or an unsummarized conversation reaches eight messages. Recent verbatim messages remain available alongside compact memory.

### Reasons

- Local answers reduce latency, provider usage, and exposure of routine repository content.
- Backend-controlled retrieval prevents the model from escaping the selected project or scanning unrelated drives.
- Ranked evidence is more reliable and efficient than filling the entire nominal context window.
- Confidence thresholds and deterministic eligibility preserve escalation for edits, runtime work, external research, design, debugging, review, tests, and sensitive requests.
- Postflight validation addresses wrong-repository and implemented-versus-planned errors without making a small local model the sole authority.

### Alternatives

- Give Gemma unrestricted filesystem tools: rejected because a small local model should not define or enforce its own project boundary.
- Send the entire repository into the 131k window: rejected because generated files, secrets, irrelevant content, prefill latency, and lost-in-the-middle effects reduce safety and quality.
- Replace Antigravity/Codex for all tasks: rejected because complex reasoning, code changes, independent review, and runtime verification still require their tools and stronger models.
- Treat every Gemma warning as blocking: rejected because local-model uncertainty would create excessive false failures.

### Impact

- Simple read-only questions can complete entirely through LM Studio and appear in chat as Gemma responses.
- Task model metadata records whether Gemma or Antigravity was primary.
- Sessions gain persistent local summary fields through an additive SQLite migration.
- Large repositories incur a bounded synchronous evidence scan before non-mutating work.
- If LM Studio is unavailable, malformed, or insufficiently confident, tasks continue through the previous remote-agent workflow.

## 2026-08-13: Git baselines for greenfield projects

### Background

Project onboarding previously installed Orchestra configuration into a blank, non-Git directory and marked it ready without initializing a repository. Mutating-task review, verification, handoff, and finalization depend on Git dirtiness, so a greenfield implementation could bypass those phases entirely. Git-operation audit logging also had an incorrect SQL placeholder count that could fail after a successful commit.

### Decision

Treat a directory as greenfield only when it is blank or contains exclusively Orchestra-managed bootstrap entries (`AGENTS.md`, `.agents`, `.codex`, `.gitignore`, and `.orchestra`). Onboarding initializes such a directory as a `main` branch Git repository, commits the Orchestra bootstrap as a clean baseline, updates the stored Git root, and records the operation. Existing non-Git directories containing application files are never initialized implicitly.

Before any mutating task, Orchestra must confirm that the selected project is a Git repository. An eligible Orchestra-only directory is repaired automatically; any other non-Git directory fails preflight with setup instructions. The task also fails closed if Git disappears before post-implementation review.

### Reasons

- Git is the boundary used to distinguish pre-existing work from agent changes.
- Codex review and project verification require a reliable change set.
- A clean initial commit makes the first application implementation reviewable and recoverable.
- Restricting automatic initialization to managed-only directories avoids surprising users by creating repositories around existing files.

### Alternatives

- Allow non-Git mutations and inspect timestamps or directory snapshots: rejected because those mechanisms are less reliable for review, rollback, and explicit commits.
- Initialize every selected non-Git directory: rejected because existing folders may be intentionally unmanaged or may contain unrelated material.
- Require users to initialize even completely blank projects manually: rejected because greenfield setup is a normal, deterministic onboarding responsibility.

### Impact

- New blank projects begin on `main` with a clean `chore: initialize Orchestra` baseline.
- Projects without an upstream retain the baseline locally and report an unpushed state without blocking implementation.
- Existing non-Git application directories remain usable for read-only questions but cannot run file-changing tasks until the user creates a clean Git baseline.
- Git-operation audit entries now persist successfully for onboarding, baseline, and task commits.

## 2026-08-13: Recoverable agent timeouts

### Background

Antigravity can internally start asynchronous commands or scheduled waits. In one greenfield run, implementation and verification finished in approximately seven minutes, but an orphaned scheduled wait kept the CLI process alive until Orchestra's 20-minute hard timeout. Orchestra then discarded the model's completion state, skipped Codex review and finalization, and left partial task changes indistinguishable from an ordinary dirty baseline.

### Decision

Antigravity prompts explicitly require synchronous verification and prohibit background tasks, scheduled waits, watch/development servers, and commands that remain running. Orchestra gives the CLI's own 20-minute print timeout a one-minute process grace period and preserves partial stdout/stderr in a typed timeout error for diagnostics.

When any mutating task fails while its Git worktree is dirty, its state becomes `recovery_required`. Those changes remain owned by the failed task. A recovery action reruns the same task with an explicit continuation prompt, allows that task to work on its own uncommitted files, and then proceeds through normal Codex review, verification, handoff, commit, and push. The baseline workflow is not used for recovery changes.

All baseline detection, recovery detection, review-trigger checks, and final commit path lists exclude `.orchestra/`. This directory is process-local runtime state, never project work, even if a generated scaffold temporarily overwrites the managed `.gitignore`. A tracked `.orchestra` file from an older faulty baseline must be untracked as maintenance rather than repeatedly committed as a baseline change.

### Reasons

- Agent-created partial work must not be silently discarded or misclassified as user-authored baseline work.
- Preventing long-lived commands addresses the observed root cause earlier than increasing timeouts.
- A short grace period lets the CLI serialize its own terminal status before Orchestra terminates the process.
- Resuming the original task preserves intent and keeps the eventual commit and audit trail coherent.

### Alternatives

- Increase the hard timeout indefinitely: rejected because orphaned background tasks may never terminate.
- Automatically commit partial work on failure: rejected because it has not passed independent review or verification.
- Delete partial changes and restart: rejected because deletion is destructive and can waste valid implementation work.
- Send a new task through normal preflight: rejected because the dirty-worktree guard would correctly classify the files as a baseline, losing ownership of the failed attempt.

### Impact

- Failed mutating tasks with changes show a recoverable state and Resume control.
- Historical failed mutating tasks can also request recovery when their project still has uncommitted changes.
- Read-only failures and failures with a clean worktree remain ordinary failed tasks.
- User cancellation remains distinct from failure recovery and does not automatically resume work.
- Runtime metadata changes under `.orchestra/` cannot trigger or contaminate project baselines, task recovery, or final commits.
- Baseline resolution is valid only while a task is exactly `baseline_required`; repeated or stale clicks cannot relabel a running task or enqueue it twice.
- Project activation asks the backend for the actual lock-owning task and opens that task's conversation, even when the user navigated from a different conversation containing a queued duplicate.
- Failed tasks with a clean worktree expose Retry; failed mutating tasks with owned dirty changes expose Resume. New task submission is rejected while any task is active or queued for that project, preventing hidden cross-conversation queues.

## 2026-08-13: Codex review invocation contract

### Background

Codex CLI 0.147.0 rejects a custom positional prompt when `codex exec review --uncommitted` is used. Orchestra passed its required verdict instructions through stdin as the positional `-`, so the review process exited before inspecting the changes. The error formatter then selected the generic `For more information, try '--help'.` footer instead of the actionable parser error, causing a successfully implemented task to enter recovery with an opaque explanation.

### Decision

Automated change review uses the standard `codex exec` command in a read-only sandbox, with the project root supplied through `-C` and explicit instructions to inspect all staged, unstaged, and untracked changes. The prompt continues to require a machine-readable `VERDICT: PASS` or `VERDICT: BLOCK` prefix. Codex CLI failures prefer an explicit `error:` diagnostic over usage and help footer lines.

### Reasons

- Standard `codex exec` accepts stdin instructions and provides the same repository-inspection tools used successfully by Orchestra's design and debugging passes.
- The explicit verdict contract is required by the repair loop and is not guaranteed by the dedicated review command's built-in response format.
- Read-only sandboxing preserves the independent-review role boundary.
- Actionable diagnostics make recovery states understandable and debuggable.

### Alternatives

- Use `codex exec review --uncommitted` without a custom prompt: rejected because Orchestra would lose its stable verdict contract.
- Parse the dedicated review command's default prose heuristically: rejected because absence of findings and formatting changes are not a reliable pass signal.
- Continue combining `--uncommitted` with stdin and special-case the error: rejected because the installed CLI explicitly disallows that argument combination.

### Impact

- Preserved task changes can proceed through Codex review without the CLI parser failure.
- Review remains read-only and scoped to the authoritative selected project.
- Future Codex command failures display the substantive parser diagnostic rather than only a generic help hint.
- Recovery submission is idempotent while that same task already owns the project: duplicate browser requests return the current task instead of surfacing a false recovery failure. The client also marks recovery optimistically and uses a per-task in-flight guard so the Resume control disappears before the network round trip completes.

## 2026-08-13: Progress-aware repair and observable runs

### Background

Orchestra previously allowed exactly two Codex review cycles per execution. Any remaining finding forced the task into `recovery_required`, even when Antigravity was making useful progress. Users had to repeatedly press Resume without a persistent view of the current agent, activity recency, verification status, changed files, or reason for pausing. Development-server restarts could also convert an interrupted dirty mutation into an ordinary failed task, hiding the safe recovery path.

### Decision

Use a bounded, progress-aware review loop. A mutating task may perform up to six automatic Antigravity repair attempts after Codex blocks it. Each attempt records whether the project diff changed and fingerprints the normalized blocking findings. Orchestra pauses early when the same findings recur after a repair that made no project changes, and pauses at the overall attempt bound when a genuinely different approach or user decision is required. Recovery runs pass the prior stop reason directly to Antigravity and skip the redundant preliminary Codex design pass; independent post-change Codex review remains mandatory.

Expose a deterministic run-monitor snapshot for every task. It reports phase, responsible agent, phase and task elapsed time, last activity, direct process ownership, review and repair counts, changed project files, health, and an explicit stop reason. Health is derived from process and event timing: active under 90 seconds of silence, waiting under five minutes, and possibly stalled after five minutes or when an active state has no process owner. A full-width dashboard panel polls this snapshot every five seconds and retains a bounded event timeline. Gemma can translate a sanitized snapshot into plain language on demand, but deterministic health remains authoritative and Gemma cannot stop or resume tasks.

On backend startup, interrupted mutating tasks with non-Orchestra Git changes are reconciled to `recovery_required`; clean or read-only interrupted tasks remain failed.

### Reasons

- Useful repair progress should continue without repetitive user approval.
- Repeated findings plus an unchanged diff is a concrete impasse signal, unlike an arbitrary count of two reviews.
- A finite attempt ceiling still prevents unbounded provider usage and agent loops.
- Process ownership and event age distinguish normal quiet work from likely stalls without relying on model judgment.
- A dedicated monitor keeps verbose operational detail out of the chat scroll while making the workflow inspectable.
- Restart reconciliation preserves task ownership and prevents agent changes from being mistaken for a user baseline.

### Alternatives

- Run repairs indefinitely: rejected because persistent semantic disagreement or a broken tool could consume resources without converging.
- Keep the two-cycle limit and require Resume: rejected because it externalizes ordinary orchestration bookkeeping to the user.
- Let Gemma autonomously classify stalls and terminate processes: rejected because model interpretation is not a safe authority for destructive lifecycle actions.
- Stream raw subprocess commands and protocol events into chat: rejected because it leaks implementation detail, can expose sensitive arguments, and recreates the scrolling failure the monitor is meant to solve.

### Impact

- Ordinary Codex findings can flow through multiple Antigravity repairs without user interaction.
- `recovery_required` now indicates an actual bounded impasse, restart recovery, or execution failure with preserved changes—not every second review.
- The dashboard visibly distinguishes active, waiting, possibly stalled, needs-attention, complete, and failed states.
- Users can inspect recent sanitized activity, changed paths, review progress, and stop reasons from the main dashboard and optionally ask local Gemma for an explanation.
- The Stop action remains user-controlled; the monitor never terminates a process automatically.
