# Developer Flow & Live Visibility Roadmap (#2 Features)

This document specifies the design, architecture, and planned implementation for the high-priority **Developer Flow & Live Visibility** features in Antigravity Orchestra.

---

## 1. Feature Specifications

### Feature A: Expandable Live Terminal & Command Stdout Drawer
* **Goal**: Provide developer transparency and instant feedback during builds, test execution (`npm test`, `cargo test`, `pytest`), linting, and background provider processes without cluttering the clean summary timeline.
* **UI/UX Design**:
  * An expandable, collapsible sliding drawer at the bottom of the **Live Run Monitor**.
  * Displays a monospace, dark-themed streaming console with ANSI-color support / clean terminal text.
  * Filter tabs: `All Output`, `Verification / Tests`, `Agent Commands`, `Git Operations`.
  * Auto-scroll lock toggle with manual scroll pause.
  * "Copy Output" button.
* **Architecture & Backend**:
  * Extend `server/process.ts` and `server/tasks.ts` to stream real-time chunked stdout/stderr lines as `task.stdout` SSE events.
  * Bounded ring buffer per task (e.g. last 1,000 lines) persisted in memory and accessible via `GET /api/tasks/:id/stdout`.

---

### Feature B: Interactive Pre-Commit Diff Review & Partial Staging
* **Goal**: Give developers granular control over what code modifications are reviewed by Codex and finalized into Git commits.
* **UI/UX Design**:
  * Before final Git commit and push, the Live Run Monitor displays an interactive **Changed Files** list with visual inline or side-by-side diff viewers.
  * Checkboxes next to each modified file allowing the user to uncheck / exclude temporary files, scratch files, or unwanted edits.
  * One-click "Approve & Commit Selected" or "Re-prompt Antigravity to Adjust".
* **Architecture & Backend**:
  * Update `server/tasks.ts` and `server/git.ts` to support selective path arrays in `sliceSemanticCommits` and `commitProjectChanges`.
  * Excluded files are left unstaged or stashed safely rather than committed.

---

### Feature C: Git Branch Switcher & Creator in Active Project Bar
* **Goal**: Allow seamless switching between feature branches (`feat/...`, `fix/...`, `main`) without switching to an external terminal.
* **UI/UX Design**:
  * The active project header card displays a clean branch badge dropdown with current branch name (e.g. `main` or `feat/codex-dynamic-models`).
  * Dropdown lists all local and remote Git branches with a search filter.
  * Includes a **"+ New Branch"** button that prompts for a branch name and runs `git checkout -b <branch_name>`.
* **Architecture & Backend**:
  * Endpoints:
    * `GET /api/projects/:id/branches` -> `{ current: string, branches: string[] }`
    * `POST /api/projects/:id/branches` -> `{ name: string, checkout?: boolean }`
    * `POST /api/projects/:id/branches/checkout` -> `{ name: string }`
  * Validates branch names for Git safety and guards against switching when uncommitted modifications exist without stashing.

---

## 2. Implementation Steps

1. **Backend Endpoints & Streaming**:
   * Add branch endpoints in `server/git.ts` and `server/index.ts`.
   * Add stdout ring buffer and SSE event channel for raw command output.
2. **Frontend Components**:
   * Build `TerminalDrawer.tsx` component with tabs, auto-scroll, and copy.
   * Build `BranchPicker.tsx` component for header card.
   * Build `PreCommitDiffViewer.tsx` component in `LiveMonitor`.
3. **Automated Tests**:
   * Unit tests for branch validation and stdout streaming in `tests/`.
