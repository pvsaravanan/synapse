# Synapse

Local-first, project-aware memory for AI coding agents, served over MCP.

Synapse stores what agents learn about a project: decisions, gotchas, fixes, reasoning, session handoffs and git history. Everything goes into one SQLite file on your machine. Any later session or agent can pick it up through cheap, token-budgeted retrieval.

Full documentation: [docs/](docs/README.md) — [getting started](docs/getting-started.md), [concepts](docs/concepts.md), [MCP tools](docs/mcp-tools.md), [CLI](docs/cli.md), [agent integration](docs/agent-integration.md), [configuration](docs/configuration.md), [architecture](docs/architecture.md).

## Features

- **Typed observations:** `gotcha`, `decision`, `problem-solution`, `how-it-works`, `what-changed`, `discovery`, `why-it-exists`, `trade-off`, `reasoning`, `session-request`
- **Topic-key upserts** revise an evolving topic in place, and **near-duplicate merging** keeps the store tidy.
- **Search:** SQLite FTS5 BM25, blended with relevance decay `importance × e^(-age/retention) × accessBoost × feedback`
- **Progressive disclosure:** a compact index (`synapse_search`) → timeline (`synapse_timeline`) → full detail (`synapse_detail`)
- **Task-lensed project brief** (`synapse_project_context`): start-here files, relevant memories, cautions, the last handoff and verification steps, kept under a token budget
- **Git memory:** commits become typed, source-backed memories, with merge, version-bump and lockfile noise filtered out.
- **Automatic hooks for Claude Code, Cursor, Codex, Devin CLI, GitHub Copilot CLI and Gemini CLI:**
  - inject a brief at session start
  - capture edits and significant or failing commands as down-ranked *candidates*
  - keep a checkpoint at every context compaction, and lead the brief with it when the session resumes
  - auto-summarize the session at end
- **File freshness:** a memory whose files changed since it was stored is flagged `changed since: …` in search and briefs, until it's verified or resolved.
- **Reviewed long-term memory:** facts, procedures and events approved with a recorded reason. Only approved items reach the brief, and `user`-scope items carry across projects.
- **Secret redaction** before every write
- **No native dependencies:** uses Node's built-in `node:sqlite`

## Requirements

- **Node.js 22.13 or later.** Check with `node -v`. With nvm: `nvm install 22 && nvm use 22`.
- **git**

## Install

Synapse is installed from source:

```bash
git clone https://github.com/pvsaravanan/synapse.git
cd synapse
npm install
npm run build
npm link          # adds the `synapse` command
synapse doctor    # check the install
```

`synapse doctor` should report `ok` for Node, `node:sqlite + FTS5`, project detection and git.

**nvm users:** `npm link` puts `synapse` inside the Node version it was run with. If your default Node is older than 22, new terminals won't find the command. Either run `nvm alias default 22`, or run `nvm use 22` before using `synapse`. Claude Code isn't affected: `synapse setup claude` writes absolute Node 22 paths into its config.

### Update

```bash
cd synapse && git pull && npm install && npm run build
```

Memories live in `~/.synapse/synapse.db`, so updating never touches them.

### Uninstall

```bash
npm unlink -g synapse-memory
claude mcp remove synapse -s local     # or -s user if you used --global
rm -rf ~/.synapse                      # only if you also want to delete all memories
```

Also remove the `synapse ... hook` entries from `.claude/settings.local.json` or `~/.claude/settings.json`.

## Connect your agent

One command registers the MCP server, installs lifecycle hooks, and adds memory instructions to the project's `CLAUDE.md` or `AGENTS.md`:

```bash
cd your-project
synapse setup claude      # Claude Code
synapse setup cursor      # Cursor
synapse setup codex       # Codex
synapse setup devin       # Devin CLI
synapse setup copilot     # GitHub Copilot CLI
synapse setup gemini      # Gemini CLI
```

Hooks handle the automatic part: the brief at session start, capturing edits and commands, checkpoints. Saving what was *learned* (decisions, gotchas, fixes) is up to the agent, and agents rarely do it unprompted, so setup also adds a short instruction block telling them when to. Skip it with `--no-instructions`; `synapse instructions` prints it.

Add `--global` to configure every project, or `--dry-run` to preview the changes. Setup merges into existing config (with backups) and pins absolute Node 22 paths, so it works even when your default `node` is older.

Other MCP clients (Windsurf, Zed, VS Code Copilot, …) work too: without hooks, Synapse's MCP server delivers the brief itself, runs one session per connection, detects edited files from the git working tree, and keeps a rolling checkpoint the agent can recover from after compaction. Run `synapse setup git` in a project to record every commit as a memory, from any agent.

Then restart the agent. **Codex only:** approve the synapse hooks once in `/hooks`, then start a new thread.

All agents share one memory store, so what one agent learns, the others see. For what each agent's hooks capture, the Claude Code plugin alternative, and other MCP clients, see [agent integration](docs/agent-integration.md).

## MCP tools

Lite mode (default):

| Tool | Use |
|---|---|
| `synapse_project_context` | First step for non-trivial work: a task-lensed brief |
| `synapse_search` | Compact index of matching memories (`scope: "global"` for all projects) |
| `synapse_detail` / `synapse_timeline` | Expand a memory / see what happened around it |
| `synapse_store` / `synapse_store_reasoning` | Save a memory / the *why* behind a decision |
| `synapse_resolve` | Mark memories done or obsolete |
| `synapse_feedback` | helpful / verified / conflicted / outdated / corrected → adjusts ranking; `verified` clears a `changed since` flag |
| `synapse_qualify` | Promote hook-captured candidates |
| `synapse_lt_propose` / `synapse_lt_approve` / `synapse_lt_archive` / `synapse_lt_list` | Reviewed long-term memory. Approving always asks you, even in auto or bypass mode (Claude Code). |
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
synapse stale && synapse verify 14
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
