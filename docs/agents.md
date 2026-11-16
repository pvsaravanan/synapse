# Agent integration

Synapse connects to coding agents in two ways:

- an **MCP server**, which gives the agent its `synapse_*` tools
- **lifecycle hooks**, which add automatic context and capture without the agent having to decide to use memory

`synapse setup` installs both for **Claude Code**, **Cursor** and **Codex**:

```bash
synapse setup claude   [--global] [--dry-run]
synapse setup cursor   [--global] [--dry-run]
synapse setup codex    [--global] [--dry-run]
```

Without `--global`, setup configures the project in the current directory. With `--global`, it configures every project for that agent. `--dry-run` prints what would change and writes nothing.

All three agents share one memory store (`~/.synapse/synapse.db`), so a decision stored from Cursor shows up in Claude Code's next brief.

## What setup writes

| | Hooks | MCP server |
|---|---|---|
| **Claude Code** | `.claude/settings.local.json`, or `~/.claude/settings.json` with `--global` | `claude mcp add synapse` (local, or user scope with `--global`) |
| **Cursor** | `.cursor/hooks.json`, or `~/.cursor/hooks.json` with `--global` | `.cursor/mcp.json`, or `~/.cursor/mcp.json` with `--global` |
| **Codex** | `.codex/hooks.json`, or `~/.codex/hooks.json` with `--global` | A `[mcp_servers.synapse]` table in `.codex/config.toml`, or `~/.codex/config.toml` with `--global` |

How setup behaves:

- **Merges, never replaces.** Your other hooks and MCP servers are kept. A file is backed up as `*.synapse-backup` before it changes. Invalid JSON is reported and left untouched.
- **Safe to re-run.** Hooks already present are not added twice, and Codex's TOML gets the table appended only if it isn't there.
- **Pins absolute paths.** Commands use the absolute paths of the Node binary and `cli.js` that ran setup, so they keep working when your shell's default `node` is older than 22.
- **Binds the project.** Project-scoped MCP config sets `SYNAPSE_PROJECT_ROOT`, so the server knows which project it serves even when the agent starts it from elsewhere.
- **Keep project files private.** The project-level files contain machine-specific absolute paths, so keep `.claude/`, `.cursor/` and `.codex/` out of version control.

### After setup

- **Claude Code:** restart it.
- **Cursor:** restart Cursor or reload the window. Check that Settings → Hooks and Settings → MCP list `synapse`.
- **Codex:** start Codex and **approve the synapse hooks once in `/hooks`**, since Codex reviews hooks it didn't install itself before running them. Then start a new thread. A project's `.codex/` folder only loads when the project is trusted.

## What the hooks do

Each agent's events map onto the same behaviour:

| Behaviour | Claude Code | Cursor | Codex |
|---|---|---|---|
| Inject a project brief (≤700 tokens) at session start | `SessionStart` | `sessionStart` → `additional_context` | `SessionStart` → `additionalContext` |
| Record the session's first substantial prompt as its goal | `UserPromptSubmit` | `beforeSubmitPrompt` | `UserPromptSubmit` |
| Capture file edits | `PostToolUse` (Edit/Write/MultiEdit) | `afterFileEdit` | `PostToolUse` (`apply_patch`, split per file) |
| Capture significant or failing commands | `PostToolUse` (Bash) | `afterShellExecution` | `PostToolUse` (Bash) |
| Checkpoint a session summary | `PreCompact` | `preCompact` | `PreCompact` |
| Close the session with a summary | `SessionEnd` | `sessionEnd` | `SessionEnd` (3-second limit) |

Sessions use the agent's own id: Claude's and Codex's `session_id`, Cursor's `conversation_id`. They're labelled `claude-code`, `cursor` or `codex`.

### Capture rules

- **Edits** become a `what-changed` memory. Repeated edits to one file in one session update **one rolling record** that keeps an excerpt of the latest change. The entity comes from the path (`src/api/limit.ts` → `api`). Edits to files **outside the project** are ignored.
- **Commands** are captured only when they matter:
  - build, test, lint, install, deploy or migration commands → `discovery`
  - commands that **failed** → `gotcha`. A failure is a non-zero exit code when the agent reports one (Codex does), otherwise a failure-shaped line: `Error:`, `error[…]:`, `npm ERR!`, `N failed`, a traceback, `command not found`, and so on. Output that merely contains the word "error", such as a grep of source code, doesn't count.
  - trivial commands (`ls`, `cd`, `cat`, `git status`, …) are ignored, unless chained with real work, as in `cd app && npm test`.
- **Never captured:** read-only tools, Synapse's own MCP tools, commands that run `synapse`, and output that is Synapse's own search results.

Everything captured is a down-ranked **candidate**:

- `source: hook`, `admissionState: candidate`, `valueCategory: ephemeral`
- It is searchable, but scores ×0.45.
- It is never shown as a caution.
- It decays four times faster than an explicit memory.

Promote the useful ones with `synapse_qualify`.

### Safety

- **Never blocks the agent.** A hook always exits 0, whatever goes wrong. Set `SYNAPSE_DEBUG=1` to print errors to stderr.
- **Old Node is harmless.** On Node versions without `node:sqlite`, `synapse hook` exits quietly instead of failing.
- **Secrets are redacted** in everything captured.

## The hook command

```bash
synapse hook [--agent claude|cursor|codex]
```

`synapse hook` reads one hook event as JSON from stdin and prints the response in that agent's format. Setup passes `--agent` explicitly. Without it, Cursor payloads are recognised automatically, and anything else is treated as Claude format (which Codex shares).

## Controlling injection

| `SYNAPSE_HOOK_INJECT` | Session-start behaviour |
|---|---|
| `full` (default) | Hint plus project brief |
| `minimal` | One-line hint only |
| `silent` | Nothing injected |

## Claude Code plugin (alternative)

The repo is also a Claude Code plugin marketplace:

```
/plugin marketplace add /path/to/synapse
/plugin install synapse@synapse
```

The plugin bundles the MCP server, the hooks and a `synapse-memory` skill. It calls `synapse` from your PATH, so `synapse` must be linked under Node 22.

## Other MCP clients

Agents without hook support (Windsurf, VS Code Copilot, Gemini CLI, Claude Desktop, …) can still use the tools:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "/absolute/path/to/node22",
      "args": ["/absolute/path/to/synapse/dist/cli.js", "serve"],
      "env": { "SYNAPSE_PROJECT_ROOT": "/path/to/project" }
    }
  }
}
```

Without hooks nothing happens automatically, so tell the agent to use memory in its instructions file (`AGENTS.md`, rules, …):

```markdown
- For non-trivial tasks, call `synapse_project_context` with the task first.
- Search Synapse before re-investigating past bugs or decisions.
- Store decisions, gotchas and fixes with `synapse_store`; end with `synapse_session_end`.
```

**Cloud agents** (Devin, Codex cloud, …) run on remote machines and can't reach a Synapse server on your computer. Install Synapse on their machine instead; its memory then stays there.

## Troubleshooting

| Symptom | Check |
|---|---|
| Tools missing | Claude: `claude mcp list`. Cursor: Settings → MCP. Codex: `[mcp_servers.synapse]` in `config.toml`. Then restart the agent |
| Codex hooks don't run | Approve them in `/hooks`. For project setup, the project must be trusted |
| No brief at session start | `SYNAPSE_HOOK_INJECT` isn't `silent`; the hooks file contains the synapse command; run with `SYNAPSE_DEBUG=1` |
| `synapse requires Node.js >= 22.13` | Re-run setup under Node 22 so its absolute path is pinned |
| Memories land in the wrong project | `synapse doctor` from that directory shows the detected project id. Check the git remote or `SYNAPSE_PROJECT_ROOT` |
| Search says "fresh project" | Nothing has been stored for this project id yet. Try `synapse projects` |
