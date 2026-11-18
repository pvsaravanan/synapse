# CLI reference

```
synapse <command> [options]
```

Commands that work on memory use the project of the **current directory** (see [Projects](concepts.md#projects)).

## Server and integration

| Command | Description |
|---|---|
| `synapse serve [--mode lite\|full]` | Start the stdio MCP server |
| `synapse hook [--agent claude\|cursor\|codex\|devin\|copilot\|gemini\|antigravity] [--event E]` | Handle one agent hook event read as JSON from stdin, and reply in that agent's format. `--event` supplies the event name for payloads that lack it (Copilot CLI, Antigravity). Always exits 0 |
| `synapse setup <claude\|cursor\|codex\|devin> [--global] [--dry-run] [--allow-tools] [--no-instructions]` | Install hooks, register the MCP server, and add memory instructions to the project's `CLAUDE.md` / `AGENTS.md` ([details](agent-integration.md)). `--no-instructions` skips the instructions. `--allow-tools` (Devin only) pre-approves Synapse's own tools, except `synapse_lt_approve`, in your user-level Devin permissions |
| `synapse setup git [--dry-run]` | Install a git `post-commit` hook that records each commit as a memory, from any agent or person ([details](agent-integration.md#git-hook-commits-from-any-agent)) |
| `synapse instructions` | Print the memory-instructions block setup adds to `CLAUDE.md` / `AGENTS.md`, to paste into a global file or another agent's rules |
| `synapse doctor` | Check Node, SQLite/FTS5, database path, project detection and git |
| `synapse doctor agents [--agent A] [--global] [--fix]` | Check what setup installed for each agent: hooks (all events present, paths valid), MCP entry (paths, `SYNAPSE_HOOKS` matching whether hooks exist), instructions block, git hook. Exits 1 on problems; `--fix` re-runs setup for the agents with problems ([details](agent-integration.md#checking-and-repairing-setup)) |
| `synapse uninstall [--agent A] [--global] [--dry-run]` | Remove what setup installed, keeping your own config and all memories ([details](agent-integration.md#uninstalling)) |
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
| `synapse stale [--limit N]` | List active memories whose files changed since they were stored ([file freshness](concepts.md#file-freshness)) |
| `synapse verify <id…>` | Mark memories as checked against current code; re-records their file hashes and clears the flag |
| `synapse ingest-git [--count N] [--since DATE]` | Import commits (default 20) |

## Sessions

| Command | Description |
|---|---|
| `synapse session` | List recent sessions |
| `synapse session start` | Start a session and print its id |
| `synapse session end [--summary "…"]` | Close the active session |
| `synapse checkpoint [--session ID] [--limit N]` | List compaction checkpoints, newest first |
| `synapse checkpoint show <id>` | Show one checkpoint in full (Synapse's and the agent's summaries) |

## Long-term memory

| Command | Description |
|---|---|
| `synapse lt list [--state S] [--query Q]` | List long-term items visible here (all states by default) |
| `synapse lt show <id>` | Show one item with its state, review reason and evidence |
| `synapse lt add --kind K --title "…" --text "…" [--scope user] [--applies "…"] [--evidence a,b]` | Propose an item |
| `synapse lt promote <memory-id> --kind K [--scope user]` | Propose an existing memory; it becomes the evidence |
| `synapse lt approve <id> --reason "…"` | Approve; only approved items reach the brief |
| `synapse lt archive <id> --reason "…"` | Archive (reject a proposal, or retire an approved item) |
| `synapse lt supersede <old> <new> --reason "…"` | Replace an approved item with a newer one |

`add` and `promote` take `--approve --reason "…"` to propose and approve in one step. Kinds: `semantic`, `procedural`, `episodic`.

## Maintenance and portability

| Command | Description |
|---|---|
| `synapse retention [--archive]` | Show retention zones; archive expired memories |
| `synapse ui [--port N] [--open]` | Browse and curate memory in a local web page ([details](#synapse-ui)) |
| `synapse consolidate [--dry-run]` | Merge ended sessions' auto-captured edit records per area, and archive older duplicate command records ([consolidation](concepts.md#consolidation)). Runs automatically when a session ends |
| `synapse export [--out FILE]` | Write this project's observations, sessions, checkpoints and long-term items as JSON (stdout by default) |
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

## synapse ui

```bash
synapse ui [--port N] [--open]
```

Starts a local web page for the project in the current directory (any project can be picked from the header):

- **Memories:** search and filter by type, status and source; open a memory to see its narrative, facts, files, history (what it replaced or was replaced by) and feedback.
- **Changed since:** memories whose files changed after they were stored, with **Still true** (verified) and **Outdated** buttons. Only the project `synapse ui` was started in can be checked, since only its folder is known.
- **Candidates:** auto-captured records, with **Keep** to qualify the useful ones.
- **Sessions:** each session's agent, summary, checkpoints and records.
- **Long-term:** proposals to approve or reject, and approved items to retire, each with a required reason (recorded as "via synapse ui").

Every memory can be resolved, archived or reopened. The server listens on `127.0.0.1` only, answers only requests addressed to a local host name, and needs the access token in the printed URL for every API call, so other websites can't read or change your memory. The token changes each run. Stop it with Ctrl+C.

