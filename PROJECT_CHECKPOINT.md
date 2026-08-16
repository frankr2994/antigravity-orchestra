# Antigravity Orchestra — Master Project Checkpoint

> **Version:** `v1.0.7` | **Status:** Production-ready local command center | **Primary Runtime:** Windows (PowerShell / Node.js 22+)

This document serves as an authoritative, high-density context snapshot of **Antigravity Orchestra**. It encapsulates the architecture, features, database schema, agent role boundaries, directory layout, and roadmap so any new chat session or developer can immediately resume work without context loss.

---

## 1. Core Architecture & Multi-Agent Model

Orchestra orchestrates a project-scoped tri-agent pipeline designed to maximize quality, eliminate hallucinations, and minimize cloud token costs:

```text
User Request (Project-scoped)
    │
    ▼
1. Gemma on LM Studio (0 Cloud Tokens)
   ├── Fast Intent Classification (Question vs Mutation vs Greenfield)
   ├── Bounded Repository Q&A (0 cost)
   ├── Error Distillation (Extracts actionable repairs from raw logs)
   └── Semantic Conventional Commit Slicing
    │
    ▼
2. OpenAI Codex CLI (Read-Only Specialist)
   ├── Architecture Design & TDD Plan
   ├── Root-Cause Bug Diagnosis
   └── Independent Code Review & Verification Verdicts
    │
    ▼
3. Google Antigravity CLI (Mutating Builder)
   ├── Repository Research (1M Context)
   ├── Code Implementation & Edits
   └── Synchronous Verification & Repairs
    │
    ▼
4. Orchestra Platform Engine
   ├── Git Safety, Commit Slicing, and Push Finalization
   ├── Universal MCP Server Health & Process Management
   ├── Time-Travel Checkpoint & Rollback Management
   └── Telemetry, Quota Tracking & 5-Tier Adaptive Routing
```

---

## 2. Master Feature Suite (As of `v1.0.7`)

### ⚡ 100% Dynamic Model & Reasoning Discovery
* **Antigravity CLI**: Dynamically queried via `agy.exe models` (e.g. `gemini-3.7-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`). All hardcoded legacy `2.5` model references removed.
* **Codex CLI**: Dynamically queried via `codex.exe debug models` and `~/.codex/config.toml` (e.g. `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`).
* **Adaptive Reasoning Efforts**: Dropdown selectors dynamically populate the exact reasoning effort levels supported by the selected model (`Low`, `Medium`, `High`, `Xhigh`, `Max`, `Ultra`).
* **LM Studio Models**: Real-time auto-detection of loaded memory-resident models (`state === 'loaded'`).

### ⏳ Time-Travel Checkpoints & Safety Rollback
* **Interactive Timeline**: Visual history of Git commits, task associations, and multi-file diff breakdowns.
* **1-Click Rollback**: Revert project to any commit snapshot.
* **Safety Stash Protection**: Automatically stashes uncommitted changes before rollback to prevent accidental data loss.
* **Prompt Reloading**: 1-click reloads the original task prompt back into Composer for iteration.
* **Manual Checkpoints**: 1-click snapshot creation with custom message.

### 🎭 Direct Solo Model Mode & 1-Click Promotion
* **Solo Agents**: Focused 1-on-1 interaction with `Gemma Solo` (0 cloud tokens), `Codex Solo` (deep architecture/review), or `Antigravity Solo` (research Q&A).
* **Dynamic Pickers**: User directly selects exact models and reasoning effort.
* **1-Click Promotion**: `Implement with Orchestra` button on any solo message seamlessly converts brainstormed plans into a full autonomous implementation and review task.

### 🛡️ Quota-Tier Policy Routing
* **5 Configurable Quota Tiers**: `>20%`, `15–20%`, `10–15%`, `5–10%`, `<5%`.
* Fully customize which Antigravity model, Codex review model, and reasoning effort level to run at each quota threshold directly in the Settings UI.

### 🔌 Universal MCP Server Registry
* Discovers all MCP servers installed on the host across Antigravity and Codex configurations (`mcp_config.json`, `mcp.json`, `config.toml`).
* Real-time live health probing (endpoint, latency, tool count, version).
* Supports both Streamable HTTP/SSE and STDIO subprocess servers.
* Global 1-click enable/disable toggle synchronously updates configs and terminates processes.

### 💬 Dynamic Conversation Titles & Session Controls
* **Auto-Naming**: Automatically parses initial prompt intent and names new chat sessions with clean, descriptive titles.
* **Inline Rename (✏️)**: Inline text editor to rename any conversation (`Enter` to save, `Esc` to cancel).
* **Delete / Reset (🗑️)**: 1-click deletion with confirmation or reset for single sessions.

### 🧊 3D Neural Asset Forge & Vision Inspection Loop
* **Direct ComfyUI + TripoSR Integration**: Native neural mesh reconstruction executed directly on local GPU (RTX 2080 Ti) in ~20 seconds.
* **Embedded Trimesh Converter**: Automatically extracts high-density 3D models with vertex colors and converts `.obj` meshes into optimized `.glb` binaries.
* **Gemma 12B Vision Quality Review**: Autonomous multimodal inspection via LM Studio (`gemma-4-12b-it-qat`) providing instant score cards (0-100), topological critiques, and prompt repair tips with $0 cloud token cost.
* **Interactive Three.js WebGL Viewport**: Full Orbit controls (rotate, pan, zoom), PBR Shaded / Clay Matcap / Wireframe render modes, real-time vertex & face count meters, and 1-click `.GLB` export.

---

## 3. Repository Structure & Key Components

```text
orchestra/
|-- Start-Orchestra.bat           # Windows double-click launcher
|-- Start-Orchestra.ps1           # PowerShell launcher (auto-installs and starts Vite + API)
|-- ROADMAP_DEV_FLOW.md           # Specification for #2 Developer Flow features
|-- PROJECT_CHECKPOINT.md         # This master context checkpoint
|-- orchestra-dashboard/
|   |-- src/
|   |   |-- App.tsx               # Main React dashboard, views, solo mode & chat
|   |   |-- index.css             # Unified modern CSS design system
|   |   `-- main.tsx              # React bootstrap
|   |-- server/
|   |   |-- index.ts              # Express API & SSE routes
|   |   |-- db.ts                 # SQLite database & migrations (WAL mode)
|   |   |-- tasks.ts              # Tri-agent state machine & repair loop
|   |   |-- agents.ts             # Gemma, Antigravity, and Codex child runners
|   |   |-- telemetry.ts          # Live system, quota, and dynamic model discovery
|   |   |-- git.ts                # Git checkpoints, diffs, safe rollbacks, and commits
|   |   |-- mcp.ts                # Universal MCP registry & config parsers
|   |   `-- types.ts              # Shared TypeScript definitions
|   `-- tests/                    # 64 regression and unit test suites
|-- .agents/                      # Orchestrator skills, rules, and workflows
|   |-- skills/                   # codex-system, design-tracker, local-git-logger, research...
|   |-- workflows/                # /startproject, /plan, /tdd, /simplify, /checkpoint, /init
|   `-- rules/                    # Role boundaries, delegation triggers, security, testing
|-- .codex/                       # Codex role boundary rules
`-- docs/
    |-- DESIGN.md                 # Architecture decision records
    |-- HANDOFF.md                # Implementation progress log
    `-- walkthrough.md            # Execution guide
```

---

## 4. Master Roadmap & Next Milestones

### 1. Developer Flow & Live Visibility (Detailed in `ROADMAP_DEV_FLOW.md`)
* **Live Terminal / Stdout Drawer**: Monospace expandable console in the Run Monitor streaming real-time stdout/stderr from test runners and build scripts.
* **Pre-Commit Diff Review & Partial Staging**: Interactive file diff inspection before final Git commits with checkboxes to exclude specific files.
* **Git Branch Switcher & Creator**: In-dashboard branch dropdown and `+ New Branch` creator on the active project card.

### 2. Tri-Model Benchmark Engine
* Direct head-to-head comparison tool: Run a test prompt across **Solo Antigravity**, **Solo Codex**, and **Tri-Agent Orchestra**.
* Measures: Execution time, cloud token cost, repair cycles, and unit test pass rates to prove Orchestra delivers equal/better results for less cost.

### 3. Local Generative 3D, Image & Video Loop (Exploration Target)
* **Pipeline**:
  1. *Generation*: Local ComfyUI / SDXL / Flux (Images), TripoSR / InstantMesh / Blender Python (3D), Wan2.1 / SVD (Video).
  2. *Vision Critic (Reviewer)*: Local Vision LLM (e.g. Qwen2.5-VL / Gemma-Vision in LM Studio) inspects rendered turntable angles / image frames against prompt.
  3. *Auto-Repair Loop*: Iteratively adjusts parameters, inpainting masks, or Blender geometry scripts until vision critic passes.
