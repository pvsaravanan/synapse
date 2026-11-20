# Architecture

```
  Claude Code · Cursor · Codex · Devin · Copilot · Gemini · Antigravity / MCP client     shell
                  │            │                           │
        stdio MCP │            │ hook JSON (stdin)         │
                  ▼            ▼                           ▼
            server.ts       hooks.ts                    cli.ts
                  └──────┬─────┴───────────────────────────┘
                         ▼
   context.ts   search.ts   disclosure.ts   sessions.ts   git.ts   graph.ts   maintenance.ts
                         │
                 store.ts  ──  secrets.ts, retention.ts
                         │
                       db.ts  (node:sqlite, FTS5)
                         │
                 ~/.synapse/synapse.db
```

## Modules

| File | Responsibility |
|---|---|
| `src/types.ts` | Observation, session, search and project types; the observation type list and labels |
| `src/config.ts` | Paths, tool mode, hook injection mode, version |
| `src/project.ts` | Project detection and git-remote normalization |
| `src/db.ts` | Opening the database, schema, FTS5 triggers, the shared handle, meta key/value |
| `src/secrets.ts` | Credential redaction rules |
| `src/store.ts` | Observation CRUD, topic upsert, duplicate merge, status, access and feedback, timeline, stats |
| `src/retention.ts` | Importance, decay, immunity, retention zones |
| `src/search.ts` | FTS query building, BM25 + relevance ranking, LIKE fallback |
| `src/disclosure.ts` | Formatting for the L1 index, L2 timeline and L3 detail |
| `src/context.ts` | Task lenses and the project brief |
| `src/sessions.ts` | Session lifecycle |
| `src/git.ts` | Commit parsing, type inference, noise filter, ingest |
| `src/graph.ts` | Entity/relation graph |
| `src/maintenance.ts` | Retention report and archiving, export/import |
| `src/agents.ts` | Per-agent hook adapters: detect the agent (incl. Devin via `DEVIN_PROJECT_DIR`), normalize Cursor, Codex and Devin payloads (including `apply_patch` parsing) and format each agent's response |
| `src/hooks.ts` | Agent-neutral hook handling: brief injection, capture rules, failure detection, session summaries |
| `src/usage.ts` | Usage report: read-often, not-read-in-N-days, too-new and rated-wrong memories, for `synapse usage` and the UI |
| `src/diff.ts` | The git diff of a flagged memory's files since it was stored (baseline found by content hash), for `synapse ui` |
| `src/file-notes.ts` | File notes: the reviewed memories about a file the agent reads or edits, once per file per session |
| `src/setup.ts` | `synapse setup <agent>`: merge hooks and MCP config for Claude Code, Cursor, Codex, Devin CLI, Copilot CLI, Gemini CLI and Antigravity, and prevent duplicate hooks where Devin imports Claude's |
| `src/server.ts` | MCP tool registration (lite and full); without hooks, the brief, the session and rolling checkpoints |
| `src/worktree.ts` | Without hooks: detects edited files by comparing the git working tree between tool calls |
| `src/consolidate.ts` | Merges a session's auto-captured edit records per area and command runs into one, archives older duplicate command records and stale candidates, and re-filters old command records |
| `src/ignore.ts` | `.synapseignore` patterns and the secret-file defaults |
| `src/ui.ts`, `src/ui-page.ts`, `src/ui-graph.ts` | `synapse ui`: a local node:http server (127.0.0.1, per-run token), the single page it serves, and the memory graph its Graph view draws |
| `src/doctor.ts` | `synapse doctor agents` (check and repair each agent's setup) and `synapse uninstall` |
| `src/cli.ts` | Command-line entry point |
| `src/index.ts` | Public library exports |

## Database schema

| Table | Contents |
|---|---|
| `observations` | One row per memory. List fields are stored as JSON text |
| `observations_fts` | FTS5 external-content index over entity, title, narrative, facts, files and concepts |
| `observation_access` | Per-memory access count and last access time |
| `feedback` | Feedback signals with optional notes |
| `sessions` | Session id, project, start/end times, status, summary, agent |
| `graph_entities`, `graph_relations` | Knowledge graph, keyed by project |
| `meta` | Key/value store for internal state |

Indexes cover `(projectId, status)`, `(projectId, topicKey)`, `(projectId, commitHash)` and `(projectId, startedAt)` on sessions.

## Design decisions

- **`node:sqlite` instead of a native driver.** There is no compile step and no prebuilt binaries to break across Node versions or architectures. The cost is a Node ≥ 22.13 requirement. The experimental-feature warning is filtered so it can't pollute MCP stdio or hook output.
- **Lexical search first.** BM25 with prefix matching and synonyms is fast, predictable and runs fully offline. Embeddings can be added behind `search()` without changing callers.
- **Cheap duplicate detection.** Token Jaccard on title plus narrative, limited to the same entity and type, catches the common "stored the same thing twice" case with no model calls.
- **Candidates instead of silence.** Hooks capture freely but mark everything as candidate and ephemeral. Explicit knowledge always wins, and noise fades quickly on its own.
- **Rolling capture records.** One record per file per session (via an internal topic key) instead of one per edit keeps auto-capture from dominating the store.
- **Hooks never fail.** Every hook path is wrapped and exits 0, because a broken memory layer must never block the agent.
- **Bounded output everywhere.** Search limits, token budgets on the index and brief, and capped excerpts keep the agent's context small.

## Development

```bash
npm install
npm run build       # tsc → dist/
npm run lint        # type-check only
npm test            # vitest
```

- **Test files:**
  - `tests/core.test.ts`: project detection, redaction, store, search, retention, brief, sessions, git (with a real temporary repo), hooks, export/import
  - `tests/mcp.test.ts`: the MCP server end to end through an in-memory client
  - `tests/copilot-gemini.test.ts`: Copilot CLI, Gemini CLI and Antigravity adapters and setup
  - `tests/agents.test.ts`: Cursor, Codex and Devin adapters, failure detection, `setup` for all four agents, the CLI hook entry point
- **Test runner:** tests use the vitest `threads` pool (set in `vitest.config.ts`); the default forks pool can hang on macOS when several files load `node:sqlite`.
- **Test databases:** use `openDatabase(':memory:')` for isolated stores. `createServer({ db, project, mode })` accepts injected dependencies.

### Adding an MCP tool

1. Put the logic in the relevant module, or a new one, taking `db` as its first argument.
2. Register the tool in `createServer` in `src/server.ts` (or `registerFullTools` for full mode), with a zod input schema and a clear description of *when* to use it.
3. Add a case to `tests/mcp.test.ts`.
4. Document it in `docs/mcp-tools.md`.

### Supporting another agent

`hooks.ts` works on one internal, Claude-shaped event (`HookInput`: `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `source`). To add an agent:

1. Add it to `AGENTS` in `src/agents.ts`. Write a normalizer that maps its events and fields onto `HookInput` (one payload may become several events, as Codex's `apply_patch` does), and teach `formatHookResult` its context-injection format.
2. Add a `setupX` function in `src/setup.ts` that merges its hooks and MCP config.
3. Add adapter and setup tests to `tests/agents.test.ts`, and document the agent in `docs/agent-integration.md`.
