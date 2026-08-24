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
## 2026-08-13: Supported agent observability and grounded local interpretation

### Background

The dashboard could report process liveness and Orchestra workflow events, but it could not explain the concrete reason for a repair cycle or make trustworthy context/quota-aware routing choices. Raw console output and guessed percentages are not sufficient.

### Decision

Orchestra will normalize provider telemetry behind one internal observability model:

- Antigravity per-run tokens and lifecycle come from its non-interactive `stream-json` output. Context and quota may additionally come from a fresh, matching supported status-line JSON snapshot produced by an interactive CLI session.
- Antigravity step detail comes from bounded, sanitized transcript JSONL reads correlated by conversation ID.
- Codex turn usage comes from the existing supported `codex exec --json` stream.
- Codex account quota and usage summaries come from a cached, read-only `codex app-server` JSON-RPC client.
- Gemma receives only a bounded evidence packet made from deterministic monitor state, normalized task events, provider telemetry, and sanitized transcript summaries.
- Context and quota policy may select a cheaper model or start a fresh Antigravity conversation, but it may not skip a required design/debug/review role.

### Reasons

- Supported machine-readable interfaces are more stable and safer than TLS interception.
- Separating collection from interpretation prevents local-model guesses from becoming authoritative state.
- Bounded and sanitized evidence gives Gemma enough detail to answer questions such as why a review cycle repeated without leaking credentials or persisting raw internal reasoning.
- Conservative routing preserves role guarantees while reducing avoidable context and quota pressure.

### Alternatives

- TLS proxying was rejected because it is invasive, exposes credentials and prompts, requires certificate interception, and depends on unstable private endpoints.
- Transcript-only monitoring was rejected because inspected Antigravity transcripts contain progress but no token or quota fields.
- Replacing `agy` with the Antigravity Python SDK was deferred because it would change authentication, packaging, and session behavior rather than simply observing current CLI runs.
- Using Gemma to infer numeric usage was rejected because provider metrics must remain deterministic.

### Impact

- Antigravity's global status-line command may call Orchestra's collector when the slot is unused; existing third-party commands are not overwritten. Because print mode does not invoke the hook, missing or stale context/quota remains explicitly unavailable.
- Provider schemas are validated and unknown/missing fields remain explicitly unavailable.
- The UI gains interactive run questions and real provider usage instead of a fixed explanation button.
- Routing decisions record the telemetry reason that influenced model or conversation selection.

## 2026-08-13: Persistent Codex transport and quota/context-aware execution

### Background

Short-lived `codex exec --json` processes exposed final turn totals but not the installed app-server's live thread context, model reroutes, structured failure codes, or shared account telemetry. Antigravity's print transport similarly exposes exact per-turn tokens but does not invoke the interactive status-line hook. Investigation of the installed Antigravity CLI confirmed that `/usage` is a supported machine-readable quota command in print mode.

### Decision

Orchestra owns one lazily started persistent `codex app-server` process for both execution and account telemetry. Every Codex design, debug, and review stage starts a fresh ephemeral thread, then starts a read-only turn with approvals disabled. Orchestra consumes item lifecycle, message, `thread/tokenUsage/updated`, `model/rerouted`, and `turn/completed` notifications. User cancellation sends `turn/interrupt`, and dashboard shutdown closes the managed process.

Codex context percentage is calculated only from the app-server's reported `totalTokens` and `modelContextWindow`. At 80% utilization Orchestra records a context-pressure event, allows the current read-only turn to finish, and relies on the already-isolated fresh thread for the next Codex role or review cycle. A provider `contextWindowExceeded`, `sessionBudgetExceeded`, or `usageLimitExceeded` status remains a task failure with its explicit cause; Orchestra does not silently skip a required review.

Antigravity quota is polled from `agy --output-format json --print /usage`, cached for five minutes, and combined with per-turn stream-json tokens. A recent matching interactive status-line snapshot may supply an exact context percentage, but Orchestra does not hardcode an assumed model context limit when that snapshot is absent. It instead rotates a print-mode conversation when the last measured input count reaches the conservative 200,000-token threshold. Small tasks may move to a cheaper model when a provider has 10% or less quota remaining; deep, risky, or mandatory agent roles are preserved.

### Reasons

- One supported protocol now supplies Codex execution, live context, reroutes, cancellation, and quota without correlating separate subprocess formats.
- Fresh role-scoped threads prevent repair cycles from accumulating stale review context while preserving independent review.
- Provider-reported limits remain authoritative; unavailable Antigravity context caps are displayed as unavailable rather than guessed.
- Quota can reduce avoidable cost on small work without weakening design, debugging, or review requirements.
- Explicit context and quota events give the local Gemma monitor concrete evidence for run explanations.

### Alternatives

- Continue spawning `codex exec --json`: rejected because it cannot provide the same live context and account lifecycle through one managed session.
- Reuse one Codex thread across every repair cycle: rejected because review history would consume context and could anchor later reviews to obsolete findings.
- Interrupt active turns automatically at a context threshold: rejected because this can discard a nearly complete review; fresh subsequent threads provide a safer boundary.
- Hardcode Gemini context-window sizes: rejected because model aliases and provider limits may change, making a computed percentage look authoritative when it is not.
- Skip a required remote agent when quota is low: rejected because quota optimization cannot remove correctness and safety roles.

### Impact

- The live monitor can show exact Codex context utilization and tokens during a turn, plus authoritative Codex and Antigravity quota remaining.
- Codex stages use app-server instead of `codex exec`; read-only role boundaries and verdict contracts are unchanged.
- Each Codex review cycle begins with a clean context window.
- Antigravity quota refreshes independently of the unsupported print-mode status-line path.
- Routing decisions and pressure warnings are persisted in the timeline and are available to Gemma's run-analysis evidence packet.

## 2026-08-13: Constrained local operations bypass remote agent workflows

### Background

A request to connect a clean local project to an empty GitHub repository was classified by Gemma as a security-sensitive mutation. The generic risk policy escalated the task to Gemini Pro High and Codex Sol High, performed a design pass, and prepared to run the ordinary implementation/review loop. The requested operation required only validated Git remote configuration and an initial push. Switching chats could additionally clear the frontend's `activeTask` reference while the backend retained the project-wide task lock, hiding every Stop control.

### Decision

Task classification includes a constrained `localOperation` intent. `connect_git_remote` is recognized by Gemma and independently normalized from explicit remote-link language, forced to small complexity with no Codex role, and executed by Orchestra's trusted Git adapter before quota polling, baseline handling, or remote-agent routing.

The adapter accepts only a plain HTTPS `github.com/owner/repository` URL obtained from the current prompt or bounded recent conversation. It requires an existing committed local branch, refuses to replace a different `origin`, checks that a newly attached remote has no branches or tags, adds `origin`, and performs `git push --set-upstream`. Existing matching origins are idempotent and may retry the push. Gemma remains the user-facing classifier and reporter; it does not receive unrestricted shell access.

Project task ownership is displayed independently of the selected conversation. Creating or selecting a chat re-queries the backend's project-wide active task, and Task History provides a fallback Stop action. Codex context pressure uses the app-server's latest model-call token footprint (`tokenUsage.last`) while cumulative billing/activity remains sourced from `tokenUsage.total`.

### Reasons

- Deterministic, narrow operations do not benefit from design, implementation, and review agents.
- A validated backend adapter is safer than granting a local model arbitrary command execution.
- Independent normalization prevents a false model risk flag from causing extreme model escalation.
- Empty-remote and existing-origin checks avoid overwriting configuration or combining unrelated histories.
- Backend task ownership must remain controllable even when the user navigates between conversations.
- Context occupancy and cumulative token consumption are different measurements and must not share a numerator.

### Alternatives

- Let Gemma run arbitrary shell commands: rejected because it broadens local-model authority beyond the recognized operation.
- Continue using the generic mutating workflow with cheaper models: rejected because even a cheap three-agent cycle is unnecessary overhead.
- Automatically replace an existing origin or force-push a populated remote: rejected because both can alter repository ownership or history unexpectedly.
- Keep Stop scoped to the selected chat: rejected because execution is locked at project scope, not chat scope.

### Impact

- Plain requests to link an empty GitHub remote complete through Gemma plus the local Git adapter, without Antigravity or Codex.
- The task timeline records the remote connection and initial push as deterministic Git events.
- Non-empty remotes, conflicting origins, missing URLs, and uncommitted initial branches fail with explicit guidance.
- Active tasks remain visible and stoppable after chat navigation.
- Codex context percentages now describe the latest request footprint; cumulative tokens remain visible as usage rather than context.

## 2026-08-13: Shared MCP health with a least-privilege Gemma bridge

### Background

Rider MCP was configured independently for Antigravity and Codex, but Orchestra had no way to distinguish a saved configuration from a running, protocol-compatible server. Previous tasks could therefore discover an unreachable Rider endpoint only after an agent had started. Gemma used LM Studio's chat-completions endpoint without a tool loop and could not use MCP even when the loaded model supported structured tool calls.

### Decision

Orchestra maintains a normalized Rider MCP status model with separate server and agent states. It reads the supported Codex MCP listing and Antigravity's global `mcp_config.json`, then performs an MCP `initialize` and `tools/list` exchange against each configured endpoint. The dashboard reports server identity, version, tool count, latency, endpoint, and per-agent configured/enabled/available state. Results are cached for 15 seconds; Gemma tool-capability probes are cached for five minutes.

Antigravity and Codex retain the full Rider tool inventory supplied by their native MCP clients. Gemma receives an Orchestra-managed bridge only when the endpoint is loopback, Rider passes the protocol probe, and the loaded LM Studio model emits structured tool calls. The bridge exposes an explicit allowlist of read-only Rider inspection tools, limits a model response to six tool calls and five rounds, bounds every tool result, and excludes file mutation, terminal execution, builds, run configurations, SQL execution, and other side-effecting tools. Repository-question answering may use this bridge when it materially improves its evidence.

### Reasons

- Configuration presence does not prove that Rider is running or that MCP negotiation succeeds.
- A real protocol exchange detects stale ports, incompatible transports, and zero-tool servers before an expensive agent turn.
- Agent-specific status explains whether a failure is configuration, enablement, transport, or model capability.
- Gemma benefits from Rider's project model without receiving arbitrary IDE or shell authority.
- A loopback-only, allowlisted bridge is compatible with the current single-user local dashboard trust boundary.

### Alternatives

- Check only for `rider64.exe`: rejected because the IDE process can run while its MCP server is disabled or unreachable.
- Treat a configured URL as healthy: rejected because stale dynamic ports were already observed in agent runs.
- Give Gemma all 42 Rider tools: rejected because several tools mutate files, execute commands, run builds, or query databases.
- Spawn a model turn to test every agent on every refresh: rejected because it would waste provider quota and add latency; native configuration plus a direct protocol exchange is deterministic.
- Implement the future toggle manager now: deferred until Orchestra has a generalized inventory and safe configuration-write workflow for multiple transports and agents.

### Impact

- The dashboard visibly confirms Rider MCP health for Antigravity, Codex, and Gemma.
- Rider downtime or a changed endpoint appears within the cached health interval, before the next agent is routed.
- Gemma has 14 bounded read-only Rider tools through Orchestra while Antigravity and Codex retain their native full access.
- No existing MCP configuration is overwritten, and server enable/disable controls remain future work.

## 2026-08-13: Deterministic implementation intent and continuation

### Background

A greenfield request that explicitly said to plan and implement was classified by Gemma as a non-mutating design task. Orchestra consequently injected a read-only instruction into the Antigravity handoff, accepted a plan-only response as complete, and treated the user's subsequent “proceed” as an unrelated small question.

### Decision

Explicit implementation language is normalized deterministically after model classification. The task may still use Codex for a read-only design stage, but it remains mutating so the resulting analysis flows directly into Antigravity implementation, Codex review, automatic repair, verification, and Git finalization.

Bounded approval phrases such as “proceed,” “continue,” and “do it” inherit the immediately preceding completed task in the same conversation. Orchestra records the continuation link and expands the effective task prompt with explicit write authorization and bounded prior context. Longer prompts and non-terminal prior tasks remain independent.

A mutating Antigravity turn may not complete successfully with no project changes. Orchestra performs one automatic implementation retry with direct instructions. A second no-change result becomes an explicit failure, while a provider-created commit is rejected because it bypasses Orchestra's uncommitted review boundary.

### Reasons

- Model classification is advisory and cannot override unmistakable user authorization.
- Design plus implementation is one automated workflow, not two approval-gated tasks.
- Short conversational approvals depend on prior context and should not be routed as standalone questions.
- A plan-only response is not successful completion of an implementation request.
- Keeping changes uncommitted preserves independent review and dashboard-owned Git finalization.

### Impact

- “Plan and implement” proceeds automatically from Codex design into Antigravity edits.
- “Proceed” continues the prior completed proposal in the same conversation.
- False no-op implementations are retried once and never reported as completed.
- Explicit read-only and “do not modify” requests remain non-mutating.

## 2026-08-13: Capability-aware MCP use and adaptive diff-first review

### Background

Long implementation runs spent substantial time in repeated broad Codex inspections and reviews, while the dashboard often showed only a generic command-failure notice. Rider MCP health was visible, but healthy capability was not included in task instructions and actual tool activity was not reported. The local Gemma model had enough context to cheaply narrow review attention but did not participate in review preparation.

### Decision

Orchestra probes Rider MCP at task start and records an agent-specific capability event. A healthy connection adds role-bounded guidance: Antigravity prefers Rider for solution-aware implementation and navigation, Codex prefers read-only semantic inspection, and Gemma may use only its allowlisted read-only bridge. MCP remains optional and agents retain ordinary Git and shell tools.

Before each implementation review, Gemma produces advisory structured triage from the original request, changed-file list, and a redacted bounded diff. Orchestra creates a diff-first review packet containing the request, changed files, triage focus, Antigravity's report, the prior review when applicable, and the bounded diff. Codex inspects only targeted surrounding code and avoids duplicating broad build or test runs that Orchestra performs during final deterministic verification.

Ordinary implementation reviews run on Terra High. Review escalates to Sol High for an explicitly sensitive request, high-risk Gemma triage, at least 60 changed files, or a third/repeated repair review. Initial architecture and other existing specialist routing remain independent of this review policy.

Codex and Antigravity event decoders recognize Rider tool activity and publish sanitized start, completion, and failure messages. Failed Codex commands include the exit code and first useful credential-redacted detail when the provider supplies one, with a generic fallback for unknown event shapes.

### Reasons

- Diff-first evidence reduces repeated repository discovery and makes review time proportional to the change set.
- Gemma can cheaply prioritize evidence without becoming a proxy tool executor for Codex or weakening independent review.
- Terra is sufficient for ordinary bounded reviews; Sol remains available when risk or repeated failure justifies its cost and latency.
- Capability-aware guidance makes a healthy Rider server useful without routing unsuitable work through MCP.
- Actionable sanitized failures let the user distinguish a harmless fallback from a real stall.

### Impact

- The recent timeline identifies Rider availability and observed per-agent Rider activity.
- Most implementation review cycles should complete faster and with less duplicated tool work.
- Review packets and error details are length-bounded and secret-redacted.
- Orchestra's final verification remains authoritative after Codex returns a passing verdict.
- MCP health and activity are distinct: a healthy probe proves availability, while timeline events indicate observed use.

## 2026-08-14: Incomplete provider turns continue through independent review

### Background

During a Wiring recovery run, Antigravity ignored the foreground-only instruction, invoked an implementation subagent, and returned a final message saying it was pausing until that subagent completed. The CLI emitted terminal status `ERROR` after changing 13 files. Orchestra threw on the terminal status before examining the working tree, placed the task in `recovery_required`, and never started Codex review. The preserved diff sat idle overnight even though it was suitable for independent inspection.

### Decision

A mutating Antigravity result containing final text and a non-success terminal status is represented as an incomplete agent result, not immediate task failure. The text is retained only as untrusted implementation context and is never accepted as proof of completion.

Orchestra then applies its deterministic working-tree boundary:

- If no project files changed, it starts the existing automatic implementation retry in a fresh provider conversation.
- If uncommitted project changes exist, it continues directly into Gemma triage and independent Codex review.
- Blocking Codex findings still return to Antigravity for synchronous repair, followed by another fresh review.
- Only a passing Codex verdict plus deterministic project verification permits Git finalization.
- Nonzero process exits without a usable terminal result, missing diffs, direct provider commits, repeated repairs without progress, and exhausted repair limits retain the existing recovery-required safety boundary.

Antigravity implementation and repair prompts now explicitly prohibit `invoke_subagent`, `manage_task` delegation, pausing for another agent, and background execution. If Antigravity nevertheless ends incomplete, the recent timeline emits `task.provider-recovery` events explaining that Orchestra is continuing automatically.

### Reasons

- Provider completion status and project-change validity are separate facts.
- A terminal provider error should not discard or strand a diff that Codex and deterministic checks can validate independently.
- Independent review is a stronger completion gate than trusting a provider's self-reported final message.
- A bounded automatic path prevents harmless provider lifecycle errors from becoming overnight manual stops while preserving safety for genuine ambiguity or repeated lack of progress.

### Impact

- The specific “delegated work, paused, status ERROR” failure now advances into review instead of `recovery_required` when a diff exists.
- Users can see the automatic provider-recovery decision in the live timeline.
- Successful runs that crossed this fallback return an Orchestra-generated completion summary rather than Antigravity's stale pause message.
- Manual recovery remains available for failures that cannot safely make bounded automatic progress.

## 2026-08-14: Orchestra-owned cross-model failover

### Background

The first incomplete-turn repair covered structured Antigravity terminal results, but a resumed implementation turn repeated the delegated-wait pattern and remained alive without output until the CLI exited with process code 1. Because the failure occurred before a structured terminal result could be parsed, the task again entered `recovery_required` with preserved files and zero Codex review cycles. This demonstrated that provider-specific terminal parsing was the wrong recovery boundary.

### Decision

Orchestra, rather than any provider process, owns forward progress. All non-cancelled Antigravity failures—including structured errors, process exits, and timeouts—are normalized into incomplete turn results. Orchestra then coordinates the other models deterministically:

1. Gemma receives the sanitized provider error, last visible output, stage, and changed-file list. It classifies the observable failure and produces bounded continuation instructions.
2. If a project diff exists, control transfers immediately to independent Codex review. Antigravity's text is untrusted context only.
3. If no reviewable diff exists, Codex performs a read-only failure diagnosis. Orchestra starts Antigravity again in a fresh provider conversation with Gemma and Codex guidance.
4. Initial implementation permits two bounded fresh retries after the first attempt. A successful diff enters normal review regardless of whether the provider produced a clean final message.
5. When a repair makes no changes and Codex repeats the same blocker, the escalated review is sent once to a fresh Antigravity conversation using an explicitly different approach. A second confirmed no-progress failover may require attention.

Antigravity also has a five-minute stream-idle timeout in addition to its absolute execution timeout. Any stdout or stderr activity resets the idle timer. Crossing the idle boundary terminates the process tree and enters the same Gemma/Codex failover path as a nonzero exit.

The timeline emits `task.model-takeover` events naming the failed provider, diagnosing model, receiving role, stage, and next action. `task.provider-recovery` remains the lower-level provider-result signal.

### Reasons

- Process lifecycle details must not decide whether a valid Git diff can be reviewed.
- Gemma is fast and inexpensive for failure classification, Codex is independent and read-only for diagnosis/review, and Antigravity retains bounded mutation authority.
- Fresh conversations break provider state that is waiting on abandoned subagents, timers, or scheduled tasks.
- Bounded retries and repeated-finding fingerprints avoid infinite loops while eliminating single-provider random stops.
- Direct commits, wrong-project access, destructive ambiguity, and exhausted no-progress cycles still require a fail-closed boundary.

### Impact

- An `Antigravity exited with 1` case now transfers a preserved project diff to Codex instead of stopping before review.
- A clean-tree timeout triggers Gemma/Codex diagnosis and a fresh Antigravity attempt automatically.
- The user can see which model took over, why, and what happens next in the recent timeline.
- Manual recovery becomes the last bounded safety outcome, not the default response to a provider lifecycle failure.

## 2026-08-14: Verification is part of the recoverable review loop

### Background

A file-changing task reached a passing third Codex review, then Orchestra entered `recovery_required` because Node 24 on Windows rejected a direct `spawn('npm.cmd', ...)` verification launch with `EINVAL`. The agents had finished their work; Orchestra's verification transport incorrectly converted its own launcher incompatibility into a stopped project task.

### Decision

- Windows npm verification runs the npm CLI JavaScript entry point through the current `node.exe`. If that bundled entry point cannot be found, Orchestra uses an explicit `cmd.exe /d /s /c npm.cmd` fallback rather than spawning the cmd script directly.
- Lint, build, or test failures after a passing Codex review become a synthetic blocking review containing the concrete command and bounded output. Antigravity repairs that failure, then Codex independently reviews the new diff and Orchestra verifies it again.
- Successful review is not sufficient for finalization. A task can commit and push only after both Codex `PASS` and deterministic verification pass in the same bounded review loop.
- Verification launch behavior is exercised against a temporary package fixture in Orchestra's own test suite, so validation never depends on or operates on a user's test project.

### Impact

- The Windows `spawn EINVAL` regression is detected locally before deployment.
- Ordinary project check failures no longer force a manual resume between review cycles.
- Verification remains bounded by the existing repair limit and repeated-no-progress protection.

## 2026-08-14: Continuations bind to preserved task ownership

### Background

After a task entered `recovery_required`, the user submitted the one-word prompt `continue`. Continuation expansion accepted only previously completed tasks, so Gemma saw the word without its prior intent, classified it as a small read-only question, produced a repository summary, and explicitly listed implementation as a subsequent step. Orchestra accepted that answer because confidence and evidence-path checks passed. The resulting summary task became newer than the actual preserved task, making a naive "previous task" lookup unreliable.

### Decision

- Short continuation commands first search the current session for a `recovery_required` task. When found, the existing task is recovered in place; no new task is created.
- Recovery lookup searches past newer terminal summaries, preserving the identity of the task that owns the uncommitted changes.
- Completed-task continuation expansion remains available when there is no preserved recovery task.
- Gemma repository answers fail deterministic acceptance when their answer or limitations defer requested work to a later step or describe themselves as analysis-only.

### Impact

- `continue` cannot be downgraded to an isolated repository question while a session has preserved task changes.
- An erroneous newer summary cannot hide the true recovery owner.
- Explicit deferral is treated as incomplete work regardless of model confidence.

## 2026-08-23: Project-scoped Jules readiness and account-wide rolling capacity

### Background

Jules execution already had durable Orchestra task and cloud-session ownership, but the dashboard exposed only credential/runtime controls and per-task details. Users could not tell whether the selected repository was usable by Jules, how much rolling account capacity remained, or which Jules sessions were active for the selected project.

### Decision

Add a Jules dashboard application service between HTTP routes, the validated Jules adapter, Git inspection, settings persistence, and cloud-session repositories.

- Persist an explicit Free, Pro, Ultra, or Custom quota plan and rolling 24-hour limit; never infer a subscription tier from credentials.
- Calculate account usage from every paginated Jules session, deduplicated by provider resource name, with strict timestamp and pagination validation. Cache verified readings for five minutes (with explicit force-refresh) and persist only the non-secret last-known aggregate.
- Keep disabled mode provider-offline while presenting configured capacity and a stale last-known aggregate.
- Derive project readiness from the runtime switch, credential presence/provider acceptance, canonical GitHub remote, exactly one Jules source, active branch availability, and verified remaining capacity.
- Derive live project activity only from durable Orchestra-owned cloud sessions joined through their task ownership. Counters use the full rolling project set; the response list is limited to the 20 most recently updated sessions.
- Keep repository authorization user-controlled. Setup diagnosis supplies validated repository/branch/status facts to Gemma only for advisory wording and always returns deterministic instructions and official Jules/GitHub links.

### Reasons

- Account-wide provider sessions are the authoritative observable input for a rolling quota; project-owned sessions alone would undercount external Jules use.
- Persisted cloud-session ownership is the authoritative input for project activity; polling Jules account sessions cannot prove Orchestra project ownership.
- Failing closed on malformed timestamps or pagination prevents falsely reporting available capacity.
- Separating provider completion from Orchestra workflow phase prevents the dashboard from implying that reviewed or integrated code has landed.
- Advisory model output can improve setup clarity without gaining credentials or permission-changing authority.

### Alternatives

- Infer the Jules tier from the API key: rejected because Jules exposes no authoritative subscription-tier contract.
- Count only Orchestra-created sessions for quota: rejected because work created outside Orchestra consumes the same account capacity.
- Automate GitHub App installation: rejected because repository authorization requires explicit action in the official Jules/GitHub interface.
- Query live provider sessions for the activity card: rejected because provider records alone do not prove durable Orchestra project ownership.

### Impact

- `GET/PATCH /api/jules/settings` includes `quotaPlan` and `rolling24HourLimit`.
- Project APIs expose Jules readiness, setup diagnosis, and a bounded activity summary.
- `/api/usage` includes a Jules provider with rolling counts, remaining percentage, active sessions, next-slot time, and stale state.
- The dashboard displays a three-state Jules service light, guided setup dialog, rolling usage counts, and a separate live activity card refreshed on the configured telemetry interval.

## 2026-08-24: Provider-truthful task control and durable Jules integration

### Background

Orchestra used one generic task-stop action for local processes and cloud sessions. Stopping a cloud task only changed local state while Jules continued remotely, local tasks had no paused state, and interrupted work could lose project ownership. Jules terminal polling also made PR review a one-shot callback: a transient review failure was not durably retried. Successful review advanced the remote target branch but left its local branch behind. Full activity history was downloaded repeatedly, and local implementation created a model-generated checkpoint commit before review that could bypass final push metadata.

### Decision

- Separate local scheduler control from remote provider control. Local tasks support durable `paused` state, await process termination, preserve changes and project ownership, and resume the same task. Cloud stop confirms Jules session deletion before recording cancellation.
- Treat Jules `PAUSED` as provider state. Resume it with focused `sendMessage` guidance; do not expose an undocumented REST pause mutation.
- Keep provider completion intermediate until exact PR identity, isolated deterministic verification, independent review, bounded Jules repair feedback, target-branch integration, and local branch synchronization finish.
- Make terminal handoff retryable and idempotent. Persist review/integration evidence by exact head SHA, use repository and review leases, back off transient failures, and never launch a nominal local takeover unless the reviewed head has been made available locally and a local executor is actually queued.
- Poll immutable activities incrementally from the persisted `createTime` cursor while retaining receipt deduplication. Render progress from durable local events rather than issuing UI-side provider reads.
- Remove the pre-review checkpoint commit and its duplicate model summary. Review the complete uncommitted diff, then summarize, commit, and push exactly once after review and deterministic verification pass.
- Return actionable recovery guidance with warning/error codes and display the current stage, latest provider activity, next action, repair count, and integration state in the task UI.
- Bound ordinary local implementation to one fresh retry, and Jules review repair to two same-session cloud feedback cycles followed by one local takeover. The initial Jules dispatch is not counted as a repair cycle.
- Cache account-wide Jules usage for five minutes while retaining explicit force-refresh, avoiding repeated full account pagination during routine dashboard refreshes.

### Reasons

- User-visible state must describe confirmed local and provider effects, especially for stop and completion.
- Paused or partially changed work must continue to own the project so another task cannot accidentally absorb its diff.
- Exact Git identities and compare-and-swap branch updates prevent stale PR review and unintended branch overwrites.
- Incremental observation and removing duplicate model work reduce provider and token usage without weakening verification.
- Jules remains the preferred repair engine for Jules-created PRs; bounded independent review keeps that leverage safe.

### Alternatives

- Map Orchestra pause directly to Jules pause: rejected because no public REST pause endpoint is documented.
- Mark cloud tasks cancelled without deleting the provider session: rejected because it creates false state and leaks cloud work.
- Push the PR head remotely without synchronizing local refs: rejected because the user's repository remains stale after a claimed integration.
- Keep automatic local takeover as a database-only state change: rejected because no local worker would actually own or repair the reviewed PR head.

### Impact

- Local pause, resume, and stop become explicit state-machine operations with preserved ownership.
- Jules stop is a confirmed remote deletion; paused sessions can receive resume guidance.
- Activity polling and dashboard refreshes use fewer provider requests.
- PR review and repair can survive transient failures and restarts without silently losing terminal work.
- Successful Jules integration leaves both the remote target and its safe local branch ref at the reviewed commit, or reports an actionable local-sync warning without misrepresenting the remote result.

## 2026-08-24: Disputed approval is explicit, idempotent, and local-model friendly

### Background

A Wiring task reached the bounded local review-repair limit and exposed an `Approve & Commit Diff` action. The server's Git finalizer returned without an outcome when the repository or diff was unavailable. The caller then attempted to complete a task that was still in `review_disputed`, producing an illegal state transition that the HTTP boundary reduced to `INTERNAL_ERROR`. A successful approval followed by a failed secondary dashboard refresh could also leave the browser showing the old action even though the stored task was already complete.

### Decision

- Git finalization returns an explicit `committed`, `no_changes`, or `not_git` outcome. No caller may interpret an absent Git side effect as success.
- Approval is idempotent after `completed` or `completed_unpushed`, and duplicate in-flight clicks are rejected with a stable retryable code.
- Expected repository, state, and finalization failures return typed application errors with a concrete next action. A failed finalization restores `review_disputed` and preserves the project changes.
- The dashboard reconciles the authoritative task after an approval error and treats message/list refresh failures separately from the approval mutation.
- The dispute card uses the persisted review reason and current Git status. It offers local finalization only when an uncommitted local diff is visible; Jules handoff disputes remain owned by the Jules panel.
- Orchestra continues to use the configured local LM Studio model for commit notes and semantic slicing. Local-model work is not reduced to conserve metered quota. If the local model is unavailable or malformed, deterministic bounded notes allow the already-approved Git operation to proceed.

### Reasons

- A primary action must distinguish stale state, missing evidence, provider-owned work, operational Git failure, and success instead of collapsing them into a generic server error.
- Repeat requests are normal after a timeout or partial UI refresh and must reconcile rather than repeat a non-idempotent commit.
- Local inference is not a metered provider expense, but an optional model response must not be a single point of failure for an explicit user approval.
- Hiding an action whose precondition is false is safer and clearer than offering a button that can only fail.

### Alternatives

- Allow `review_disputed` to transition directly to `completed`: rejected because it would make a missing commit indistinguishable from successful finalization.
- Return success when the diff is empty: rejected because Orchestra cannot prove whether the changes were committed, discarded, or moved outside the workflow.
- Disable local summarization to reduce work: rejected because the local model is available without provider quota and produces useful commit/handoff context.
- Reuse the local approval route for Jules disputes: rejected because a Jules PR is committed remote evidence with a different review and integration lifecycle.

### Impact

- Approval route failures are actionable 4xx responses rather than random 500 banners.
- A stale repeat click returns the authoritative completed task without creating another commit.
- The UI reports the actual repair reason and file count and prevents duplicate clicks while finalization is active.
- LM Studio remains active in finalization, with deterministic fallback for availability and output failures.

## 2026-08-24: Repair guidance continues across recovery boundaries

### Background

Repair guidance was accepted only while a task remained in `review_disputed`. If the worker preserved the same task's files under `recovery_required` before the request arrived, the guidance route returned `TASK_STATE_CHANGED` and told the user to refresh. A recovery request made while the prior worker was still releasing its scheduler ownership could also be acknowledged without scheduling the continuation.

### Decision

- Treat focused repair guidance as a continuation of the same local task when its durable state is either `review_disputed` or `recovery_required`.
- Validate that a recovery-required task still has a mutating classification, a Git repository, and recoverable project files before recording guidance or scheduling work.
- Deduplicate only the latest identical task guidance so retrying a request does not enlarge the model prompt, while a later intentional reuse remains possible.
- Add an explicit scheduler operation for queuing a recovery after the currently unwinding worker releases project ownership.
- Preserve structured API error codes in the client. Reconcile changed task state automatically, retry the guidance once when it moved to recoverable preserved work, and present other stale-state reconciliation as an informational warning instead of a generic failure.

### Reasons

- Review dispute and recovery-required are different durable states of the same owned change set; a state race must not invalidate the user's repair instruction.
- Immediate recovery during worker cleanup is a normal concurrency boundary and must produce a later execution, not a false acknowledgement.
- Idempotent retries prevent duplicate context and unnecessary model work without limiting local-model use.

### Alternatives

- Require a refresh followed by a separate Resume action: rejected because it discards the intent already expressed by clicking Send Guidance & Resume Repairs.
- Accept guidance for every task state: rejected because completed, cancelled, cloud, and unrelated active states have different ownership contracts.
- Allow ordinary `enqueue` to duplicate every active task: rejected because only an explicit recovery continuation should request another run after current ownership is released.

### Impact

- Guidance submitted during the review-to-recovery race resumes the same preserved task and is stored once.
- A recovery requested during worker cleanup is queued for execution after the old run exits.
- The dashboard self-reconciles stale state instead of leaving the user with the former red `TASK_STATE_CHANGED` banner and a manual refresh loop.
