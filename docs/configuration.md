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
| `SYNAPSE_HOOK_INJECT` | `full` | `full`, `minimal` or `silent`; see [Agent integration](agent-integration.md#controlling-injection) |
| `SYNAPSE_DEBUG` | unset | When set, hook errors are printed to stderr |

`synapse serve --mode full` overrides `SYNAPSE_MODE`.

## Ignored files

A `.synapseignore` at the project root keeps files out of edit capture and file freshness. Secret-shaped files (`.env*`, `*.pem`, `*.key`, …) are ignored by default. See [ignored files](concepts.md#ignored-files).

## Storage

- **One file for everything.** All projects share a single SQLite database, opened in WAL mode with a 5-second busy timeout, so the MCP server, hooks and CLI can use it at the same time.
- **Back it up** by copying `synapse.db` while nothing is writing, or use `synapse export` per project.
- **Search index:** FTS5, kept in sync by triggers.
- **Local only:** nothing leaves your machine. There is no network access, telemetry or cloud sync.

## Per-project or isolated stores

Use a separate database for one project, or for experiments:

```bash
SYNAPSE_DB=./.synapse.db synapse serve
```

Set the same variable in the MCP server's environment and in the hook command if you want both to use it.
