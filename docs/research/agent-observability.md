# Agent observability research

Research date: 2026-08-13

## Summary

Orchestra can collect useful live telemetry from both remote agents without intercepting TLS. Antigravity exposes complementary supported and local sources, while Codex exposes structured run events plus a supported app-server account API.

## Research goal

Identify trustworthy sources for live progress, context-window consumption, token activity, and quota state so local Gemma can explain a run and Orchestra can make conservative routing decisions.

## Findings

### Antigravity CLI status-line payload

Antigravity CLI 1.1.12 supports a custom status-line command. The CLI sends JSON on the command's standard input whenever agent state changes. Documented fields include the conversation and transcript identifiers, active model, workspace, context-window token totals and percentages, model quota buckets, agent state, plan tier, pending input, active background tasks, and execution mode.

This is a source for live Antigravity context and cached quota state in interactive TUI sessions. A local probe confirmed that the hook is not invoked by the non-interactive `--output-format stream-json` print mode that Orchestra currently uses. Personally identifying fields such as `email` must be discarded before Orchestra persists a snapshot. Orchestra may consume a recent matching snapshot for exact context, but must mark context unavailable when no fresh snapshot exists.

### Antigravity usage command

The installed CLI supports `agy --output-format json --print "/usage"` (with `/quota` as an alias). Its structured result contains quota groups and buckets with exact `remaining_fraction` and `reset_time` fields. A local probe from Orchestra returned Gemini weekly and five-hour buckets plus third-party weekly and five-hour buckets. This is the authoritative print-mode quota source and can be cached without estimating quota from token totals. `/credits` is separate and reports premium credit balance rather than the standard model quota windows.

### Antigravity non-interactive stream JSON

The installed CLI's `stream-json` output provides structured initialization, step updates, result status, conversation ID, response text, and exact `usage` objects. A local read-only probe returned input, output, thinking, cache-read, and total token counts both on completed steps and on the terminal result. This is the authoritative per-run token source for Orchestra's current execution transport. It does not include model quota buckets or the configured context-window size.

### Antigravity transcript JSONL

The installed CLI writes `transcript.jsonl` and `transcript_full.jsonl` under `C:\Users\Rob\.gemini\antigravity-cli\brain\<conversation-id>\.system_generated\logs\`. A representative local transcript contained timestamped `USER_INPUT`, `PLANNER_RESPONSE`, `EPHEMERAL_MESSAGE`, `VIEW_FILE`, `RUN_COMMAND`, `CODE_ACTION`, and checkpoint events, with status, step index, and structured tool-call metadata.

The inspected transcript did not contain token, context, or quota fields. It is therefore a progress/evidence source, not a quota source. Orchestra should expose safe summaries (tool name, target path, command description, status, timestamp) and avoid persisting raw prompts, code replacement bodies, shell arguments, or internal thinking.

### Antigravity SDK

The `google-antigravity` Python package is real and supports streamed response text, thought streams, tool-call streams, conversation history, and SDK-managed token usage. It creates SDK agent sessions, however; it does not automatically add observability to the existing `agy` sessions Orchestra launches. Replacing the CLI transport with the SDK would also change deployment and authentication assumptions, so it is not required for the first observability implementation.

### Codex app server

The supported `codex app-server` JSON-RPC interface exposes `account/rateLimits/read` for ChatGPT quota windows and `account/usage/read` for token-activity summaries. It emits `thread/tokenUsage/updated` with an exact model context window and token breakdown, plus model-reroute, item lifecycle, and turn-completion notifications. Orchestra now uses one managed app-server child for both execution and account telemetry. Each role or review cycle gets a fresh ephemeral read-only thread, so context is observable without accumulating across repair cycles.

## Evaluation

| Source | Trust | Live progress | Context/tokens | Quota | Main limitation |
|---|---|---:|---:|---:|---|
| Antigravity `stream-json` | Supported CLI interface | Yes | Per-run tokens | No | No quota or context-window size |
| Antigravity `/usage` | Supported CLI command | Snapshot | No | Yes | Requires a short CLI process; cached by Orchestra |
| Antigravity status line | CLI implementation hook | Interactive sessions | Yes | Cached quota | Not invoked in print mode; custom command must be configured |
| Antigravity transcript | Local implementation artifact | Yes | No | No | Schema may evolve; content needs redaction |
| Antigravity SDK | Supported SDK | Yes | Yes | Provider-dependent | Runs SDK sessions rather than observing existing CLI sessions |
| Codex app server | Supported integration API | Yes | Yes | Yes | Requires a managed child process and caching |
| HTTPS interception | Unsupported observation technique | Potentially | Potentially | Potentially | Fragile, invasive, certificate and secret exposure risk |

## Conclusion

Use Antigravity `stream-json` for per-turn tokens, `/usage` for quota, and a matching status-line snapshot opportunistically for exact interactive context. Use Codex app-server for both agent turns and account telemetry. Tail Antigravity transcripts only as a bounded fallback/detail source. Keep deterministic metrics authoritative and let Gemma explain a sanitized evidence packet. Do not hardcode context caps or use a TLS proxy.

## References

- https://antigravity.google/docs/cli/statusline
- https://antigravity.google/docs/cli/commands/usage
- https://antigravity.google/docs/sdk/overview
- https://github.com/google-antigravity/antigravity-sdk-python
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/app-server
