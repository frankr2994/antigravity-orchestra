# 🎼 Antigravity Orchestra

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue.svg)](#prerequisites)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Sora-bluesky/antigravity-orchestra/issues)

**🌐 Language: English | [日本語](README.ja.md)**

---

**Antigravity Orchestra** is a multi-agent development template that orchestrates [Google Antigravity](https://antigravity.google) (Gemini) and [OpenAI Codex CLI](https://github.com/openai/codex) for AI-powered development workflows.

Inspired by [Claude Code Orchestra](https://github.com/DeL-TaiseiOzaki/claude-code-orchestra) by @mkj (Matsuo Institute).

---

## ✨ What is This?

```
┌─────────────────────────────────────────────────────────────┐
│                        User                                 │
│                          │                                  │
│                          ▼                                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │    Google Antigravity (Orchestrator + Researcher)     │  │
│  │    → Gemini / large context window                   │  │
│  │    → User interaction, research, implementation       │  │
│  │                                                       │  │
│  │        ┌─────────────────────────────────────────┐    │  │
│  │        │   Codex CLI (via Skills scripts/)       │    │  │
│  │        │   → Design, Debug, Review               │    │  │
│  │        └─────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Single interface - Antigravity only.** Users interact only with the Antigravity CLI (`agy`), which delegates to Codex when needed. The same configuration also works in the Antigravity IDE.

---

## 🎯 Who is This For?

- Using Antigravity but want better design and review quality
- Finding it tedious to switch between multiple AIs
- Want code checked from both Google and OpenAI perspectives

---

## 🎭 Role Distribution

| Role | Agent | Tasks |
|------|-------|-------|
| **Orchestrator** | Antigravity | User interaction, task management, workflow control |
| **Researcher** | Antigravity | Library research, documentation search (large context window) |
| **Builder** | Antigravity | Code implementation based on Codex's design |
| **Designer** | Codex CLI | Architecture design, implementation planning, trade-off analysis |
| **Debugger** | Codex CLI | Root cause analysis, complex bug investigation |
| **Auditor** | Codex CLI | Code review, quality checks, TDD design |

---

## 📋 Prerequisites

| Requirement | How to Check | Notes |
|-------------|--------------|-------|
| Git | `git --version` | [git-scm.com](https://git-scm.com) if missing |
| PowerShell 5.1+ | `$PSVersionTable.PSVersion` | Ships with Windows; PowerShell 7 (`pwsh`) also works |
| Script execution allowed | `Get-ExecutionPolicy` | If `Restricted`, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Antigravity CLI (`agy`) | `agy --version` in PowerShell | [Official Site](https://antigravity.google) (IDE also works) |
| Codex CLI | `codex --version` in PowerShell | [Official installer](https://learn.chatgpt.com/docs/codex/cli) (below). npm route (`npm i -g @openai/codex`, requires Node.js) also works |
| Codex auth | Sign in with `codex login` | A supported ChatGPT plan or API key |

> **Note for non-Japanese users**: the agent instruction files in this template (`AGENTS.md`, `.agents/rules/`, `.agents/workflows/`, `.codex/AGENTS.md`) are currently written in Japanese. The agent responds and generates documents in **your** language (see `.agents/rules/language.md`), so the workflows work fine in English — but customizing the instruction files themselves currently requires reading Japanese (or letting the agent translate them for you).

---

## 🚀 Quick Start

### Step 1: Clone the Template

Run in PowerShell:

```powershell
# Navigate to your projects folder
cd C:\Users\YOUR_USERNAME\Documents\Projects

# Clone the template
git clone https://github.com/Sora-bluesky/antigravity-orchestra.git my-project

# Move into the project
cd my-project
```

### Step 2: Check Codex CLI

Confirm Codex CLI works in PowerShell:

```powershell
codex --version   # should print a version string
```

That's it — no path configuration needed. The scripts resolve `codex` from PATH automatically,
and the model is inherited from `~/.codex/config.toml`.

If it's not installed yet, use the [official installer](https://learn.chatgpt.com/docs/codex/cli) and authenticate with `codex login`:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

(`npm i -g @openai/codex` also works if you have Node.js.)

To diagnose the whole environment at once, run the doctor script:

```powershell
.\.agents\skills\codex-system\scripts\check.ps1
```

### Step 3: Open the Project with Antigravity CLI

Launch `agy` in the project folder:

```powershell
cd C:\Users\YOUR_USERNAME\Documents\Projects\my-project
agy
```

> ⚠️ **Use the interactive TUI for orchestra features.** In headless mode (`agy -p "..."`) the workspace customizations (`.agents/` skills and `AGENTS.md`) are **not** injected (verified on agy 1.1.5), so `/startproject`-style workflows will not fire. Headless mode is fine for plain one-shot questions only.

> **Prefer the IDE?** Opening this folder via **File → Open Folder** in the Antigravity IDE loads the same `.agents/` configuration.

### Step 4: Try It!

In agy's chat, type:

```
/startproject Hello World
```

These slash commands work because the root `AGENTS.md` maps them to `.agents/workflows/*.md` — if agy treats `/startproject` as plain text, check that `AGENTS.md` exists at the workspace root and that you launched `agy` inside the project folder.

Antigravity will automatically:

1. Analyze your project structure
2. Ask about requirements
3. Delegate design review to Codex
4. Create a task list
5. Document decisions in `docs/DESIGN.md`

> 💡 **See a real execution walkthrough**:
> Check out [docs/walkthrough.md](docs/walkthrough.md) for actual transcript excerpts and Codex reviews.


---

## 📁 Directory Structure

```
my-project/
├── AGENTS.md             # Entry-point rules agy reads first (slash-command map)
├── .agents/
│   ├── workflows/        # 6 workflows
│   │   ├── startproject.md   # Main workflow (6 phases)
│   │   ├── plan.md           # Implementation planning
│   │   ├── tdd.md            # Test-driven development
│   │   ├── simplify.md       # Refactoring
│   │   ├── checkpoint.md     # Session persistence
│   │   └── init.md           # Project initialization
│   │
│   ├── skills/           # 5 skills
│   │   ├── codex-system/     # Codex CLI integration
│   │   │   ├── SKILL.md
│   │   │   └── scripts/
│   │   │       ├── ask_codex.ps1     # Consultation (analyze/design/debug/review)
│   │   │       ├── review.ps1        # Change review (codex exec review)
│   │   │       ├── check.ps1         # Environment doctor
│   │   │       └── CodexHelpers.psm1 # Shared helpers
│   │   ├── design-tracker/
│   │   ├── research/
│   │   ├── update-design/
│   │   └── update-lib-docs/
│   │
│   └── rules/            # 8 rules
│       ├── delegation-triggers.md  # Auto-routing (Hooks alternative)
│       ├── role-boundaries.md      # Role separation
│       ├── language.md
│       ├── codex-delegation.md
│       ├── coding-principles.md
│       ├── dev-environment.md
│       ├── security.md
│       └── testing.md
│
├── .codex/               # Codex CLI configuration
│   └── AGENTS.md
│
├── docs/                 # Knowledge base
│   ├── DESIGN.md             # Design decisions
│   ├── walkthrough.md        # Real execution walkthrough (en/ja)
│   ├── research/             # Research results
│   └── libraries/            # Library constraints
│
└── logs/
    └── codex-responses/      # Codex consultation logs
```

---

## 📖 Workflows in Detail

### /startproject - Main Workflow (6 Phases)

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Antigravity (Research)                                │
│  → Repository analysis, library research                        │
│  → Output: docs/research/{feature}.md                           │
├─────────────────────────────────────────────────────────────────┤
│  Phase 2: Antigravity (Requirements)                            │
│  → Requirements gathering (goals, scope, constraints, criteria) │
│  → Draft implementation plan                                    │
├─────────────────────────────────────────────────────────────────┤
│  Phase 3: Codex CLI (Design Review)                             │
│  → Reviews Phase 1 research + Phase 2 plan                      │
│  → Risk analysis, implementation order suggestions              │
├─────────────────────────────────────────────────────────────────┤
│  Phase 4: Antigravity (Task Creation)                           │
│  → Integrate all inputs                                         │
│  → Create task list, get user confirmation                      │
├─────────────────────────────────────────────────────────────────┤
│  Phase 5: Antigravity (Documentation)                           │
│  → Record design decisions in docs/DESIGN.md                    │
├─────────────────────────────────────────────────────────────────┤
│  Phase 6: Codex CLI (Quality Assurance)                         │
│  → Post-implementation review by Codex                          │
│  → Unbiased quality assurance                                   │
└─────────────────────────────────────────────────────────────────┘
```

### /plan - Implementation Planning

Create a detailed implementation plan with Codex's help.

```
/plan Add user authentication
```

### /tdd - Test-Driven Development

Codex designs test cases, Antigravity implements Red-Green-Refactor cycle.

```
/tdd Login functionality
```

### /simplify - Refactoring

Simplify and improve code readability.

```
/simplify src/auth/login.py
```

### /checkpoint - Session Persistence

Save session state for later continuation.

```
/checkpoint          # Basic: history log
/checkpoint --full   # Full: includes git history and file changes
```

---

## 🛠️ Skills in Detail

### codex-system - Codex CLI Integration

The core skill for delegating design, debugging, and review to Codex.

**Trigger Keywords** (representative — the full list lives in [`.agents/skills/codex-system/SKILL.md`](.agents/skills/codex-system/SKILL.md), the single source of truth):

| Category | Examples |
|----------|----------|
| Design | "design", "architecture", "trade-off" |
| Debug | "why doesn't work", "error", "bug" |
| Review | "review", "check" |

**When NOT to use:**
- Simple file editing
- Research/investigation (Antigravity handles this)
- User conversation

### Other Skills

| Skill | Purpose |
|-------|---------|
| design-tracker | Track and record design decisions to docs/DESIGN.md |
| research | Library research and documentation |
| update-design | Update DESIGN.md |
| update-lib-docs | Document library constraints |

---

## 📏 Rules in Detail

### delegation-triggers.md (Most Important)

Replaces Claude Code Orchestra's 6 Hooks with Rules-based routing.

**Decision Flow:**

```
Receive user input
    │
    ▼
[Check 1] Design decision needed?
    → Yes: Suggest /plan or use codex-system skill
    │
    ▼
[Check 2] TDD needed?
    → Yes: Suggest /tdd (Antigravity doesn't design tests directly)
    │
    ▼
[Check 3] Debugging needed?
    → Yes: Use codex-system skill
    │
    ▼
[Check 4] Implementation complete?
    → Yes: Suggest review with codex-system skill
    │
    ▼
Antigravity executes directly (research, file editing, etc.)
```

### role-boundaries.md (Role Separation)

| Antigravity Does | Codex Does |
|------------------|------------|
| User interaction | Test design (TDD) |
| Library research | Architecture design |
| File editing | Trade-off analysis |
| Code implementation | Root cause analysis |
| | Code review |

**Quick Rule: "Does this need a design decision?" → Delegate to Codex**

### Other Rules

| Rule | Content |
|------|---------|
| language.md | Think and ask Codex in English; respond and generate docs in the user's language |
| codex-delegation.md | Detailed Codex delegation rules |
| coding-principles.md | Simplicity, single responsibility, early return |
| dev-environment.md | Development environment (uv, ruff, pytest, etc.) |
| security.md | Secret management, input validation |
| testing.md | TDD, AAA pattern, coverage goals |

---

## 💬 Basic Usage Examples

### Example 1: New Feature Development

```
/startproject User authentication
```

Antigravity automatically runs 6 phases.

### Example 2: Design Consultation

```
How should I design this feature?
```

Antigravity detects "design" keyword and delegates to Codex.

### Example 3: Debugging

```
I don't understand why this error occurs
```

Antigravity delegates root cause analysis to Codex.

### Example 4: Test-Driven Development

```
/tdd Login functionality
```

Codex designs test cases, Antigravity implements.

---

## ❓ FAQ

<details>
<summary><strong>Q: Can I use this without Codex CLI?</strong></summary>

Yes, but you'll lose the design review and debugging capabilities. Antigravity will handle everything directly, which may reduce code quality for complex projects.

</details>

<details>
<summary><strong>Q: Why is Codex called via PowerShell scripts?</strong></summary>

The scripts centralize prompt assembly, log saving, and error handling in one place. They resolve `codex` from PATH automatically and save results to `logs/codex-responses/`.

</details>

<details>
<summary><strong>Q: How do I update the paths if I reinstall Node.js?</strong></summary>

Nothing to do. The scripts resolve `codex` from PATH on every run, so as long as `codex --version` works, reinstalling changes nothing.

</details>

<details>
<summary><strong>Q: Can I customize the workflows?</strong></summary>

Yes! Edit the files in `.agents/workflows/`. Each workflow is a Markdown file with frontmatter (name, description) and step-by-step instructions. Note: these files are currently written in Japanese — ask the agent to translate one before editing if needed.

</details>

<details>
<summary><strong>Q: Do I need ChatGPT Plus or Pro?</strong></summary>

Plus ($20/month) is sufficient. Consider Pro ($200/month) if you need higher usage limits. API-key authentication is also supported by Codex CLI.

</details>

---

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| `running scripts is disabled on this system` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry |
| `/startproject` treated as plain text | Check `AGENTS.md` exists at the workspace root and `agy` was launched inside the project folder (interactive mode, not `-p`) |
| Codex skill not triggered | Explicitly say "Ask Codex about this" or use keywords (design, debug, review) |
| Codex CLI not found error | Run `codex --version` in PowerShell. If missing, use the [official installer](https://learn.chatgpt.com/docs/codex/cli) |
| Codex returns empty response | Check auth status with `codex login` |
| Role boundary violated | Explicitly say "Delegate TDD to Codex" |

---

## ⚠️ Important Notes

- **Google Antigravity is under active development.** Features and behavior may change.
- **Codex CLI requires a ChatGPT subscription.** Sign in via OAuth authentication.
- Check the [official site](https://antigravity.google) for the latest information.

---

## 🤝 Feedback

For bug reports or suggestions, please [open an issue](https://github.com/Sora-bluesky/antigravity-orchestra/issues).

---

## 🔗 Related Links

### References

| Resource | Author | Content |
|----------|--------|---------|
| [Claude Code Orchestra](https://zenn.dev/mkj/articles/claude-code-orchestra_20260120) | @mkj (Matsuo Institute) | Multi-agent coordination concept |
| [GitHub: claude-code-orchestra](https://github.com/DeL-TaiseiOzaki/claude-code-orchestra) | DeL-TaiseiOzaki | Implementation example |

### Tools

- [Google Antigravity](https://antigravity.google)
- [OpenAI Codex CLI](https://github.com/openai/codex)

### Related Articles (Japanese)

- [Antigravity Install Guide](https://zenn.dev/sora_biz/articles/antigravity-windows-install-guide)
- [Detailed Usage Guide (Zenn)](https://zenn.dev/sora_biz/articles/antigravity-orchestra-guide)

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

This project is inspired by **Claude Code Orchestra** by [@mkj](https://zenn.dev/mkj) (Matsuo Institute). The original architecture and concept of multi-agent coordination were adapted for Google Antigravity users.

---

📅 **Last Updated**: July 21, 2026
