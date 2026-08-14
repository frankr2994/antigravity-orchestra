# Antigravity Orchestra Command Center

A Windows-first local dashboard that runs Antigravity, Codex, and a Gemma model against a selected project directory.

## Requirements

- Node.js 24 or newer
- Git
- Antigravity CLI (`agy`) authenticated and on `PATH`
- Codex CLI authenticated and on `PATH`
- LM Studio serving `gemma-4-e2b-it-qat` at `http://127.0.0.1:1234`

## Start

From the repository root:

```powershell
.\Start-Orchestra.ps1
```

Or from this directory:

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The development launcher starts both Vite and the API server. Production builds use `npm run build` followed by `npm start`, serving the frontend and API at `http://127.0.0.1:3001`.

## Workflow

1. Browse to a project directory. Orchestra pins the conversation and every agent process to that canonical path.
2. Missing or conflicting agent configuration is backed up under `.orchestra/backups/` and replaced from the Orchestra template.
3. Gemma classifies requests. Antigravity executes them; Codex automatically joins design, debugging, test-design, and review work.
4. Existing Git changes are reviewed and committed separately before a mutating task starts.
5. Successful changes are reviewed, verified, summarized into `docs/HANDOFF.md`, committed with explicit file paths, and pushed to the current upstream.
6. Push failures retain the local commit and appear in Task History with a retry action.

## Commands

```powershell
npm run build       # Compile backend/frontend
npm run lint        # Static lint
npm test            # Backend unit tests
npm run check       # Full verification
```

Dashboard state is stored in `%LOCALAPPDATA%\AntigravityOrchestra\orchestra.db`. Forgetting a project from the UI removes only that registry entry; it never deletes project files.

## Safety boundaries

- The service binds only to `127.0.0.1` and mutation requests require a per-launch token.
- Processes use argument arrays with shell execution disabled.
- Codex remains read-only.
- The dashboard never force-pushes, creates an upstream, initializes Git, deletes ignored files, or runs `git add .`.
- Automatic execution keeps the normal Antigravity CLI sandbox and permission system enabled.
