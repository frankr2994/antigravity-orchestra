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

