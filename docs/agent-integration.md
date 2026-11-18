# Agent integration

Synapse connects to coding agents in two ways:

- an **MCP server**, which gives the agent its `synapse_*` tools
- **lifecycle hooks**, which add automatic context and capture without the agent having to decide to use memory

`synapse setup` installs both for **Claude Code**, **Cursor**, **Codex** and **Devin CLI**:

```bash
synapse setup claude   [--global] [--dry-run]
synapse setup cursor   [--global] [--dry-run]
synapse setup codex    [--global] [--dry-run]
synapse setup devin    [--global] [--dry-run] [--allow-tools]
```

Without `--global`, setup configures the project in the current directory, including its [agent instructions](#agent-instructions). With `--global`, it configures every project for that agent. `--dry-run` prints what would change and writes nothing.

All three agents share one memory store (`~/.synapse/synapse.db`), so a decision stored from Cursor shows up in Claude Code's next brief.

## What setup writes

| | Hooks | MCP server |
|---|---|---|
| **Claude Code** | `.claude/settings.local.json`, or `~/.claude/settings.json` with `--global` | `claude mcp add synapse` (local, or user scope with `--global`) |
| **Cursor** | `.cursor/hooks.json`, or `~/.cursor/hooks.json` with `--global` | `.cursor/mcp.json`, or `~/.cursor/mcp.json` with `--global` |
| **Codex** | `.codex/hooks.json`, or `~/.codex/hooks.json` with `--global` | A `[mcp_servers.synapse]` table in `.codex/config.toml`, or `~/.codex/config.toml` with `--global` |
| **Devin CLI** | `.devin/hooks.v1.json`, or `~/.config/devin/config.json` with `--global`. **Skipped** when Devin already imports Synapse's Claude Code hooks (see below) | `devin mcp add` (local scope: `.devin/mcp_config.local.json`; user scope with `--global`: `~/.config/devin/mcp_config.json`). Setup writes the file directly if the `devin` command isn't available |

| **Instructions** (all agents, project scope) | A marked block in `CLAUDE.md` (Claude Code) or `AGENTS.md` (Cursor, Codex, Devin CLI) at the project root | |

How setup behaves:

- **Merges, never replaces.** Your other hooks and MCP servers are kept. A file is backed up as `*.synapse-backup` before it changes. Invalid JSON is reported and left untouched.
- **Safe to re-run.** Hooks already present are not added twice, and Codex's TOML gets the table appended only if it isn't there.
- **Pins absolute paths.** Commands use the absolute paths of the Node binary and `cli.js` that ran setup, so they keep working when your shell's default `node` is older than 22.
- **Binds the project.** Project-scoped MCP config sets `SYNAPSE_PROJECT_ROOT`, so the server knows which project it serves even when the agent starts it from elsewhere.
- **Marks hooks as installed.** Every MCP registration gets `SYNAPSE_HOOKS=1`, so the server leaves the brief and the session to the hooks instead of doing that work itself ([agents without hooks](#agents-without-hooks)). Re-run setup after upgrading so older registrations get it. Codex's existing `[mcp_servers.synapse]` table isn't rewritten; setup tells you the line to add.
- **Keep project files private.** The project-level files contain machine-specific absolute paths, so keep `.claude/`, `.cursor/`, `.codex/` and `.devin/` out of version control.

### Agent instructions

Hooks deliver context automatically, but storing what was learned is the agent's own choice, and agents rarely make it unprompted. So setup adds a short Markdown block to the project's instructions file, telling the agent when to search, what to store (non-obvious fixes, gotchas, decisions, how things work), what not to store, how to handle "changed since" flags, and to leave long-term approval to you.

- **Which file:** `CLAUDE.md` for Claude Code; `AGENTS.md` for Cursor, Codex and Devin CLI.
- **Merged, not replaced.** The block sits between `<!-- synapse:start -->` and `<!-- synapse:end -->`. Re-running setup refreshes it in place and leaves the rest of the file alone. A changed file is backed up first.
- **One copy for Devin.** Devin CLI loads both `CLAUDE.md` and `AGENTS.md` as always-on rules. If `CLAUDE.md` already has the block, `setup devin` skips `AGENTS.md`. If `AGENTS.md` already has it, `setup claude` adds an `@AGENTS.md` import line to `CLAUDE.md` instead of a second copy (Claude Code expands the import; Devin sees only the line).
- **Commit these files.** Unlike the hook and MCP config, they contain no machine paths, so teammates' agents get the same instructions.
- **Opt out** with `--no-instructions`. With `--global` nothing is written; paste the output of `synapse instructions` into your global `CLAUDE.md` or `AGENTS.md` if you want it everywhere.

Devin reads any file named `agents.md` (case-insensitive) as an AGENTS.md rule for its directory, so avoid naming a nested doc `agents.md` unless it is meant as instructions for that directory (this guide is `agent-integration.md` for that reason).

### After setup

- **Claude Code:** restart it.
- **Cursor:** restart Cursor or reload the window. Check that Settings → Hooks and Settings → MCP list `synapse`.
- **Codex:** start Codex and **approve the synapse hooks once in `/hooks`**, since Codex reviews hooks it didn't install itself before running them. Then start a new thread. A project's `.codex/` folder only loads when the project is trusted.
- **Devin CLI:** start a new session; `devin mcp list` should show `synapse`. Devin asks before each Synapse tool call, and non-interactive `devin -p` runs reject those calls. To pre-approve Synapse's tools, run `synapse setup devin --allow-tools`. It adds one `mcp__synapse__<tool>` rule per Synapse tool to `permissions.allow` in your **user** config (`~/.config/devin/config.json`), merged with your existing rules and backed up first. `synapse_lt_approve` is deliberately left out, so Devin still asks you before an agent approves a long-term memory (Devin doesn't honor Claude Code's always-ask marker, so this is how the gate holds there). Re-running replaces the `mcp__synapse__*` wildcard that older versions added, and drops rules for tools that no longer exist; re-run it after upgrading Synapse so new tools are covered. It deliberately never writes a project-level `permissions` block, because in Devin a project block replaces your user-level rules for that project instead of extending them.

### Devin CLI and Claude Code hooks

By default, Devin CLI also **runs Claude Code's hooks** (from `.claude/settings*.json`, `~/.claude/settings*.json` and `~/.claude.json`; setting `read_config_from.claude`). Synapse handles this deliberately:

- **Detection.** Devin sets `DEVIN_PROJECT_DIR` for every hook it runs, and Claude Code never does. So a Claude-installed Synapse hook running inside Devin is treated as Devin: Devin's tool names are understood, the project comes from `DEVIN_PROJECT_DIR`, and sessions are labelled `devin`.
- **No double hooks.** `setup devin` adds hooks to Devin's own files only when no Synapse Claude hook would be imported. If both end up installed, `setup claude` and `setup devin` warn you, because every event would otherwise run twice.
- **Turned import off?** If you disabled `read_config_from.claude`, remove the Claude hooks Devin relied on (or re-enable import) and re-run `synapse setup devin`.

## What the hooks do

Each agent's events map onto the same behaviour:

| Behaviour | Claude Code | Cursor | Codex | Devin CLI |
|---|---|---|---|---|
| Inject a project brief (≤700 tokens) at session start | `SessionStart` | `sessionStart` → `additional_context` | `SessionStart` → `additionalContext` | `SessionStart` → `additionalContext` |
| Record the session's first substantial prompt as its goal | `UserPromptSubmit` | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit` |
| Capture file edits | `PostToolUse` (Edit/Write/MultiEdit) | `afterFileEdit` | `PostToolUse` (`apply_patch`, split per file) | `PostToolUse` (`edit`, `write`, `notebook_edit`, `apply_patch`) |
| Capture significant or failing commands | `PostToolUse` (Bash) | `afterShellExecution` | `PostToolUse` (Bash) | `PostToolUse` (`exec`) |
| Add a compaction checkpoint and refresh the session summary | `PreCompact` | `preCompact` | `PreCompact` | `PostCompaction` (falls back to Devin's own summary) |
| Close the session with a summary | `SessionEnd` | `sessionEnd` | `SessionEnd` (3-second limit) | `SessionEnd` (not fired in Devin cloud sessions) |

Sessions use the agent's own id: `session_id` for Claude, Codex and Devin, and `conversation_id` for Cursor. They're labelled `claude-code`, `cursor`, `codex` or `devin`. Any hook event other than `SessionEnd` for a session that already ended (a resume under the same id) reopens it, so its end summary also covers the work after resuming.

Every compaction records a checkpoint. Whether the agent gets that checkpoint back depends on whether it fires `SessionStart` again after compaction:

| Agent | Resume keeps the session id | `SessionStart` after compaction | Checkpoint shown |
|---|---|---|---|
| Claude Code | Yes (`source: resume`), verified | Yes (`source: compact`), verified | After compaction and on resume |
| Codex | Not documented | Yes (`source: compact`, per OpenAI's hooks docs), not tested | After compaction, if the id is kept |
| Devin CLI | Yes (`source: resume`), verified on 3000.12.57 | No (`source` is only `startup` or `resume`) | On resume only |
| Cursor | Not documented | No, per user reports | Not shown; still listed by `synapse checkpoint` |

Devin CLI's payloads were verified against a real run of devin 3000.12.57: `write` sends `file_path` and `content`, `edit` sends `file_path`, `old_string` and `new_string`, and `exec` sends `command` with a `{success, output, error}` result. In that result, `success` only means the tool ran; a failing command still reports `success: true`, with `Exit code: N` in its output, which is what Synapse checks. Other common field names (`path`, `filePath`, `new_str`, `new_source`, `edits`, …) are also accepted, in case Devin's tools change.

### Capture rules

- **Edits** become a `what-changed` memory. Repeated edits to one file in one session update **one rolling record** that keeps an excerpt of the latest change. The entity comes from the path (`src/api/limit.ts` → `api`). Edits to files **outside the project** are ignored.
- **Commands** are captured only when they matter:
  - build, test, lint, install, deploy or migration commands → `discovery`
  - commands that **failed** → `gotcha`. A failure is a non-zero exit code when the agent reports one (Codex does), `success: false` or `Exit code: N` (Devin), or otherwise a failure-shaped line: `Error:`, `error[…]:`, `file:line: error:`, `file(l,c): error`, `npm ERR!`, `N failed`, a traceback, `command not found`, and so on. Output that merely contains the word "error", such as a grep of source code, doesn't count.
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
synapse hook [--agent claude|cursor|codex|devin]
```

`synapse hook` reads one hook event as JSON from stdin and prints the response in that agent's format. Setup passes `--agent` explicitly, except for Claude Code. Without it, Cursor payloads are recognised from their fields, and Devin from `DEVIN_PROJECT_DIR`; anything else is treated as Claude format, which Codex shares.

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

Any MCP client (Windsurf, VS Code Copilot, Gemini CLI, Claude Desktop, …) can use Synapse:

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

Leave `SYNAPSE_HOOKS` unset: the server then stands in for the hooks (below). Also paste the output of `synapse instructions` into the agent's instructions file (`AGENTS.md`, rules, …), and run `synapse setup git` in the project.

### Agents without hooks

Without `SYNAPSE_HOOKS=1`, the MCP server does part of the hooks' job itself:

| Hooks do | Without hooks |
|---|---|
| Brief at session start | The brief goes into the server's **MCP instructions**, which clients that support them show to the model when the session starts. Clients not known to do that get the brief at the top of the **first Synapse tool result** instead (skipped when that first call is `synapse_project_context`). Claude Code is known to show instructions (verified live). |
| One session per agent session | **One session per server process.** It opens on the first tool call, labelled with the client's name, and closes with an automatic summary when the agent exits or closes the connection. `synapse_session_end` closes it early; the next call opens a new one. |
| Session goal from your first prompt | The task of the first `synapse_project_context` call |
| Capture of edits and commands | Not available. `synapse setup git` records each commit instead. |
| Compaction checkpoints | Not available |

Limits: a client that keeps one server running across several chats gets one long session for all of them, and a session's summary only lists what was stored through the tools (there's no edit capture).

### Git hook: commits from any agent

```bash
synapse setup git [--dry-run]
```

Installs a `post-commit` hook that runs `synapse ingest-git` in the background after each commit, so every commit becomes a typed memory, whichever agent or person made it. It never fails or slows a commit.

- Honors `core.hooksPath`, and appends to an existing shell hook between `# synapse:start` and `# synapse:end` markers (re-running refreshes them).
- Leaves non-shell hooks alone and, for husky, prints the line to add to `.husky/post-commit`.
- Merge, version-bump and lockfile commits are filtered out as noise, as with `synapse ingest-git`. Descriptive commit messages make better memories.
- Useful with hooked agents too: it covers commits made outside any agent.

**Cloud agents** (Devin's cloud sessions, Codex cloud, …) run on remote machines and can't reach a Synapse server on your computer. Install Synapse on their machine instead; its memory then stays there. The local **Devin CLI** is fully supported through `synapse setup devin`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Tools missing | Claude: `claude mcp list`. Cursor: Settings → MCP. Codex: `[mcp_servers.synapse]` in `config.toml`. Then restart the agent |
| Codex hooks don't run | Approve them in `/hooks`. For project setup, the project must be trusted |
| Devin events recorded twice | Synapse hooks exist in both Claude and Devin config; keep one. `synapse setup devin` and `setup claude` print which files |
| No brief at session start | `SYNAPSE_HOOK_INJECT` isn't `silent`; the hooks file contains the synapse command; run with `SYNAPSE_DEBUG=1` |
| `synapse requires Node.js >= 22.13` | Re-run setup under Node 22 so its absolute path is pinned |
| Memories land in the wrong project | `synapse doctor` from that directory shows the detected project id. Check the git remote or `SYNAPSE_PROJECT_ROOT` |
| Search says "fresh project" | Nothing has been stored for this project id yet. Try `synapse projects` |
