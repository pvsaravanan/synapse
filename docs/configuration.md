# Configuration

Synapse is configured entirely through environment variables. There is no config file.

| Variable | Default | Description |
|---|---|---|
| `SYNAPSE_HOME` | `~/.synapse` | State directory |
| `SYNAPSE_DB` | `$SYNAPSE_HOME/synapse.db` | Database file. Use `:memory:` for throwaway runs |
| `SYNAPSE_MODE` | `lite` | `full` adds the knowledge-graph tools and `synapse_export` to the MCP server |
| `SYNAPSE_PROJECT_ROOT` | current directory | Directory the MCP server uses to detect its project |
| `SYNAPSE_HOOK_INJECT` | `full` | `full`, `minimal` or `silent`; see [Agent integration](agent-integration.md#controlling-injection) |
| `SYNAPSE_DEBUG` | unset | When set, hook errors are printed to stderr |

`synapse serve --mode full` overrides `SYNAPSE_MODE`.

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
