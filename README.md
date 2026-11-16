# Synapse

Local-first, project-aware memory for AI coding agents, served over MCP.

Synapse stores what agents learn about a project: decisions, gotchas, fixes, reasoning, session handoffs and git history. Everything goes into one SQLite file on your machine. Any later session or agent can pick it up through cheap, token-budgeted retrieval.

Full documentation: [docs/](docs/README.md) — [getting started](docs/getting-started.md), [concepts](docs/concepts.md), [MCP tools](docs/mcp-tools.md), [CLI](docs/cli.md), [Claude Code](docs/claude-code.md), [configuration](docs/configuration.md), [architecture](docs/architecture.md).

## Features

- **Typed observations:** `gotcha`, `decision`, `problem-solution`, `how-it-works`, `what-changed`, `discovery`, `why-it-exists`, `trade-off`, `reasoning`, `session-request`
- **Topic-key upserts** revise an evolving topic in place, and **near-duplicate merging** keeps the store tidy.
- **Search:** SQLite FTS5 BM25, blended with relevance decay `importance × e^(-age/retention) × accessBoost × feedback`
- **Progressive disclosure:** a compact index (`synapse_search`) → timeline (`synapse_timeline`) → full detail (`synapse_detail`)
- **Task-lensed project brief** (`synapse_project_context`): start-here files, relevant memories, cautions, the last handoff and verification steps, kept under a token budget
- **Git memory:** commits become typed, source-backed memories, with merge, version-bump and lockfile noise filtered out.
- **Claude Code hooks:**
  - inject a brief at session start
  - capture edits and significant or failing commands as down-ranked *candidates*
  - auto-summarize the session at end
- **Secret redaction** before every write
- **No native dependencies:** uses Node's built-in `node:sqlite`

## Requirements

Node.js **≥ 22.13**. On machines that use nvm with an older default, run the commands below with Node 22 active (`nvm use 22`).

## Install

```bash
npm install && npm run build
npm link                         # puts `synapse` on PATH (with Node 22 active)
synapse doctor
```

## Connect to Claude Code

**Option A: setup command (recommended).** It writes absolute Node 22 paths, so it works even when your default `node` is older.

```bash
cd your-project
synapse setup claude             # project-local: .claude/settings.local.json + `claude mcp add -s local`
synapse setup claude --global    # all projects: ~/.claude/settings.json + `claude mcp add -s user`
synapse setup claude --dry-run   # show what would change
```

**Option B: plugin.** This needs `synapse` on PATH, running under Node 22.

```
/plugin marketplace add /path/to/synapse
/plugin install synapse@synapse
```

**Any other MCP client:**

```json
{ "mcpServers": { "synapse": { "command": "synapse", "args": ["serve"] } } }
```

## MCP tools

Lite mode (default):

| Tool | Use |
|---|---|
| `synapse_project_context` | First step for non-trivial work: a task-lensed brief |
| `synapse_search` | Compact index of matching memories (`scope: "global"` for all projects) |
| `synapse_detail` / `synapse_timeline` | Expand a memory / see what happened around it |
| `synapse_store` / `synapse_store_reasoning` | Save a memory / the *why* behind a decision |
| `synapse_resolve` | Mark memories done or obsolete |
| `synapse_feedback` | helpful / conflicted / outdated / corrected → adjusts ranking |
| `synapse_qualify` | Promote hook-captured candidates |
| `synapse_session_start` / `synapse_session_end` | Session lifecycle and handoff summaries |
| `synapse_suggest_topic_key` | A stable key for evolving topics |
| `synapse_retention` | Memory health and archiving |
| `synapse_ingest_git` | Import recent commits |

Full mode (`SYNAPSE_MODE=full` or `synapse serve --mode full`) adds the MCP memory-server graph tools (`create_entities`, `create_relations`, `add_observations`, `delete_*`, `read_graph`, `search_nodes`, `open_nodes`) and `synapse_export`.

## CLI

```bash
synapse context --task "fix the login redirect loop"
synapse search "webhook signature" [--global]
synapse store --type gotcha --entity billing --title "Stripe webhooks need raw body" --narrative "..."
synapse ingest-git --count 50
synapse detail 12 14
synapse session end --summary "Done X; next Y"
synapse retention --archive
synapse export --out mem.json && synapse import mem.json
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SYNAPSE_HOME` | `~/.synapse` | State directory |
| `SYNAPSE_DB` | `$SYNAPSE_HOME/synapse.db` | Database file |
| `SYNAPSE_MODE` | `lite` | `full` enables graph and export tools |
| `SYNAPSE_HOOK_INJECT` | `full` | `minimal` (one-line hint) or `silent` |
| `SYNAPSE_PROJECT_ROOT` | cwd | Project root the MCP server binds to |
| `SYNAPSE_DEBUG` | – | Print hook errors to stderr |

**Project identity** is the normalized git remote (`owner/repo`). The same project keeps its memory across clones and protocols. Repos without a remote use `local/<name>`. Folders outside git use `dir/<name>-<hash>`.

## Development

```bash
npm run build
npm test        # vitest, 24 tests
```

## License

MIT. See `LICENSE`.
