# Configuration

Synapse is configured entirely through environment variables. There is no config file.

| Variable | Default | Description |
|---|---|---|
| `SYNAPSE_HOME` | `~/.synapse` | State directory |
| `SYNAPSE_DB` | `$SYNAPSE_HOME/synapse.db` | Database file. Use `:memory:` for throwaway runs |
| `SYNAPSE_MODE` | `lite` | `full` adds the knowledge-graph tools and `synapse_export` to the MCP server |
| `SYNAPSE_PROJECT_ROOT` | current directory | Directory the MCP server uses to detect its project |
| `SYNAPSE_NUDGE` | on | `0` turns off the once-per-session reminder to store what was learned ([details](agent-integration.md#store-reminder)) |
| `SYNAPSE_HOOKS` | unset | `1` tells the MCP server that hooks are installed for its agent, so the hooks deliver the brief and run the session. Setup sets it. Unset, the server does both itself; see [agents without hooks](agent-integration.md#agents-without-hooks) |
| `SYNAPSE_HOOK_INJECT` | `full` | `full`, `minimal` or `silent`; see [Agent integration](agent-integration.md#controlling-injection). `silent` also turns off file notes |
| `SYNAPSE_FILE_NOTES` | on | `0` stops hooks from showing the memories about a file when the agent reads or edits it ([file notes](agent-integration.md#file-notes)) |
| `SYNAPSE_EMBED` | as set by `synapse embed` | `1` or `0` forces [meaning-based search](concepts.md#meaning-based-search-optional) on or off |
| `SYNAPSE_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Sentence-embedding model (a transformers.js feature-extraction model); run `synapse embed` after changing it |
| `SYNAPSE_TEAM` | on | `0` stops setup, session start and the MCP server from loading the repo's `.synapse/memory.jsonl` automatically ([team memory](concepts.md#team-memory)) |
| `SYNAPSE_CANDIDATE_DAYS` | `14` | Auto-captured candidates nobody kept, read or rated are archived after this many days; `0` turns it off ([consolidation](concepts.md#consolidation)) |
| `SYNAPSE_DEFAULT_BRANCH` | `git config synapse.defaultBranch`, else a remote's HEAD, else `main` / `master` / `trunk` | The default branch: memories stored on any other branch are [scoped to it](concepts.md#branch-scoped-memories) until it merges. For one repository, `git config synapse.defaultBranch <name>` |
| `SYNAPSE_AUDIT_DAYS` | `90` | Days to keep the record of [what each session was shown](concepts.md#what-each-session-was-shown); `0` stops recording |
| `SYNAPSE_AGENT_APPROVAL` | unset | `1` lets agents other than Claude Code call `synapse_lt_approve`, relying on their own permission prompt. Unset, they are refused and you approve with `synapse lt approve` or `synapse ui` ([who approves](concepts.md#reviewed-long-term-memory)) |
| `SYNAPSE_DEBUG` | unset | When set, hook errors are printed to stderr |

`synapse serve --mode full` overrides `SYNAPSE_MODE`.

## Ignored files

A `.synapseignore` at the project root keeps files out of edit capture and file freshness. Secret-shaped files (`.env*`, `*.pem`, `*.key`, …) are ignored by default. See [ignored files](concepts.md#ignored-files).

## Storage

- **One file for everything.** All projects share a single SQLite database, opened in WAL mode with a 5-second busy timeout, so the MCP server, hooks and CLI can use it at the same time.
- **Back it up** by copying `synapse.db` while nothing is writing, or use `synapse export` per project.
- **Owner-only.** The database holds captured commands, paths and session notes, so its files (`synapse.db`, `-wal`, `-shm`) are set to `0600`, and its folder to `0700` when Synapse creates it or it is `SYNAPSE_HOME`. A folder you chose that already existed keeps its mode. `synapse export --out` writes `0600` files too.
- **Search index:** FTS5, kept in sync by triggers.
- **Local only:** nothing leaves your machine. There is no telemetry or cloud sync, and no network access, except the one-time model download when you run `synapse embed` to turn on [meaning-based search](concepts.md#meaning-based-search-optional).

## Per-project or isolated stores

Use a separate database for one project, or for experiments:

```bash
SYNAPSE_DB=./.synapse.db synapse serve
```

Set the same variable in the MCP server's environment and in the hook command if you want both to use it.
