# Claude Code integration

Synapse connects to Claude Code in two ways:

- an **MCP server**, which gives the agent its tools
- **lifecycle hooks**, which add automatic context and capture

## Option A: `synapse setup claude` (recommended)

```bash
synapse setup claude [--global] [--dry-run]
```

| | Project (default) | `--global` |
|---|---|---|
| Hooks written to | `.claude/settings.local.json` | `~/.claude/settings.json` |
| MCP registered with | `claude mcp add synapse -s local` | `claude mcp add synapse -s user` |

How setup behaves:

- **Merges, doesn't overwrite.** Hooks are added next to your existing settings, and an existing file is backed up as `*.synapse-backup` first.
- **Safe to re-run.** Hooks already present are not added twice.
- **Pins absolute paths.** Commands use the absolute paths of the Node binary and `cli.js` that ran setup, which matters when your default `node` is older than 22.
- **Prints a fallback.** If the `claude` CLI isn't found, it prints the `claude mcp add` command to run yourself.

## Option B: plugin

The repo is also a Claude Code plugin marketplace:

```
/plugin marketplace add /path/to/synapse
/plugin install synapse@synapse
```

The plugin bundles the MCP server, the hooks and a `synapse-memory` skill that teaches the agent when to search, store and resolve. Its commands call `synapse` from your PATH, so `synapse` must be linked under Node 22.

## Other MCP clients

```json
{ "mcpServers": { "synapse": { "command": "synapse", "args": ["serve"] } } }
```

Set `SYNAPSE_PROJECT_ROOT` in the server's environment if the client doesn't start it in the project directory.

## What the hooks do

All five events run `synapse hook`, which reads Claude Code's hook JSON from stdin. Each Claude session id becomes a Synapse session.

| Event | Behaviour |
|---|---|
| `SessionStart` | Injects a one-line hint plus a project brief (≤700 tokens) as `additionalContext`. After a compaction (`source: compact`) the brief is aimed at continuing the current task |
| `UserPromptSubmit` | Records the session's **first** substantial prompt (≥20 characters, not a slash command) as its `session-request` goal. Later prompts are not stored |
| `PostToolUse` | Captures edits and significant commands (see below) |
| `PreCompact` | Writes an auto-summary onto the session |
| `SessionEnd` | Closes the session with an auto-summary: goal, files touched, explicitly stored memories |

### Auto-capture rules

- **Edits** (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) produce a `what-changed` memory. Repeated edits to the same file in the same session **update one rolling record** instead of piling up. The record keeps a short excerpt of the latest change, and its entity is inferred from the path (`src/api/limit.ts` → `api`).
- **Bash commands** are captured only when they matter:
  - a build, test, lint, install, deploy or migration command → `discovery`
  - any command whose output looks like a failure → `gotcha`
  - trivial commands (`ls`, `cd`, `cat`, `git status`, `git log`, …) are always ignored
- **Ignored entirely:** read-only tools (`Read`, `Grep`, `Glob`, `WebFetch`, `Task`, …) and Synapse's own tools.

Everything captured this way is a down-ranked **candidate**:

- `source: hook`, `admissionState: candidate`, `valueCategory: ephemeral`
- It is searchable, but scores ×0.6.
- It is never shown as a caution.
- It decays four times faster than an explicit memory of the same type.

Promote the useful ones with `synapse_qualify`.

### Safety

- **Never blocks Claude.** A hook always exits 0, whatever goes wrong. Set `SYNAPSE_DEBUG=1` to print errors to stderr.
- **Old Node is harmless.** On Node versions without `node:sqlite`, `synapse hook` exits quietly instead of failing.
- **Secrets are redacted** in everything captured.

## Controlling injection

| `SYNAPSE_HOOK_INJECT` | SessionStart behaviour |
|---|---|
| `full` (default) | Hint plus project brief |
| `minimal` | One-line hint only |
| `silent` | Nothing injected |

## Troubleshooting

| Symptom | Check |
|---|---|
| Tools missing in Claude Code | `claude mcp list`. Re-run `synapse setup claude` and restart Claude Code |
| `synapse requires Node.js >= 22.13` | Re-run setup under Node 22 so the absolute path is pinned, or `nvm alias default 22` |
| No brief at session start | `SYNAPSE_HOOK_INJECT` isn't `silent`; hooks are present in the settings file; `SYNAPSE_DEBUG=1` |
| Memories land in the wrong project | `synapse doctor` from that directory shows the detected project id. Check the git remote |
| Search says "fresh project" | Nothing has been stored for this project id yet. Try `synapse projects` |
