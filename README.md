# Antigravity Orchestra

Antigravity Orchestra is a Windows-first, local command center for running a project-scoped software-development workflow across three AI agents:

- **Gemma in LM Studio** classifies requests, answers bounded repository questions, distills verification errors, slices atomic conventional commits, and explains active runs.
- **Google Antigravity** researches, plans, and implements codebase changes.
- **OpenAI Codex** provides independent architecture design, debugging, and strict code review.

You select a project directory once and work from Orchestra's unified web dashboard. Each request is routed automatically, every agent is pinned to that directory, and file-changing tasks continue through implementation, review, repair, verification, atomic Git commit slicing, and push.

> **Latest Release:** [v1.0.0 on GitHub Releases](https://github.com/frankr2994/antigravity-orchestra/releases) — Download the pre-packaged Windows bundle and double-click `Start-Orchestra.bat` to launch.

---

## Key Features & Superpowers

### 1. Tri-Agent Execution Pipeline
```text
User request
    │
    ▼
Gemma Classification & Routing
    │
    ├── Safe repository Q&A ───────────────► Local Gemma Answer (0 tokens)
    ├── Bounded local Git operation ───────► Orchestra Git Adapter
    └── Implementation / Refactor / Fix
            │
            ▼
        Codex Specialist Design & Strategy
            │
            ▼
        Antigravity Implementation
            │
            ▼
        Codex Independent Review
            │
        ┌───┴───────────────────────────────┐
        ▼                                   ▼
    Blocking Findings                      Pass
        │                                   │
        ▼                                   ▼
    Gemma Error Distillation        Project Verification
        │                                   │
        ▼                                   ▼
    Antigravity Repair Turn         Gemma Semantic Commit Slicing
        │                                   │
        └──────────────────────────► Atomic Git Commits & Push
```

### 2. Direct Solo Model Mode & 1-Click Orchestra Promotion
Toggle between full multi-agent orchestration and direct, conversational chat with individual models:
- **🎭 Orchestra (Tri-Agent)**: Full autonomous build, review, verification, and Git push.
- **⚡ Gemma Local**: Fast, zero-cost Q&A on local LM Studio without consuming cloud quota.
- **🛡️ Codex Direct**: Deep architecture and semantic code consultation with GPT-5.6 paired with JetBrains Rider MCP inspection without mutating files.
- **✨ Antigravity Direct**: Read-only codebase research across 1M tokens of Gemini context.
- **🚀 Implement with Orchestra**: A 1-click button on solo chat messages turns any brainstormed plan into a fully orchestrated implementation task.

### 3. Universal MCP Server Registry & Global Toggle Control
Orchestra discovers and monitors all Model Context Protocol servers configured across Antigravity and Codex:
- **JetBrains Rider MCP**: Solution-aware semantic inspection and symbol navigation.
- **Godot Engine MCP**: Scene, script, physics, and UI inspection (`godot-mcp-enhanced`).
- **Meta XR Operator MCP**: Meta Quest VR spatial testing and debugging.
- **Unreal Engine Vibe MCP**: Live Unreal Engine automation and Python subsystems.
- **Meta Horizon / Quest Developer Hub MCP**: Device and OS debugging.
- **One-Click Global Toggles**: Enable or disable any MCP server across all models simultaneously with automatic process cleanup.

### 4. Review Consensus & Dispute Resolution
When complex tasks reach their automatic repair limit without reaching full consensus, Orchestra preserves the diff and provides human-in-the-loop control:
- **Approve & Commit Diff**: Accept and finalize the preserved changes immediately.
- **Provide Steering Guidance**: Send direct custom instructions to guide Antigravity on the next repair turn.

### 5. Intelligent Git Finalization
- **Semantic Commit Slicing**: Gemma partitions large multi-file diffs into atomic conventional commits (`feat(ui)`, `feat(domain)`, `test(unit)`, `chore(deps)`).
- **Automated Verification**: Runs project test suites and linters before committing.
- **Git Push Protection**: Automatic push to upstream remote with safe credential isolation.

---

## Quick Start

### Method A: Download Pre-built Release (Recommended)
1. Download `orchestra-v1.0.0-windows-x64.zip` from [GitHub Releases](https://github.com/frankr2994/antigravity-orchestra/releases).
2. Extract the archive anywhere on your machine.
3. Double-click **`Start-Orchestra.bat`** (or run `.\Start-Orchestra.ps1` in PowerShell).
4. Open the Command Center in your browser at `http://127.0.0.1:5173`.

### Method B: Clone from Source
```powershell
git clone https://github.com/frankr2994/antigravity-orchestra.git
Set-Location .\antigravity-orchestra
.\Start-Orchestra.ps1
```

---

## Requirements

### Required
- Windows 10 or 11
- PowerShell 5.1 or newer
- Node.js 22 or newer and npm
- Git
- Google Antigravity CLI (`agy`), authenticated
- OpenAI Codex CLI, authenticated
- LM Studio with its local server enabled (default model `gemma-4-e2b-it-qat` or compatible)

### Optional
- JetBrains Rider with MCP server enabled (:64342)
- Godot Engine 4.x
- Unreal Engine 5.x
- Meta Quest Developer Hub
- NVIDIA GPU for local model acceleration and telemetry

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `ORCHESTRA_PORT` | `3001` | Local Express API port |
| `ORCHESTRA_DATA_DIR` | `%LOCALAPPDATA%\AntigravityOrchestra` | SQLite database and session state |
| `LM_STUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible endpoint |
| `LM_STUDIO_MODEL` | `gemma-4-e2b-it-qat` | Local Gemma model identifier |

---

## Development & Testing

```powershell
Set-Location .\orchestra-dashboard
npm install
npm run check
```

The quality gate runs oxlint, TypeScript compilation, Vite production build, and all 63 Node regression unit tests.

---

## License

[MIT](LICENSE)
