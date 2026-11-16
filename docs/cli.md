# CLI reference

```
synapse <command> [options]
```

Commands that work on memory use the project of the **current directory** (see [Projects](concepts.md#projects)).

## Server and integration

| Command | Description |
|---|---|
| `synapse serve [--mode lite\|full]` | Start the stdio MCP server |
| `synapse hook [--agent claude\|cursor\|codex]` | Handle one agent hook event read as JSON from stdin, and reply in that agent's format. Always exits 0 |
| `synapse setup <claude\|cursor\|codex> [--global] [--dry-run]` | Install hooks and register the MCP server with an agent ([details](agents.md)) |
| `synapse doctor` | Check Node, SQLite/FTS5, database path, project detection and git |
| `synapse version` | Print the version |

## Reading

| Command | Description |
|---|---|
| `synapse context [--task "…"]` | Print the project brief. The task can also be given as positional words |
| `synapse search <query…> [--global] [--limit N] [--type a,b] [--status S]` | Ranked index; `--status` is `active` (default), `resolved`, `archived` or `all` |
| `synapse detail <id…>` | Full records |
| `synapse timeline <id>` | Neighbours of one memory |
| `synapse stats` | Counts by status and type for this project |
| `synapse projects` | Every project with a memory count and last activity |

## Writing

| Command | Description |
|---|---|
| `synapse store --type T --title "…" [--entity E] [--narrative "…"] [--topic K] [--facts a,b] [--files a,b]` | Store a memory with `source: manual`. `--entity` defaults to `project` and `--type` to `discovery` |
| `synapse resolve <id…> [--status resolved\|archived\|active]` | Change status |
| `synapse ingest-git [--count N] [--since DATE]` | Import commits (default 20) |

## Sessions

| Command | Description |
|---|---|
| `synapse session` | List recent sessions |
| `synapse session start` | Start a session and print its id |
| `synapse session end [--summary "…"]` | Close the active session |

## Maintenance and portability

| Command | Description |
|---|---|
| `synapse retention [--archive]` | Show retention zones; archive expired memories |
| `synapse export [--out FILE]` | Write this project's observations and sessions as JSON (stdout by default) |
| `synapse import <file> [--project ID]` | Import a bundle into this project or another. Topic and duplicate rules apply, so re-importing is safe |

## Examples

```bash
# Brief for a task
synapse context --task "add rate limiting to the public API"

# Only fixes and gotchas about auth, across all projects
synapse search auth --type problem-solution,gotcha --global

# A decision that will evolve over time
synapse store --type decision --entity storage --topic decisions/storage/engine \
  --title "SQLite for local storage" --narrative "Zero-ops, single file, FTS5 built in."

# Move memory to a renamed repo
cd old-repo && synapse export --out /tmp/mem.json
cd ../new-repo && synapse import /tmp/mem.json
```
