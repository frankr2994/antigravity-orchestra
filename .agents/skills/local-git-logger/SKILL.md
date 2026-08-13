---
name: local-git-logger
description: Use this skill to incrementally log changes to HANDOFF.md and commit them to git using a local LM Studio model.
---

# Local Git Logger

This skill allows Antigravity to delegate git diff summarization and committing to a small local model running via LM Studio.
It is specifically designed for maintaining an incremental handoff log and committing changes quickly.

## When to use this skill
- When the user asks to "log changes", "commit changes", or update the handoff file.
- After completing a set of changes if the user requested incremental backups.

## Instructions

1. Ensure the user has the local LM Studio inference server running on `localhost:1234`.
2. Run the PowerShell script that manages the diff, LM Studio call, and git commit.

```powershell
.\.agents\skills\local-git-logger\scripts\log_and_commit.ps1
```

3. Read the output of the script to verify success or failure.
4. If it fails due to the server not running, instruct the user to start LM Studio's Local Server.
