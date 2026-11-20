# Synapse

Local-first memory for AI coding agents: an MCP server plus lifecycle hooks for Claude Code, Cursor, Codex, Devin CLI, GitHub Copilot CLI, Gemini CLI and Antigravity, backed by SQLite (`node:sqlite` with FTS5). User docs are in `docs/`; start with `docs/concepts.md`.

## Commands

Node 22.13 or later is required (`node:sqlite`). If `node -v` is older, run `source ~/.nvm/nvm.sh && nvm use 22` first.

```bash
npm run lint     # type-check (tsc --noEmit)
npm test         # vitest
npm run build    # compile to dist/; hooks and MCP servers installed by setup run dist/cli.js
```

Rebuild after changing `src/` when testing hooks or the MCP server live, because they run the compiled `dist/`.

## Layout

- `src/server.ts`: MCP tools (lite and full modes); without hooks it also runs the session, using `src/worktree.ts` to detect edits
- `src/hooks.ts`, `src/agents.ts`: hook handling and capture rules; each agent's payloads are normalized to one event model
- `src/file-notes.ts`: the memories about a file, shown to the agent when it reads or edits it
- `src/setup.ts`: `synapse setup <agent>` (hooks, MCP registration, CLAUDE.md / AGENTS.md instructions); `src/doctor.ts` checks, repairs and uninstalls it
- `src/store.ts`, `src/db.ts`: observations, upserts and duplicate merging, schema and migrations
- `src/context.ts`: the task-lensed project brief
- `src/search.ts`, `src/retention.ts`: FTS ranking and relevance decay
- `src/longterm.ts`, `src/sessions.ts`, `src/freshness.ts`: reviewed long-term memory, sessions and checkpoints, file freshness
- `src/ui.ts`, `src/ui-page.ts`: `synapse ui`, the local web page (server plus one self-contained HTML page)
- `src/team.ts`: team memory shared through the repo's `.synapse/memory.jsonl`
- `src/consolidate.ts`, `src/ignore.ts`: merging and archiving auto-captured records when a session ends; `.synapseignore`
- `tests/`: one file per area; tests use an in-memory database and temp directories

## Conventions

- **Tests and docs ship with the change.** A new behaviour gets tests, and the matching page in `docs/` (and the README when it's user-facing) is updated in the same change.
- **Schema changes are additive.** New tables use `CREATE TABLE IF NOT EXISTS`; new columns go through `migrate()` in `src/db.ts`, so existing databases keep working.
- **Hooks never block the agent.** A hook always exits 0; errors print only with `SYNAPSE_DEBUG=1`.
- **Redact before writing.** Everything stored passes through `redactSecrets`.
- **Live tests use a temp database** (`SYNAPSE_DB=...`), never the real `~/.synapse/synapse.db`.
- Keep `.claude/`, `.cursor/`, `.codex/`, `.devin/`, `.gemini/`, `.github/copilot/settings.local.json`, `.agents/hooks.json` and `.agents/mcp_config.json` out of git: setup writes machine-specific absolute paths there.

<!-- synapse:start -->
## Memory (Synapse)

This project uses Synapse for memory shared across sessions and agents. A brief is injected at session start; current code and the user's request always win over memory.

- **Before non-trivial work:** call `synapse_project_context` with the task, and read its "Start here" files.
- **Before re-investigating** a bug, error or past decision: `synapse_search` first, then `synapse_detail` on relevant ids.
- **Store as you go**, without being asked, with `synapse_store`: non-obvious bug causes and fixes (`problem-solution`), traps and environment quirks (`gotcha`), design choices (`decision`; use `synapse_store_reasoning` for the why and the rejected alternatives), and how a subsystem works (`how-it-works`). Name the files involved in `filesModified`. Use `topicKey` for topics that evolve.
- **Don't store** what the code or git history already says, routine edits, or secrets.
- **A memory flagged "changed since: …"** names files edited after it was stored: check current code, then `synapse_feedback` with `verified` or `outdated`. Use `synapse_resolve` for memories that no longer hold.
- **Lasting facts, procedures and user preferences:** propose with `synapse_lt_propose`. The user approves them; don't approve on their behalf.
- **When a session's work is done:** `synapse_session_end` with a handoff summary (done, left, where to resume).
<!-- synapse:end -->
