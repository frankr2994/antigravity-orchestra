# Antigravity Orchestra

Antigravity Orchestra is a Windows-first, local command center for running a project-scoped software-development workflow across three AI agents:

- **Gemma in LM Studio** classifies requests, answers bounded repository questions, validates results, and explains active runs.
- **Google Antigravity** researches and implements changes.
- **OpenAI Codex** provides independent design, debugging, and code review.

You select a project directory once and work from Orchestra's web dashboard. Each request is routed automatically, every agent is pinned to that directory, and file-changing tasks continue through implementation, review, repair, verification, commit, and push without requiring you to launch separate CLIs in the project folder.

> **Status:** Active local development. The dashboard is functional and used for real projects, but provider CLIs and their structured output formats are still evolving.

## Dashboard

### Live task execution

![Orchestra live run monitor showing agent progress, project changes, context pressure, and project-scoped chat](docs/images/live-run-monitor.png)

The run monitor shows the current phase, active agent, elapsed time, review cycle, changed files, recent timeline, provider context, and sanitized agent activity. You can ask Gemma questions about the active run without interrupting it.

### System, quota, and MCP status

![Orchestra system telemetry, provider quota, and Rider MCP status](docs/images/system-and-mcp-status.png)

The dashboard tracks local system load, agent availability, provider quota, and JetBrains Rider MCP health. Rider is probed with a real MCP initialization and tool-list exchange rather than being considered healthy merely because a configuration file exists.

## What Orchestra Does

- Keeps every conversation and task attached to an explicit project directory.
- Routes simple repository questions to the local Gemma model when evidence is sufficient.
- Escalates design, debugging, testing, and review work to Codex.
- Sends Codex analysis to Antigravity for implementation.
- Runs independent Codex review after changes are made.
- Automatically returns blocking findings to Antigravity for repair.
- Runs bounded project verification before accepting a change set.
- Creates a handoff entry, commits reviewed files, and pushes through Git.
- Preserves partial task changes after failures or dashboard restarts.
- Shows live task health, repair cycles, changed files, context pressure, and quota.
- Detects Rider MCP availability separately for Antigravity, Codex, and Gemma.
- Supports a least-privilege, read-only Rider tool bridge for Gemma.
- Performs narrowly validated local operations, such as connecting a clean project to an empty GitHub remote, without wasting a three-agent cycle.

## Automatic Workflow

```text
User request
    |
    v
Gemma classification and routing
    |
    +-- safe, small repository question --> Gemma evidence answer
    |
    +-- bounded local operation ----------> Orchestra adapter
    |
    +-- design/debug/review --------------> Codex specialist
                                                |
                                                v
                                      Antigravity implementation
                                                |
                                                v
                                          Codex review
                                                |
                              +-----------------+-----------------+
                              |                                   |
                         blocking finding                       pass
                              |                                   |
                              v                                   v
                     Antigravity repair                 verification + Git
```

Explicit implementation language is normalized deterministically, so a model cannot accidentally turn “plan and implement” into a read-only task. Short approvals such as `proceed`, `continue`, and `do it` inherit the preceding completed task in the same conversation. A mutating task that produces no project changes is retried once and is never reported as successfully completed without evidence of implementation.

## Agent Responsibilities

| Agent | Primary responsibilities | Project authority |
|---|---|---|
| Gemma | Classification, bounded repository answers, postflight checks, summaries, run explanations | Read-only evidence and allowlisted Rider inspection tools |
| Antigravity | Repository research, implementation, repairs, synchronous verification | File changes within the selected project |
| Codex | Architecture, root-cause analysis, test design, independent review | Read-only analysis |
| Orchestra | Task state, project isolation, recovery, verification, commits, pushes, telemetry | Validated local adapters and dashboard-owned Git finalization |

Model selection is automatic. Deep or sensitive work uses stronger reasoning profiles; small work can use faster models, and quota pressure may move only non-critical work to a cheaper model. Required design and review roles are not skipped merely to save quota.

## Context and Quota Awareness

Codex runs through its app-server protocol, allowing Orchestra to record the current thread, turn, context-window use, token activity, cancellation, and quota. Each Codex role and review cycle starts with a fresh ephemeral thread.

Antigravity usage is collected from its supported usage output and stream telemetry. When an authoritative context percentage is unavailable, Orchestra says so rather than inventing one. Large prior turns can cause Orchestra to rotate the provider conversation while retaining compact local session memory.

## Rider MCP

Orchestra currently provides:

- Live server identity, version, endpoint, latency, and tool count.
- Agent-specific configured, enabled, available, and access states.
- Full native Rider MCP configuration for Antigravity.
- Native Rider MCP configuration for Codex, while Codex remains instruction-bound to read-only work.
- A loopback-only Gemma bridge exposing a bounded allowlist of read-only Rider tools.

Capability-aware preference instructions and detailed per-tool timeline reporting are planned next. Today, Antigravity and Codex discover Rider through their native MCP configurations, while Gemma is explicitly given its allowed Rider tools during eligible repository-answer turns.

## Git Safety and Recovery

File-changing tasks require a Git repository. Orchestra:

1. Detects pre-existing changes and requires a separate reviewed baseline.
2. Keeps `.orchestra/`, logs, caches, and generated state out of project commits.
3. Prevents agents from owning final commits or pushes.
4. Reviews the complete uncommitted change set with Codex.
5. Runs detected project checks synchronously.
6. Adds a `docs/HANDOFF.md` entry.
7. Commits only the reviewed project paths and pushes the current branch.

If a provider fails after creating files, Orchestra preserves those changes and exposes a recovery action. Recovery continues the same task's implementation/review ownership instead of misclassifying its partial files as an unrelated baseline.

## Requirements

### Required

- Windows 10 or 11
- PowerShell 5.1 or newer
- Node.js 22 or newer and npm
- Git
- Google Antigravity CLI (`agy`), authenticated
- OpenAI Codex CLI, authenticated
- LM Studio with its OpenAI-compatible server enabled
- `gemma-4-e2b-it-qat` loaded by default, or `LM_STUDIO_MODEL` set to another tool-capable local model

### Optional

- JetBrains Rider with its MCP server enabled
- NVIDIA GPU for local-model and system telemetry
- A GitHub remote for automatic push finalization

## Quick Start

```powershell
git clone https://github.com/frankr2994/antigravity-orchestra.git
Set-Location .\antigravity-orchestra
.\Start-Orchestra.ps1
```

The launcher installs dashboard dependencies when needed and starts both the local API and Vite dashboard. Open the URL printed by Vite, normally:

```text
http://127.0.0.1:5173
```

Then:

1. Select **Browse project** and choose the repository you want the agents to use.
2. Review onboarding status and any existing-change warning.
3. Create or select a conversation.
4. Enter the complete request once; Orchestra owns routing and continuation.
5. Follow the live monitor, or ask Gemma about the run while it remains active.

The backend listens only on loopback by default and uses a per-process dashboard token for state-changing API requests.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ORCHESTRA_PORT` | `3001` | Local API port |
| `ORCHESTRA_DATA_DIR` | `%LOCALAPPDATA%\AntigravityOrchestra` | SQLite database and runtime state |
| `ORCHESTRA_TEMPLATE_ROOT` | Repository root | Managed project-onboarding template |
| `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible API |
| `LM_STUDIO_MODEL` | `gemma-4-e2b-it-qat` | Local routing and monitoring model |

Runtime conversations and task events are stored in SQLite under the local application-data directory, not in the selected project.

## Development

```powershell
Set-Location .\orchestra-dashboard
npm install
npm run dev
```

Run the complete quality gate with:

```powershell
npm run check
```

This runs linting, the TypeScript/server and Vite production builds, and the Node regression suite.

## Repository Layout

```text
orchestra/
|-- Start-Orchestra.ps1          # supported dashboard launcher
|-- orchestra-dashboard/
|   |-- src/                     # React command center
|   |-- server/                  # Express API, routing, agents, Git, MCP
|   |-- scripts/                 # development and telemetry helpers
|   `-- tests/                   # routing, recovery, protocol, and Git tests
|-- .agents/                     # Antigravity rules, workflows, and skills
|-- .codex/                      # Codex role boundary
|-- docs/
|   |-- DESIGN.md                # architecture decision history
|   |-- HANDOFF.md               # incremental implementation handoff
|   `-- images/                  # README screenshots
`-- examples/                    # example project material
```

## Current Limitations

- Windows is the supported host platform today.
- The dashboard is designed for a trusted, single-user loopback environment.
- Antigravity's context percentage is shown only when a trustworthy provider source is available.
- Generic Codex command failures are currently sanitized into a fallback notice; richer safe error reporting is planned.
- Rider health proves protocol availability, not that an agent used Rider during a particular turn.
- MCP enable/disable management is not yet exposed in the UI.
- Real-time multi-user collaboration is out of scope.

## Documentation

- [Architecture decisions](docs/DESIGN.md)
- [Current handoff](docs/HANDOFF.md)
- [Execution walkthrough](docs/walkthrough.md)
- [Legacy Japanese guide](README.ja.md)

## License

[MIT](LICENSE)

## Acknowledgments

The original repository was inspired by Claude Code Orchestra and the Antigravity/Codex delegation pattern. This fork has evolved into a project-scoped tri-agent command center with local-model routing, automatic review and repair, observability, recovery, Git finalization, and MCP health monitoring.
