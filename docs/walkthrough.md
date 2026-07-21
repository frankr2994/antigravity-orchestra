# Walkthrough: `/startproject` Full Cycle — Execution Summary with Real Codex Transcripts

This document walks through one real run of the `/startproject` workflow in **Antigravity Orchestra**. The Antigravity-side phases are summarized in prose; the code blocks are excerpts from actually captured output (`check.ps1` doctor, Codex design review, Codex final review) with machine-specific paths sanitized.

---

## 1. Prerequisites & Environment Check

Before starting a new project or feature, run the environment check script to verify tool installations and configuration layouts:

```powershell
.\.agents\skills\codex-system\scripts\check.ps1
```

**Real Execution Output**:
```text
=== Antigravity Orchestra Doctor ===
Repo root: <repo-root>

[OK  ] Codex CLI: <path-to-codex>\codex.exe (codex-cli 0.144.6)
[OK  ] Codex auth: Logged in using ChatGPT
[OK  ] Antigravity CLI: <path-to-agy>\agy.exe (v1.1.5)
[OK  ] Layout: AGENTS.md
[OK  ] Layout: .agents\rules
[OK  ] Layout: .agents\skills\codex-system\SKILL.md
[OK  ] Layout: .agents\skills\codex-system\scripts\ask_codex.ps1
[OK  ] Layout: .agents\skills\codex-system\scripts\review.ps1
[OK  ] Layout: .agents\skills\codex-system\scripts\CodexHelpers.psm1
[OK  ] Layout: .agents\workflows
[OK  ] Layout: .codex\AGENTS.md
[OK  ] Layout: logs\codex-responses
[OK  ] .gitignore excludes logs/codex-responses

Result: all checks passed (0 WARN).
```

---

## 2. `/startproject` 6-Phase Workflow

In this example, we build a simple Python CLI TODO application under `examples/demo-todo/` using `/startproject`.

### Phase 1: Research (Antigravity)
Analyze requirements, project layout, and library options. Save research notes to `docs/research/demo_todo.md`.

### Phase 2: Requirements & Draft Plan (Antigravity)
Define scope (`add`, `list`, `complete` subcommands), storage contract (`tasks.json`), and Python standard library constraints (`argparse`, `json`, `unittest`).

### Phase 3: Design Review (Delegated to Codex CLI)
Delegate the draft architecture to Codex CLI via `ask_codex.ps1`:

```powershell
.\.agents\skills\codex-system\scripts\ask_codex.ps1 -Mode "design" `
    -Question "Review implementation plan for demo-todo CLI app" `
    -Context "(Draft plan details...)"
```

**Codex Review Transcript (Excerpt)**:
```text
=== Consulting Codex CLI (design) ===
Question: Review implementation plan for demo-todo CLI app

1. Plan Assessment:
   - Clean separation between TaskManager and CLI interface.
2. Risk Analysis:
   - Interrupted writes: Use atomic replacement (os.replace) via temporary file.
   - Corrupt JSON: Do not silently overwrite corrupted state with an empty list.
   - ID allocation: Use monotonic integer IDs (max(id) + 1).
3. Refinements:
   - Exit codes: stderr + exit(1) on invalid IDs or corrupted storage.
   - Injectable db_path seam for test isolation.
```

### Phase 4: Task List Creation (Antigravity)
Synthesize research, requirements, and Codex feedback into an actionable checklist.

### Phase 5: Documentation Update (Antigravity)
Record architectural decisions in `docs/DESIGN.md` under `## 設計決定履歴`.

### Phase 6: Implementation & Quality Assurance (Antigravity + Codex)
Implement `examples/demo-todo/todo.py` and unit tests in `examples/demo-todo/test_todo.py`. Run tests and execute `review.ps1`.

---

## 3. Automated Code Review with `review.ps1`

Run `review.ps1` to inspect all uncommitted changes across staged, unstaged, and untracked files:

```powershell
.\.agents\skills\codex-system\scripts\review.ps1
```

**Codex Review Transcript (Excerpt)**:
```text
=== Consulting Codex CLI (review) ===

1. Verification of Previous Findings
   - [P1] CLI Test Isolation: Fixed (db_path injected in tests).
   - [P1] Test Discovery Spec: Fixed (explicit discovery command updated in docs/DESIGN.md).
   - [P2] Data Preservation: Fixed (RuntimeError raised on corrupted JSON).

2. Summary & Recommendation
   - All 9 unit tests pass.
   - Approved for commit.
```

---

## 4. Verification Command

Run the unit test suite to verify all 9 test cases pass:

```powershell
python -m unittest discover -s examples/demo-todo
```

Output:
```text
.........
----------------------------------------------------------------------
Ran 9 tests in 0.020s

OK
```

---

## 5. Next Steps

To copy this orchestration environment to your own repository:

1. Copy `.agents/`, `.codex/`, `AGENTS.md`, and `docs/` (the `DESIGN.md` template) to your repository root.
2. Create the log directory the scripts write to: `mkdir logs\codex-responses` (the doctor treats it as required).
3. Run `.\.agents\skills\codex-system\scripts\check.ps1` — it should report no FAIL.
4. Start development using `/startproject` or `/plan` slash workflows in the interactive `agy` session.
