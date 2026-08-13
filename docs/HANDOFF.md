
## [2026-08-12 22:09:17] Handoff Update
feat: Implement local Git logger skill for incremental change logging and committing

* Added `SKILL.md` file defining the "local-git-logger" skill for summarizing git diffs using a local LM Studio model.
* Created `scripts/log_and_commit.ps1` to handle the logic:
    * Retrieves unstaged or staged git diffs.
    * Constructs a prompt for an LLM (via LM Studio API) to generate a concise summary of the changes.
    * Appends the generated summary to `docs/HANDOFF.md`.
    * Stages and commits the changes to Git using a title derived from the summary.

