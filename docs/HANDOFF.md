# Tri-Agent Command Center: Project Handoff & State

## 1. What This Project Directory Is
This directory (`F:\orchestra`) began as a clone of the `antigravity-orchestra` repository. Originally, it was a template that used the Antigravity CLI as an orchestrator and the Codex CLI for design/review tasks.
It has since evolved into a **Tri-Agent Command Center**, incorporating a Web Dashboard UI (React/Vite) and a third agent: a local lightweight LLM (Gemma 4 2B via LM Studio) used for offline utility tasks.

## 2. What We Are Doing With It
We are transforming the CLI-based orchestration setup into a **unified Web Application Dashboard** (`F:\orchestra\orchestra-dashboard`). This dashboard serves as a central command hub that tracks PC hardware telemetry (CPU, GPU, RAM), reports only trustworthy provider-usage data, and provides a built-in Chat Interface.
The ultimate goal is to remove the need for manual CLI commands and create a seamless, UI-driven workspace where multiple AI models are automatically managed behind the scenes.

## 3. What We've Tried So Far
- **Local Git Logger Skill**: We successfully integrated LM Studio (running Gemma 2B) by creating a PowerShell script (`.agents/skills/local-git-logger`) that queries the local model to summarize `git diff` outputs, automatically appending them to this `HANDOFF.md` file and committing them to git.
- **Tri-Agent Manager GUI**: We created a simple PowerShell WinForms script (`OrchestraManager.ps1`) to easily copy the orchestration configuration (`AGENTS.md`, `.agents/`, `.codex/`) to any other codebase.
- **Web Dashboard Setup**: We built a Vite+React web application with a premium dark-mode, glassmorphic UI.
- **Telemetry & Usage Backend**: The TypeScript backend uses local system telemetry and CLI health checks. Provider quota remains explicitly unavailable unless a trustworthy machine-readable source exists; Orchestra does not invoke slash-command-like prompts or fabricate percentages.
- **Chat UI**: We implemented the visual interface for the Agent Chat in the dashboard side panel.

## 4. How It Should Work When Done
When the project is finished, the user should **never need to manually trigger tools, use slash commands, or manage agents**.
The workflow will be 100% automated:
1. The user types a natural language request into the Web Dashboard's Chat UI.
2. The Node.js backend intercepts the chat and acts as a "Master Router".
3. The backend uses local Gemma classification plus deterministic safeguards to select the agent and model tier.
4. **Antigravity** performs project research and implementation, while **Codex CLI** handles read-only design, debugging, and independent review.
5. If code changes occur, Orchestra verifies them, asks local Gemma to summarize the diff, appends `HANDOFF.md`, commits explicit project paths, and pushes when an upstream exists.

The user will only ever interact with the single chat interface, while the Tri-Agent system seamlessly divides and conquers the work automatically.

---
## Incremental Handoff Log

## [2026-08-12] Tri-Agent Command Center implementation

- Replaced the dashboard prototype with a project-scoped React command center covering Dashboard, Projects, Task History, Settings, and resumable chat sessions.
- Added a typed Express backend with local SQLite persistence, native Windows folder selection, canonical path validation, automatic project onboarding, health checks, and honest telemetry/usage states.
- Added automatic Gemma classification, Gemini/Codex model routing, Antigravity streaming execution, read-only Codex design/debug/review, verification, cancellation, and recoverable task state.
- Added dirty-baseline handling, managed ignore rules, conflict backups, explicit-path commits, tracked handoff entries, automatic upstream pushes, and retryable unpushed commits.
- Added a one-command launcher, backend regression tests, full build/lint/test commands, and current architecture documentation.

### Runtime requirements

- Node.js 24+, Git, authenticated `agy` and Codex CLIs.
- LM Studio at `http://127.0.0.1:1234/v1` with `gemma-4-e2b-it-qat` loaded.
- Start with `.\Start-Orchestra.ps1` and open `http://127.0.0.1:5173`.

## [2026-08-12 22:09:17] Handoff Update
feat: Implement local Git logger skill for incremental change logging and committing

* Added `SKILL.md` file defining the "local-git-logger" skill for summarizing git diffs using a local LM Studio model.
* Created `scripts/log_and_commit.ps1` to handle the logic:
    * Retrieves unstaged or staged git diffs.
    * Constructs a prompt for an LLM (via LM Studio API) to generate a concise summary of the changes.
    * Appends the generated summary to `docs/HANDOFF.md`.
    * Stages and commits the changes to Git using a title derived from the summary.

## [2026-08-13 21:25:56] Handoff Update
* **Project Redesign:** Replaced the original design with the "Antigravity Orchestra Design" for a multi-agent command center, focusing on a Windows-first architecture (React/Vite client + TypeScript Express service) persisting state in SQLite.
* **Agent Responsibilities Defined:** Fixed roles: Antigravity as primary orchestrator/code changer, Codex for read-only design/review, and `gemma-4-e2b-it-qat` for request classification/commit summaries.
* **Automated Model Tiering:** Backend automatically selects model tiers (Gemini 3.6 Flash/3.1 Pro, Luna/Terra/Sol) based on task complexity.
* **Task Execution Flow:** Defined a detailed lifecycle: `queued → routing → preflight → running → reviewing → verifying → summarizing → committing → pushing → completed`.
* **Git Baseline Enforcement:** Implemented logic to pause mutating tasks at `baseline_required`, requiring existing changes to be summarized and committed before onboarding or task modification.
* **Gemma-First Routing (Evidence-Bounded):** Introduced a policy where Gemma acts as the first responder for deterministic, non-mutating questions using local evidence packets, escalating complex/sensitive work to Antigravity/Codex if necessary.
* **Greenfield Project Initialization:** Defined rules for treating directories as greenfield only when blank or containing Orchestra bootstrap entries (`AGENTS.md`, `.agents`, etc.), ensuring


## [2026-08-13 22:09:23] Handoff Update
* **Enhanced Agent Observability:** Introduced new mechanisms to capture and report provider telemetry (Antigravity and Codex) directly into the task state, allowing for more concrete reasoning about repair cycles and routing decisions.
* **Persistent Codex Transport and Quota Awareness:** Orchestra now owns a persistent `codex app-server` process that manages execution and account telemetry, providing live context utilization percentages and quota remaining information during turns.
* **Improved Task Monitoring & Question Answering:** Added functionality to query the local Gemma model with specific run evidence (`answerRunQuestion`) based on sanitized task data, enabling users to ask questions about progress, failures, or context pressure.
* **Refined Model Routing Logic:** Updated routing decisions to consider real-time Antigravity and Codex quota percentages (e.g., moving small tasks to cheaper models) when quotas are low, while preserving mandatory roles like design/debug/review.
* **Enhanced User Interface for Monitoring:** The dashboard now displays detailed provider usage metrics, including context utilization percentage and remaining quota information for both Antigravity and Codex.
* **Improved Event Logging & Context Tracking:** Task events now explicitly include provider telemetry, and the system tracks context pressure warnings to inform routing adjustments.
* **Code Refactoring in Agents:** Significant refactoring occurred across `agents.ts` (Codex/Antigravity) to transition from spawning ephemeral processes for analysis to using a managed, persistent `codexAppServer` process for better


## [2026-08-13 23:02:43] Handoff Update
*   **Task Classification Refinement:** Updated `CLASSIFICATION_SCHEMA` to include a new field `localOperation` with values `'none'` or `'connect_git_remote'`, specifically recognizing `connect_git_remote` as a small, mutating operation requiring no Codex role.
*   **Gemma Tooling Integration (Rider MCP):** Implemented a mechanism for Gemma to use read-only Rider inspection tools via an Orchestra bridge, allowing it to inspect the project model without gaining arbitrary shell or file mutation authority.
    *   Added `getMcpStatus` and related functions in `mcp.ts` to manage and probe Rider MCP endpoints (Antigravity/Codex).
    *   Gemma is granted access only to a bounded set of read-only tools (`READ_ONLY_RIDER_TOOLS`).
    *   The bridge enforces strict limits on tool calls (max 6 calls per round) and excludes mutation/execution tools.
*   **Git Remote Connection Logic:** Enhanced `connectGitHubRemote` in `git.ts` to handle remote connection more robustly:
    *   It now validates the URL strictly against a plain HTTPS GitHub format.
    *   It checks for existing origins and prevents overwriting them unless explicitly handled (rejecting force-push/replace).
    *   It performs an initial push (`git push --set-upstream`) after successfully adding the remote, ensuring the local branch is


## [2026-08-13 23:29:57] Handoff Update
*   **Renamed and Expanded README:** The project description was significantly updated to introduce "Antigravity Orchestra" as a Windows-first, local command center orchestrating three AI agents: Gemma (LM Studio), Google Antigravity (Gemini), and OpenAI Codex. It details the role distribution for each agent (Orchestrator, Researcher, Builder, Designer, Debugger, Auditor).
*   **Enhanced Workflow Logic:** The core workflow now explicitly handles implementation intent using `hasExplicitMutationIntent` to determine if a prompt requires direct file changes (`mutating: true`), overriding model classification when necessary.
*   **Continuation Prompting Implemented:** A new function, `buildContinuationPrompt`, was added to handle user approvals (e.g., "proceed", "continue") by constructing prompts that explicitly authorize implementation and continuation of the previous task without requiring a new approval step for short commands.
*   **Task Management Improvements:** The `TaskManager` now includes logic to automatically retry implementation turns if they produce no project changes, using explicit write instructions. It also prevents Orchestra from committing directly if it detects uncommitted changes are present before final review.
*   **Dashboard and Telemetry Updates:** New files were added for system telemetry (`docs/images/system-and-mcp-status.png`) and live run monitoring visualization (`docs/images/live-run-monitor.png`).
*   **Code Refactoring in `orchestra-


## [2026-08-14 07:09:38] Handoff Update
* **Capability-aware Rider MCP:** Orchestra probes Rider at task start, gives each healthy agent role-bounded Rider guidance, and reports observed Rider tool activity in the recent timeline without exposing arguments.
* **Actionable Codex failures:** Read-only command failures now include a bounded, credential-redacted exit reason when available instead of only a generic fallback notice.
* **Faster adaptive review:** Gemma performs advisory diff triage, ordinary implementation reviews use Terra High with a bounded diff-first packet, and Sol High is reserved for sensitive, high-risk, very large, or repeatedly failing reviews.
* **Automatic incomplete-turn continuation:** A mutating Antigravity turn that returns final text with terminal status `ERROR` is no longer allowed to strand a useful diff. Orchestra retries a no-change turn or carries preserved changes into Codex review, repair, deterministic verification, commit, and push.
* **Foreground enforcement:** Antigravity prompts explicitly prohibit `invoke_subagent`, `manage_task` delegation, pausing for another agent, and background execution. The dashboard emits `task.provider-recovery` when the fallback is used.
* **Verification:** Dashboard lint, production build, and all 47 automated tests pass.

## [2026-08-23] Stage 0 Jules containment

* Jules API routes are mounted only when `JULES_ENABLED` is explicitly `true` and are further limited by an ordered rollout stage.
* Unsupported cancellation and unfinished remote deletion now fail closed without provider calls, state changes, or false-success events.
* Focused route/session tests and the complete offline `npm run check` gate pass with 127 tests.

## [2026-08-23] Stage A Jules contracts and security

* Added strict runtime validation for Jules sources, sessions, outputs, activities, pagination, and empty mutation responses using documented wire shapes; mutating requests are no longer blindly retried.
* Enforced the canonical task lifecycle and task-event contracts at persistence boundaries, including historical reads, and centralized deep secret redaction.
* Corrected LM Studio discovery to use the documented `/api/v1/models` response and `loaded_instances` before compatibility fallbacks.
* Replaced reproducible vault encryption with current-user Windows DPAPI, authenticated legacy migration, atomic replacement, corrupt-vault failure, and safe closed credential-validation statuses.
* Verification: dashboard lint, production build, and all 135 offline automated tests pass. No live Jules API call was made or required.

## [2026-08-23] Durable workflow persistence

* Added transactional migration v3 and focused repositories for durable command intents, idempotency, checkpoints, polling cursors, retry schedules, fenced leases, managed Git resources, SHA-bound evidence, and publication outbox records.
* Added unique provider-session identity, cloud-session-to-attempt correlation, runtime enum validation, and a database unit-of-work boundary.
* Added fault, concurrency, stale-owner, rollback, redaction, uniqueness, and recovery tests.
* Verification: dashboard lint, production build, and all 141 offline automated tests pass.

## [2026-08-23] Modular application boundary slice

* Split Jules HTTP controllers by connection, session, and review concerns over application services and strict request contracts; concrete dependencies are composed in bootstrap.
* Added durable, cross-project-safe, idempotent dispatch entry behavior and removed caller-controlled PR SHA import from reachable code.
* Extracted TaskManager scheduling, event publication, handoff writing, and Git finalization services.
* Moved frontend API contracts plus shared UI/format primitives out of the application root and added architecture ratchets preventing regression.
* Verification: dashboard lint, production build, and all 147 offline automated tests pass.

## 2026-08-23 — Jules end-to-end implementation milestone

- Completed strict Jules source discovery, immutable dispatch branches, durable idempotent commands, fenced polling/recovery, exact PR verification/review/repair/integration, and ownership-aware cleanup.
- Added configurable parallel Jules workflows with dependency DAGs and durable global capacity reservations; the default concurrency is 2 and no provider account limit is hardcoded.
- Added deterministic auto-routing, feature-specific Jules UI, authenticated operational status, and sanitized provider metrics.
- Preserved staged rollout and truthful lifecycle behavior: Jules defaults off; unsupported pause/resume/cancel return unavailable rather than recording false success.
- Added schema migrations through v8 and modular repositories/application services for sources, activity receipts, capacity, batches, cleanup, routing, operations, and PR review.
- Offline verification: `npm run check` passes 150/150 tests, including temporary-local-Git immutable dispatch and exact PR integration. No live Jules API key or provider repository was used; credentialed smoke acceptance remains required before production rollout.

### In-application Jules enablement follow-up

- Jules credentials and enablement are now controlled entirely from the Settings UI; no shell environment setup is required.
- The persisted toggle takes effect without restarting the server. Off blocks operational routes and pauses background polling while leaving credential management available and remote sessions untouched.
- The test runner serializes file-level integration suites to prevent nondeterministic Windows contention between temporary Git remotes, worktrees, and nested npm processes.

## [2026-08-24 07:14:24] Handoff Update
- Make git commit generation resilient to local model failure by adding deterministic fallback summaries and bounded input for large diffs
- Decouple LM Studio availability from critical path; a failed summarization emits a non-blocking warning instead of failing the whole approval flow
- Introduce typed `GitFinalizationResult` so upstream callers can distinguish between no changes, commit success, and operational failures rather than guessing from absent side effects
- Make disputed approvals idempotent: repeated clicks on an already-completed task reconcile to completed without creating duplicate commits or erroring
- Surface real failure reasons (no Git repo, failed push) as actionable 409 responses instead of generic 500s
- Add comprehensive contract tests for the new deterministic paths and all upstream failure modes


## [2026-08-24 17:46:03] Handoff Update
- Add `enqueueAfterCurrent` to the task scheduler for queuing work after current ownership is released
- Implement recovery guidance flow: record user steering as a system message and deduplicate identical submissions
- Route steer requests through `resumePreservedTask` when a task has already transitioned to recovering or recovery_required
- Introduce `ApiRequestError` with error codes so the frontend can distinguish between transient state races and real failures
- Add client-side retry for guidance submission during rapid state transitions, showing an informative warning instead of failing silently
- Extend test suite with roundtrip tests for repair guidance following a task into recovery and concurrent enqueueing under worker cleanup


## [2026-08-24 21:47:03] Handoff Update
- Replace state-dependent dispute/baseline workflows with a single deterministic "Commit & Push Changes" action for stalled tasks
- Remove model-generated commit summaries and guidance routes; replace with explicit user intent
- Decouple repair cycle counts from flow control so Jules can iterate indefinitely until review passes or the session fails
- Add local fallback that re-imports the exact PR head before queuing a real local repair when cloud sessions become unavailable
- Retain hard Git/PR identity checks as non-negotiable integrity boundaries rather than arbitrary loop limits


## [2026-08-25 07:04:41] Handoff Update
- Decouples project ownership from conversation display so stale or dead tasks no longer block new work while preserving safety boundaries
- Adds `ProjectTaskOwnershipService` to reconcile abandoned recovery states and release ownership only when Git is clean and no process runs
- Replaces the global `restoreProjectTask` call with a session-filtered version, preventing conversations from displaying unrelated active tasks
- Exposes an "Open active task" action instead of silently failing or auto-merging when a project has a different owner
- Adds comprehensive tests for ownership reconciliation, concurrent submission races, and UI consistency


## [2026-08-25 18:36:55] Handoff Update
- Enforce Gemma Solo as an untrusted protocol source by buffering output and rejecting any tool/function calls before display or execution
- Replace model-generated Git status with deterministic system evidence for direct questions
- Add a contract layer to validate that only plain Markdown is emitted in non-agentic modes
- Implement a single fallback retry for recoverable template mismatches without leaking internal protocol text
- Extend the test suite with full roundtrip verification of buffered responses and real repository data


## [2026-08-26 07:49:08] Handoff Update
- Add provider-neutral routing and usage accounting to DESIGN.md with detailed decision/impact sections
- Track per-provider runs (task, model, tokens) for accurate workload attribution
- Implement a bounded review prompt envelope with SHA-256 fingerprinting and 48k character cap
- Expose Codex's rolling 5h and weekly quota windows independently rather than as a single value
- Add tests verifying provider run state transitions (cancelled/completed), usage aggregation, and task recovery
- Update migration schema to include `provider_runs` with prompt fingerprint and latest version bump


## [2026-08-26 18:34:00] Handoff Update
- Decouples task lifecycle and monitoring from execution by introducing TaskControlService and run-monitor-service while keeping the public TaskManager API stable as a compatibility facade.
- Extracts model selection and task classification into dedicated routing modules; keeps server/agents.ts as a minimal three-line facade for existing callers.
- Moves large UI components out of App.tsx into feature-owned views (checkpoints, MCP, settings) to reduce the controller size below 900 lines.
- Adds architecture tests enforcing module boundaries: agent facade line count, TaskManager delegation, and file ownership checks.
- Introduces model-format utility for consistent display names across provider types.


## [2026-08-26 19:37:46] Handoff Update
- Documented new architectural boundaries for provider/task-runtime/Jules/dashboard and updated design docs with reasoning and alternatives
- Added `agent-data-utils` with secret redaction, JSON parsing, and a robust repair function for malformed model responses
- Refactored `agent-services.ts` into a thin compatibility layer forwarding to new domain modules (gemma, review, git)
- Extracted task execution logic from the main controller into `TaskExecutionCoordinator`, splitting it by runtime/context concerns
- Decoupled Jules routing from the concrete `TaskManager` via a minimal `LocalTaskQueue` port for isolated testing and deployment
- Moved dashboard state and telemetry out of `App.tsx` into feature hooks (`useDashboardTelemetry`, `useComposerState`)
- Tightened architecture tests to enforce small public facades, no network/process code in the React root, and correct dependency directions


## [2026-08-26 21:05:08] Handoff Update
- Bump orchestra-dashboard version from 1.0.7 to 1.0.8 in package.json and lockfile

## [2026-08-27 22:00:00] Pipeline Realignment & Quota Safety
- **Realigned Multi-Agent Pipeline:** Restructured the task coordinator to execute the intended sequence:
  1. **Gemma (Pass 1: Pre-Plan Router — 0 Tokens):** Refines the raw user prompt into an unambiguous technical specification with ordered phases and chooses the Codex model and reasoning effort needed to design the plan.
  2. **Codex (Architect):** Runs a single planned turn to create a concrete implementation blueprint (files, functions, contracts).
  3. **Gemma (Pass 2: Construction Sizer — 0 Tokens):** Reviews Codex's blueprint, evaluates the actual implementation scope (file count, algorithmic depth, refactoring surface), and selects the Antigravity reasoning effort (`low`, `medium`, or `high`) matched to the blueprint.
  4. **Antigravity / Jules (The Builders):** Implements the concrete blueprint using the exact reasoning tier fitted to Codex's plan.
  5. **Gemma (Diff Condenser):** Strips lockfiles, minified bundles, and noise from the git diff, producing a clean annotated review packet.
  6. **Codex (The Auditor):** Evaluates the pre-digested diff packet in a single review turn without running exploratory filesystem commands.
- **Eliminated Autonomous Retry Loops:** Deleted the `for (retryAttempt = 1; progress === 'none')` loop that secretly spawned Codex in an infinite loop when Antigravity produced zero file changes. Added `task.no-changes` event and fail-stop to prompt user refinement.
- **Capped Review-Repair Loop:** Bounded the review-repair cycle to `MAX_REPAIR_CYCLES = 2`. Unresolved issues transition to `review_disputed` instead of looping indefinitely.
- **Child Process Cleanup:** Added `child.unref()` and comprehensive stdio stream disposal to `codex-app-server.ts` to prevent zombie `codex.exe` processes from blocking Node exits.
- **Reduced Antigravity Timeouts:** Lowered print timeout from 21m to 15m and idle timeout from 5m to 3m to prevent stalled runs.
- **Prompt Sanitization on Promote:** Cleaned leading conversational pleasantries when using "Implement with Orchestra" in the dashboard.
- **Verification:** Added `pipeline-realignment.test.mjs` validating quota-tier clamping and diff noise stripping. All 225 test cases pass cleanly.

## [2026-08-29 08:35:00] Modular Sensor-Driven Pipeline Architecture
- **Complete Pipeline Modularization (<250 lines/file):** Decomposed the monolithic ~840-line `task-execution-coordinator.ts` into 8 single-responsibility stage modules under `server/application/tasks/pipeline/`:
  - `types.ts` — Typed `PipelineContext` shared across stages.
  - `1-sensing-stage.ts` (<75 lines) — Dynamic capabilities probing and preflight baseline validation.
  - `2-refinement-stage.ts` (<60 lines) — Gemma Pass 1 spec refinement & quota-bounded routing.
  - `3-architect-stage.ts` (<60 lines) — Codex Architect blueprinting (single planned turn).
  - `4-sizing-stage.ts` (<60 lines) — Gemma Pass 2 construction sizer (evaluates blueprint to set builder reasoning effort).
  - `5-builder-stage.ts` (<115 lines) — Builder dispatch supporting Antigravity only, Jules only, or Hybrid (Both). Automatically fetches remote Jules cloud branches to a local worktree for local verification and review.
  - `6-verification-stage.ts` (<70 lines) — Deterministic local test & build verification gate (with zero-diff fail-stop circuit breaker).
  - `7-review-audit-stage.ts` (<160 lines) — Gemma diff condensation + contract drift detection + Codex Auditor review gate (strictly capped at 2 repair cycles).
  - `8-finalization-stage.ts` (<45 lines) — Automated `HANDOFF.md` logging and deterministic Git commit & push.
- **Dynamic Environment Sensing (Zero Hardcoding):** Created [`server/application/capabilities/environment-sensor.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/capabilities/environment-sensor.ts) with non-blocking, fault-tolerant `withTimeout` probes (bounded at 2.0s):
  - Dynamically probes LM Studio model and loaded context length (`8192` default).
  - Senses real Codex rolling (5h) and weekly quota percentages with duration-based window matching.
  - Discovers installed Antigravity CLI models dynamically via `agy models`.
  - Probes Jules cloud capacity and project source branch mapping.
  - Checks Rider MCP server status and operational tools.
- **Contract-Drift & Test-Integrity Detection:** Added `detectContractDrift` in `diff-condenser-service.ts` to actively flag deleted exported TypeScript interfaces, modified database schemas/migrations, and deleted test assertions before Codex reviews the diff.
- **Anti-Looping Circuit Breakers:**
  - Zero-diff fail-stop (`task.no-changes` event) prevents infinite retries on unmutated runs.
  - Review repairs capped at `MAX_REPAIR_CYCLES = 2`; unresolved disputes transition to `review_disputed`.
- **Zero Circular Dependencies & Strict Architecture Rules:** Validated clean dependency graph using `find-cycles.mjs` and verified compliance with architecture rules.
- **Verification & Test Coverage:** Added unit test suites `tests/environment-sensor.test.mjs` and `tests/pipeline-stages.test.mjs`. Full test suite runs 230/230 tests passing with 0 failures across 35 test suites.

## [2026-08-29 11:15:00] Rider MCP Solo Bridge & Database Migration 11
- **Rider MCP Connected to Gemma Solo:**
  - Forwarded `riderAvailable` into `runGemmaDirectChat` and `runGemmaProjectToolLoop`.
  - Attached all 14 read-only JetBrains Rider MCP tools to Gemma's tools array in Direct Chat mode when Rider is online.
  - Routed `rider_*` tool executions directly to `callGemmaRiderTool`.
  - Updated system prompt and `directProjectAccessInstruction` / `deterministicDirectProjectAnswer` so Gemma knows Rider MCP tools are active and available.
- **Database Schema Migration 11 (`provider_runs_token_estimates_and_fingerprints`):**
  - Added SQLite migration 11 in `server/infrastructure/database/migrations.ts` to add missing `prompt_fingerprint` and `estimated_input_tokens` columns to `provider_runs` on existing databases.
  - Fixed internal server error `500 [INTERNAL_ERROR]` caused by unmigrated SQLite table on task creation.
- **Auto-Route Fail-Open to Local Antigravity:**
  - Wrapped cloud dispatch in `JulesRoutingService.execute` with graceful fallback to local Antigravity execution when cloud dispatch is unavailable or rejected, preventing task submission failures in `Auto route` mode.
- **Verification:** All 231 tests passing across 35 test suites with 0 lint warnings and 0 errors.

## [2026-08-29 12:08:00] Unified Auto-Route Pipeline & Context-Budget Routing to Codex Luna High
- **Context-Budget-Aware Routing Engine:**
  - Created [`server/application/context/context-budget-evaluator.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/context/context-budget-evaluator.ts) to evaluate total input tokens against loaded LM Studio context length ($8\text{k}/16\text{k}$).
  - Automatically routes to **Local Gemma** when within budget ($\le 75\%$ of local capacity) for **0 cloud tokens**.
  - Automatically promotes to **Codex Luna (`gpt-5.6-luna` @ `high` effort)** with its $128\text{k}+$ context window when the task is large, when Gemma throws context overflow, or when LM Studio is offline.
- **Pass 1 Refinement & Pass 2 Sizer Promotion:**
  - Integrated `refinePromptWithLuna` in [`server/application/gemma/prompt-refinement-service.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/gemma/prompt-refinement-service.ts) and [`server/application/tasks/pipeline/2-refinement-stage.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/tasks/pipeline/2-refinement-stage.ts).
  - Integrated `evaluatePlanForBuilderWithLuna` in [`server/application/gemma/plan-sizer-service.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/gemma/plan-sizer-service.ts) and [`server/application/tasks/pipeline/4-sizing-stage.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/tasks/pipeline/4-sizing-stage.ts).
## [2026-08-29 17:08:00] Intelligent Review Loop Detector & Extended Repair Allowance
- **Intelligent Review Loop Detection:**
  - Implemented `extractReviewFindings` and `detectReviewLoop` in [`server/application/review/review-services.ts`](file:///F:/orchestra/orchestra-dashboard/server/application/review/review-services.ts).
  - Replaced naive 2-cycle hard termination with true loop pattern recognition:
    1. **Stagnant Repair Detection**: Halts if Antigravity's repair produces 0 code diff modifications and identical findings remain.
    2. **State Oscillation / Flip-Flop Detection**: Halts if a repair cycle reverts to the exact diff and finding signatures of an earlier cycle.
    3. **Persistent Blockers**: Halts if the exact same set of blocker signatures repeats across 3 consecutive cycles without resolution.
  - **Healthy Forward Progress Permitted**: When findings are actively decreasing or distinct issues are being resolved across cycles, Orchestra allows the repair process to run through completion up to `MAX_REPAIR_CYCLES = 5` (accommodating 3-4 normal correction iterations).
- **Client Error & Fetch Resilience:**
  - Improved [`src/app/useApiClient.ts`](file:///F:/orchestra/orchestra-dashboard/src/app/useApiClient.ts) to gracefully catch network disconnects/reconnections and provide clear guidance rather than raw unhandled `TypeError: Failed to fetch`.
- **Verification:** Added `tests/review-loop-detector.test.mjs` (5/5 passed). Full regression suite passing at 240/240 tests across 37 test suites.

## Future corrective measures — autonomous Jules/local handoffs

- **Observed live gap:** Even after Orchestra automatically reviewed and approved the Jules plan, the active Jules session still required manual user feedback before it continued. Treat every Jules action-required, clarification, pause, plan, implementation, repair, and completion handoff as durable work owned by Orchestra; the user must not be the default relay.
- **Local-first triage:** Route every Jules-to-local handoff through deterministic handling first, then local Gemma when the evidence fits its loaded context. If Gemma cannot decide safely, use Codex Luna at the lowest sufficient effort before considering a more expensive reviewer.
- **Apply the same ladder to Jules plan corrections:** Do not send every revised plan directly through a full premium Codex review. Use deterministic comparison against the cumulative acceptance checklist, then Gemma for bounded change classification and obvious completeness checks, then Codex Luna for ordinary plan judgment. Escalate only unresolved, architectural, safety-critical, or contradictory deltas to Terra/Sol, and review the changed plan sections plus carried-forward findings rather than paying to reassess the entire plan each round.
- **Live cost evidence:** The 2026-08-30 acceptance session performed 13 Codex Terra plan-review runs (12 BLOCK decisions followed by 1 PASS). This is the regression case for proving that local-first delta review, cumulative findings, and tiered escalation materially reduce cloud-review usage without weakening the approval gate.
- **Role-aware resolution:** Allow Gemma to classify/summarize bounded evidence, Codex Luna to resolve ordinary design/review questions, Antigravity to perform repository research or authorized local implementation/repair, and higher Codex tiers only for genuinely complex or high-risk unresolved decisions.
- **Cost-controlled escalation:** Do not repeatedly invoke Sol High for routine back-and-forth. Escalation must be evidence-based and progressive (`deterministic -> Gemma -> Luna -> Terra/Sol`), with quota awareness, deduplication, bounded packets, and reuse of prior findings.
- **Automatic continuation contract:** Persist the Jules request, selected local handler, decision, feedback, idempotency key, retry/backoff state, and resulting Jules activity. Automatically send the response and resume monitoring without requiring a dashboard click or user-authored prompt.
- **Cumulative review context:** Carry resolved requirements and prior blocker findings forward so each local reviewer evaluates the newest Jules response against one cumulative acceptance checklist instead of rediscovering issues across many expensive independent turns.
- **Transparent UI:** Show what Jules asked, which local resource handled it, why escalation occurred, what response Orchestra sent, quota consumed, and whether Jules resumed. Reserve user attention states for ambiguous authority, safety-sensitive choices, exhausted local/cloud capacity, or true repeated stagnation.
- **Status:** Backlog only; no runtime changes were made while the current Jules session was active.

## 2026-08-30 — Autonomous Jules handoff corrective implementation

- Added runtime-validated Jules handoff, decision, checklist, delta, outstanding-repair, and automation contracts under `server/domain/jules/`.
- Added `JulesHandoffService` and wired the supervisor's plan, feedback, pause, and completed transitions through it.
- Reworked plan review to default to Luna Medium, persist cumulative checklist/delta evidence, reuse identical plan fingerprints, remove fixed ceilings, and escalate repeated blockers with one consolidated packet.
- Reworked cloud repair feedback to use `JulesSessionService` command intents. One repair identity is retained per task/head/findings; unchanged-head completed snapshots do not send another message or create another execution attempt.
- Added durable changed-head detection and explicit local-verification / independent-review / reviewed automation checkpoints.
- Added Rider endpoint circuit breaking, cached probe/tool metadata, filesystem-only Antigravity guidance, and a no-Rider Codex app-server instance using a process-local config override.
- Extended the Jules session API/UI with the complete current plan, automation status, review/checklist state, pending command, repair identity, and authoritative task state. Emergency approval/guidance controls are collapsed and duplicate-disabled.
- SSE reconnect now exposes connected/reconnecting/offline behavior, clears obsolete transport errors, and rehydrates durable task/session/monitor/message state. Optional telemetry failures no longer create the global fatal banner.
- Regression evidence: focused handoff/plan/repair/Rider tests include the 13-plan progression and a 23-cycle unchanged-head repair trace. `npm run check` passed lint, production build, and all 261 automated tests.
- Live acceptance created and pushed `acceptance/orchestra-jules-handoff-20260830` at `6cb24ef329339acc1972e4b9ff6e25f908b923ae`; Wiring `main` remained at that same SHA. Two dispatch attempts failed closed before a remote Jules session was created because Jules did not advertise Orchestra's exact temporary dispatch branch after push. The run therefore did not exercise plan/repair/reconnect/integration. This live failure also exposed and fixed definite-rejection task cleanup so rejected dispatch tasks become `failed` and cloud tasks with no remote session can be cancelled locally.

### 2026-08-30 live acceptance-run corrective inventory

The Wiring simulation task completed the full provider path and ultimately passed, but the durable task history exposed the following platform defects and efficiency failures. Treat these counts and outcomes as the regression baseline for the corrective work:

- **End-to-end result:** Jules dispatched, produced a plan, implemented the feature, created PR #2, received local verification/review feedback, repaired the branch, passed deterministic verification and independent Codex review, fast-forwarded `main`, and synchronized local `F:\Wiring` to commit `6cb24ef329339acc1972e4b9ff6e25f908b923ae`.
- **Plan-review overuse:** Orchestra performed 13 full Codex Terra plan reviews: 12 BLOCK decisions followed by 1 PASS. Each revision was largely reviewed from scratch instead of using a cheap delta/checklist gate and escalating only unresolved risk.
- **Incremental finding discovery:** The plan reviewer surfaced acceptance-critical electrical/UI/test contracts one revision at a time. Preserve all accepted requirements and prior findings in a cumulative checklist so Jules receives a consolidated correction packet and later reviewers do not rediscover adjacent gaps serially.
- **Fixed-cap stalls and warning storm:** The task hit review ceilings at 3, 6, and 12 plans. Eleven `JULES_PLAN_REVIEW_CAP` warnings were persisted, including repeated 12-plan warnings while the same state was polled. Progressing plan identities must not be stopped by arbitrary totals, and any true attention event must be emitted idempotently once.
- **Manual continuation still required:** After automatic plan approval, the user still had to send `yes run the final checks and wrap it up.` before Jules continued. Every provider clarification/action request must be detected, locally triaged, answered, and monitored automatically unless it requires new user authority.
- **Repair-loop storm:** Orchestra issued 23 repair requests and observed 24 provider-completed events. Eighteen repair cycles reused the same findings against an unchanged PR head, often approximately ten seconds apart. After feedback, Orchestra must wait durably for a new provider activity/head SHA (with backoff and an idempotent outstanding-repair identity) instead of treating unchanged completion as permission to resend.
- **Verification failures were correctly caught but inefficiently relayed:** Repair batches included lint failures, TypeScript/build failures, missing test imports/types, and one independent code-review BLOCK before the final PASS. Deterministic failures should be distilled locally, deduplicated, grouped into one actionable packet, and routed through Gemma/Luna before escalating review cost.
- **Provider completion is not a unique workflow completion:** Jules repeatedly returned a completed state while feedback/repair remained active. Orchestra must distinguish provider snapshot completion, unchanged-head completion, repair acknowledgement, new-head readiness, locally reviewed completion, and integrated task completion.
- **Codex-capacity recovery:** Exhausted Codex usage previously left the workflow unable to continue even after capacity returned. Persist exact pending work, apply quota-aware backoff/model fallback, and automatically resume the same handoff without a duplicate Jules session or manual prompt.
- **Approval UI deficiencies:** The plan-approval card did not expose the actual plan being approved and allowed repeated approval clicks without making idempotency/progress clear. Show the reviewed plan, reviewer/tier, verdict, current command state, and disable or reconcile duplicate actions.
- **Dashboard reconnect/state hydration bug:** After successful integration, the UI showed `Unable to connect to Orchestra backend (Failed to fetch)` and retained a stale `Running` panel even though the backend recovered and the durable task was `completed`. Reconnect must refetch authoritative task/session state, clear obsolete transport errors, and render terminal status consistently.
- **Rider resource degradation:** During related local inspection activity, Rider reported low memory, froze, and made read attempts fail until the IDE process was restarted. Rider MCP must be optional and circuit-broken on latency/memory/failure signals, with automatic fallback to bounded filesystem evidence rather than blocking the workflow or repeatedly probing a frozen IDE.
- **Required regression acceptance:** A comparable live Jules task should complete without user relay messages; without duplicate plan approval; without repeated unchanged-head repair messages; with local-first tier selection visible; with bounded provider-review calls; and with the dashboard accurately restoring the final state after a backend/frontend interruption.

## 2026-08-31 — Durable Jules continuation completion gate

- **Automatic provider continuation:** `JulesHandoffService` now persists a response before dispatching the matching command intent, distinguishes acknowledgement from an observed provider resume, and bounds retries without a second model decision. The live PR #3 session resumed from `AWAITING_USER_FEEDBACK` after Orchestra's Terra decision with no user relay.
- **Completed-worker repair semantics:** `COMPLETED` is no longer treated as a cloud-repair-capable state. An acknowledged repair that ends on the same PR head is a confirmed unavailable worker and transitions exactly once to the imported-head local takeover path; it cannot produce an unchanged-head cloud feedback storm.
- **Restart safety:** Startup releases only stale process-local `jules-review-*` Git leases, then resumes a prepared local takeover through the normal preflight gate. The task-state contract now explicitly permits `recovering -> preflight` for that safety check.
- **Acceptance evidence:** `npm run check` passed lint, production client/server build, and **267 automated tests**. Focused handoff, repair, restart-recovery, and state-transition tests also pass. The live acceptance task on `acceptance/orchestra-jules-handoff-20260830` was restarted twice and restored automatically from its persisted checkpoints; it is currently executing the authorized local repair on the reviewed PR head. `Wiring` `main` has not been touched.

## 2026-08-31 — Local Codex capacity continuation

- Local Codex quota/usage/rate-capacity errors are now a checkpointed exponential wait (one to fifteen minutes), not a terminal workflow error.
- Retry wake-ups validate their persisted shape, survive Orchestra restart, and resume the original local task even if capacity was exhausted before any implementation file existed.
- Startup repairs only exact legacy local capacity failures; all other failed tasks stay failed. Focused build and startup-recovery tests pass.

## 2026-09-01 — Automatic local continuation after restart

- Removed the fixed local repair-cycle ceiling. Existing loop detection still fails closed on stagnant diffs, oscillation, or three repeated blocker sets.
- Restart-marked local work with preserved changes is re-enqueued automatically; intentionally paused/stopped tasks and prepared Jules takeovers are excluded.
- Focused startup-recovery and review-loop tests pass.

## 2026-09-01 — Acceptance run completed

- Cloud Jules plan/feedback automation, completed-worker local takeover, capacity recovery, restart recovery, deterministic verification, independent review, and automatic repair all ran without a user relay.
- Final task: `ae7cb5eb-0721-456a-bd50-1d5e4202efb4`; state `completed`; pushed commit `6b10756fbaaa466e9377e2e27b26f8e51b42020e` on `acceptance/orchestra-jules-handoff-20260830`.
- `F:\Wiring` was clean and synchronized at that SHA. Orchestra `npm run check` passed lint, production builds, and all automated tests.

## 2026-09-07 — Ripwire deterministic code-context & quality-gate integration

- Integrated Ripwire (`F:\Ripwire\ripwire-0.5.0\ripwire-0.5.0\build\ripwire.exe`) across Orchestra Command Center pipeline stages:
  - **Environment sensor**: Non-blocking sync detection of `ripwire.exe`; added `ripwire` to `SystemCapabilities`.
  - **Stage 2 (Refinement)**: Runs `ripwire --for="<prompt>" --max-tokens=4000` to orient Gemma/Codex Luna with ranked symbol call-graphs before technical spec decomposition.
  - **Stage 5 (Builder)**: Gathers `ripwire --for` + `ripwire --situ` (blast radius & test coverage), feeds this into the Antigravity prompt, and injects Ripwire binary directory into `PATH` for the `agy` process so the agent can execute targeted lookups (`--expand=SYM --top-k=0`, `--callers=SYM`, `--impact=SYM`).
  - **Stage 7 (Review / Repair)**: Enriches repair cycles with `ripwire --quality-delta` (what the agent's edits broke) and `ripwire --test-gate` (minimal test set to run).
  - **Resilience**: Every Ripwire call is bounded (30s) and returns `null` on failure/absence; all consumers use optional chaining (`ctx.capabilities?.ripwire?.available`) with zero-downtime fallback.
- **Verification**: `npm run build:server` succeeded; full test suite passed (**273/273 tests passing, 0 failures**).
