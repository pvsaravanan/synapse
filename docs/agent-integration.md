# Agent integration

Synapse connects to coding agents in two ways:

- an **MCP server**, which gives the agent its `synapse_*` tools
- **lifecycle hooks**, which add automatic context and capture without the agent having to decide to use memory

`synapse setup` installs both for **Claude Code**, **Cursor**, **Codex**, **Devin CLI**, **GitHub Copilot CLI**, **Gemini CLI** and **Antigravity**:

```bash
synapse setup claude   [--global] [--dry-run]
synapse setup cursor   [--global] [--dry-run]
synapse setup codex    [--global] [--dry-run]
synapse setup devin    [--global] [--dry-run] [--allow-tools]
synapse setup copilot  [--global] [--dry-run]
synapse setup gemini   [--global] [--dry-run]
synapse setup antigravity [--global] [--dry-run]
```

Without `--global`, setup configures the project in the current directory, including its [agent instructions](#agent-instructions). With `--global`, it configures every project for that agent. `--dry-run` prints what would change and writes nothing.

All agents share one memory store (`~/.synapse/synapse.db`), so a decision stored from Cursor shows up in Claude Code's next brief.

## What setup writes

| | Hooks | MCP server |
|---|---|---|
| **Claude Code** | `.claude/settings.local.json`, or `~/.claude/settings.json` with `--global` | `claude mcp add synapse` (local, or user scope with `--global`) |
| **Cursor** | `.cursor/hooks.json`, or `~/.cursor/hooks.json` with `--global` | `.cursor/mcp.json`, or `~/.cursor/mcp.json` with `--global` |
| **Codex** | `.codex/hooks.json`, or `~/.codex/hooks.json` with `--global` | A `[mcp_servers.synapse]` table in `.codex/config.toml`, or `~/.codex/config.toml` with `--global` |
| **Devin CLI** | `.devin/hooks.v1.json`, or `~/.config/devin/config.json` with `--global`. **Skipped** when Devin already imports Synapse's Claude Code hooks (see below) | `devin mcp add` (local scope: `.devin/mcp_config.local.json`; user scope with `--global`: `~/.config/devin/mcp_config.json`). Setup writes the file directly if the `devin` command isn't available |
| **Copilot CLI** | The `hooks` field of `.github/copilot/settings.local.json`, or `~/.copilot/hooks/synapse.json` with `--global` | `~/.copilot/mcp-config.json` (user config, in both cases) |
| **Gemini CLI** | `.gemini/settings.json`, or `~/.gemini/settings.json` with `--global` | The same file (`mcpServers.synapse`) |
| **Antigravity** | A `synapse` entry in `.agents/hooks.json`, or `~/.gemini/config/hooks.json` with `--global` | `.agents/mcp_config.json`, or `~/.gemini/config/mcp_config.json` with `--global` |
| **Instructions** (all agents, project scope) | A marked block in `CLAUDE.md` (Claude Code), `GEMINI.md` (Gemini CLI) or `AGENTS.md` (Cursor, Codex, Devin CLI, Copilot CLI, Antigravity) at the project root | |

How setup behaves:

- **Merges, never replaces.** Your other hooks and MCP servers are kept. A file is backed up as `*.synapse-backup` before it changes. Invalid JSON is reported and left untouched.
- **Safe to re-run.** Hooks already present are not added twice: their commands are refreshed in place, so a moved install or a new Node path takes effect, and events added by newer versions are filled in. Codex's TOML gets the table appended only if it isn't there.
- **Pins absolute paths.** Commands use the absolute paths of the Node binary and `cli.js` that ran setup, so they keep working when your shell's default `node` is older than 22.
- **Binds the project.** Project-scoped MCP config sets `SYNAPSE_PROJECT_ROOT`, so the server knows which project it serves even when the agent starts it from elsewhere.
- **Marks hooks as installed.** Every MCP registration gets `SYNAPSE_HOOKS=1`, so the server leaves the brief and the session to the hooks instead of doing that work itself ([agents without hooks](#agents-without-hooks)). Re-run setup after upgrading so older registrations get it. Codex's existing `[mcp_servers.synapse]` table isn't rewritten; setup tells you the line to add.
- **Keep project files private.** The project-level files contain machine-specific absolute paths, so keep `.claude/`, `.cursor/`, `.codex/`, `.devin/`, `.gemini/`, `.github/copilot/settings.local.json`, `.agents/hooks.json` and `.agents/mcp_config.json` out of version control.

### Agent instructions

Hooks deliver context automatically, but storing what was learned is the agent's own choice, and agents rarely make it unprompted. So setup adds a short Markdown block to the project's instructions file, telling the agent when to search, what to store (non-obvious fixes, gotchas, decisions, how things work), what not to store, how to handle "changed since" flags, and to leave long-term approval to you.

- **Which file:** `CLAUDE.md` for Claude Code, `GEMINI.md` for Gemini CLI, `AGENTS.md` for Cursor, Codex, Devin CLI, Copilot CLI and Antigravity (which file Antigravity reads isn't documented).
- **Merged, not replaced.** The block sits between `<!-- synapse:start -->` and `<!-- synapse:end -->`. Re-running setup refreshes it in place and leaves the rest of the file alone. A changed file is backed up first.
- **One copy for Devin.** Devin CLI loads both `CLAUDE.md` and `AGENTS.md` as always-on rules. If `CLAUDE.md` already has the block, `setup devin` skips `AGENTS.md`. If `AGENTS.md` already has it, `setup claude` adds an `@AGENTS.md` import line to `CLAUDE.md` instead of a second copy (Claude Code expands the import; Devin sees only the line). Likewise, `setup gemini` writes an `@./AGENTS.md` import to `GEMINI.md` when `AGENTS.md` already has the block.
- **Commit these files.** Unlike the hook and MCP config, they contain no machine paths, so teammates' agents get the same instructions.
- **Opt out** with `--no-instructions`. With `--global` nothing is written; paste the output of `synapse instructions` into your global `CLAUDE.md` or `AGENTS.md` if you want it everywhere.

Devin reads any file named `agents.md` (case-insensitive) as an AGENTS.md rule for its directory, so avoid naming a nested doc `agents.md` unless it is meant as instructions for that directory (this guide is `agent-integration.md` for that reason).

### After setup

- **Claude Code:** restart it.
- **Cursor:** restart Cursor or reload the window. Check that Settings → Hooks and Settings → MCP list `synapse`.
- **Codex:** start Codex and **approve the synapse hooks once in `/hooks`**, since Codex reviews hooks it didn't install itself before running them. Then start a new thread. A project's `.codex/` folder only loads when the project is trusted.
- **Devin CLI:** start a new session; `devin mcp list` should show `synapse`. Devin asks before each Synapse tool call, and non-interactive `devin -p` runs reject those calls. To pre-approve Synapse's tools, run `synapse setup devin --allow-tools`. It adds one `mcp__synapse__<tool>` rule per Synapse tool to `permissions.allow` in your **user** config (`~/.config/devin/config.json`), merged with your existing rules and backed up first. `synapse_lt_approve` is deliberately left out, so Devin still asks you before an agent approves a long-term memory (Devin doesn't honor Claude Code's always-ask marker, so this is how the gate holds there). Re-running replaces the `mcp__synapse__*` wildcard that older versions added, and drops rules for tools that no longer exist; re-run it after upgrading Synapse so new tools are covered. It deliberately never writes a project-level `permissions` block, because in Devin a project block replaces your user-level rules for that project instead of extending them.
- **Copilot CLI:** start a new session in the project; `/mcp` should list `synapse`. Project hooks load only for **trusted folders**: approve the folder when Copilot asks, or add it to `trustedFolders` in `~/.copilot/config.json`. Until then Copilot skips them silently (its log says "Skipped repository hooks … is not trusted"); `--global` hooks don't need trust. The MCP server is registered in your user config rather than the project's `.mcp.json` or `.github/mcp.json`: those are meant to be committed, and Claude Code reads `.mcp.json` too. It binds to the directory Copilot starts in. Copilot passes MCP servers only `PATH`, so if you use a custom `SYNAPSE_DB`, add it to the server's `env` in `~/.copilot/mcp-config.json`.
- **Gemini CLI:** start a new session; `/mcp` should list `synapse` and `/hooks` the Synapse hooks. Hooks need Gemini CLI 0.26 or later. Google moved consumer accounts from Gemini CLI to Antigravity CLI in June 2026; Antigravity uses a different hook format (`synapse setup antigravity`), so this is for Gemini CLI with an API key or an enterprise license; use `synapse setup antigravity` for Antigravity.
- **Antigravity:** restart it, or start a new Antigravity CLI session. Antigravity has no session-end or compaction event, so a session is summarized and closed each time the agent loop stops (`Stop`) and reopens on the next prompt, and there are no compaction checkpoints.

### Devin CLI and Claude Code hooks

By default, Devin CLI also **runs Claude Code's hooks** (from `.claude/settings*.json`, `~/.claude/settings*.json` and `~/.claude.json`; setting `read_config_from.claude`). Synapse handles this deliberately:

- **Detection.** Devin sets `DEVIN_PROJECT_DIR` for every hook it runs, and Claude Code never does. So a Claude-installed Synapse hook running inside Devin is treated as Devin: Devin's tool names are understood, the project comes from `DEVIN_PROJECT_DIR`, and sessions are labelled `devin`.
- **No double hooks.** `setup devin` adds hooks to Devin's own files only when no Synapse Claude hook would be imported. If both end up installed, `setup claude` and `setup devin` warn you, because every event would otherwise run twice.
- **Turned import off?** If you disabled `read_config_from.claude`, remove the Claude hooks Devin relied on (or re-enable import) and re-run `synapse setup devin`.

## What the hooks do

Each agent's events map onto the same behaviour:

| Behaviour | Claude Code | Cursor | Codex | Devin CLI | Copilot CLI | Gemini CLI | Antigravity |
|---|---|---|---|---|---|---|---|
| Inject a project brief (≤700 tokens) at session start | `SessionStart` | `sessionStart` → `additional_context` | `SessionStart` → `additionalContext` | `SessionStart` → `additionalContext` | `sessionStart` → `additionalContext` | `SessionStart` → `additionalContext` | `SessionStart` → `injectSteps` |
| Record the session's first substantial prompt as its goal | `UserPromptSubmit` | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit` | `userPromptSubmitted` | `BeforeAgent` | `PreInvocation` (`lastUserInput`) |
| [Note the memories about a file](#file-notes) the agent reads or edits | `PostToolUse` (`Read`, edits, files a Bash command names) → `additionalContext` | Not available | `PreToolUse` (`apply_patch` per file, shell commands) → `additionalContext`, before the tool runs | Not available | Not available | `AfterTool` (`read_file`, edits) → `additionalContext` | Not available |
| Capture file edits | `PostToolUse` (Edit/Write/MultiEdit) | `afterFileEdit` | `PostToolUse` (`apply_patch`, split per file) | `PostToolUse` (`edit`, `write`, `notebook_edit`, `apply_patch`) | `postToolUse` (`edit`, `create`, `apply_patch`) | `AfterTool` (`replace`, `write_file`) | `PostToolUse` (`write_to_file`, `replace_file_content`, `multi_replace_file_content`) |
| Capture significant or failing commands | `PostToolUse` (Bash) | `afterShellExecution` | `PostToolUse` (Bash) | `PostToolUse` (`exec`) | `postToolUse`, `postToolUseFailure` (`bash`) | `AfterTool` (`run_shell_command`) | `PostToolUse` (`run_command`; failure from `error`, no output) |
| Add a compaction checkpoint and refresh the session summary | `PreCompact` | `preCompact` | `PreCompact` | `PostCompaction` (falls back to Devin's own summary) | `preCompact` | `PreCompress` | Not available |
| [Remind the agent to store what it learned](#store-reminder) (once per session) | `Stop` → `decision: block` | Not available | `Stop` → `decision: block` (from Codex's docs, not tested) | Not available | Not available | Not available | `Stop` → `decision: continue` (from the docs, not tested) |
| Close the session with a summary | `SessionEnd` | `sessionEnd` | `SessionEnd` (3-second limit) | `SessionEnd` (not fired in Devin cloud sessions) | `sessionEnd` | `SessionEnd` | `Stop` (reopened by the next prompt) |

Sessions use the agent's own id: `session_id` for Claude, Codex, Devin and Gemini, `sessionId` for Copilot, `conversationId` for Antigravity, and `conversation_id` for Cursor. They're labelled `claude-code`, `cursor`, `codex`, `devin`, `copilot`, `gemini` or `antigravity`. Any hook event other than `SessionEnd` for a session that already ended (a resume under the same id) reopens it, so its end summary also covers the work after resuming.

Every compaction records a checkpoint. Whether the agent gets that checkpoint back depends on whether it fires `SessionStart` again after compaction:

| Agent | Resume keeps the session id | `SessionStart` after compaction | Checkpoint shown |
|---|---|---|---|
| Claude Code | Yes (`source: resume`), verified | Yes (`source: compact`), verified | After compaction and on resume |
| Codex | Not documented | Yes (`source: compact`, per OpenAI's hooks docs), not tested | After compaction, if the id is kept |
| Devin CLI | Yes (`source: resume`), verified on 3000.12.57 | No (`source` is only `startup` or `resume`) | On resume only |
| Cursor | Not documented | No, per user reports | Not shown; still listed by `synapse checkpoint` |
| Copilot CLI | `source: resume` documented, not tested | Not documented | On resume, if the id is kept |
| Gemini CLI | `source: resume` documented, not tested | No (`source` is `startup`, `resume` or `clear`) | On resume only |

Devin CLI's payloads were verified against a real run of devin 3000.12.57: `write` sends `file_path` and `content`, `edit` sends `file_path`, `old_string` and `new_string`, and `exec` sends `command` with a `{success, output, error}` result. In that result, `success` only means the tool ran; a failing command still reports `success: true`, with `Exit code: N` in its output, which is what Synapse checks. Other common field names (`path`, `filePath`, `new_str`, `new_source`, `edits`, …) are also accepted, in case Devin's tools change.

**Copilot CLI was verified against a real run of Copilot CLI 1.0.114.** Setup uses the camelCase events, whose payloads carry no event name, so each hook command passes `--event`. In that run:

- `userPromptSubmitted` fires before `sessionStart`; both carry `sessionId` and `cwd`, and `sessionStart`'s `additionalContext` reached the model.
- With a GPT model, edits came as one `apply_patch` call whose `toolArgs` is the raw patch text (absolute paths); Synapse splits it per file, as for Codex. Other models use `edit` and `create` with an object `toolArgs`; the common field names (`path`, `file_path`, `new_str`, `file_text`, `content`, …) are accepted.
- A failing `bash` command still reports `resultType: "success"`. Its output ends with `<shellId: N completed with exit code N>`, which Synapse reads as the exit code. `postToolUseFailure` is for tool errors (a failed `glob`, say).
- Memories stored over MCP during the session join the hook session and appear in its summary.

The PascalCase events (snake_case payloads with Claude tool names) are understood too.

**Antigravity is implemented from its [hooks reference](https://antigravity.google/docs/hooks), not verified against a live run.** Its payloads carry no event name, so setup passes `--event`; the project comes from `workspacePaths[0]`, and the brief goes out as an `injectSteps` system message. `PostToolUse` runs for every tool (`matcher: "*"`) and keeps only the file tools and `run_command`.

**Gemini CLI is implemented from its hook reference, not verified against a live run.** `AfterTool` is limited to the edit, shell and `read_file` tools by its matcher (`read_file` only for [file notes](#file-notes); reads aren't captured). A shell command's exit code is read from the `Exit Code: N` line of its result.

### Capture rules

- **Edits** become a `what-changed` memory. Repeated edits to one file in one session update **one rolling record** that keeps an excerpt of the latest change. The entity comes from the path (`src/api/limit.ts` → `api`). Edits to files **outside the project**, and to files matched by [`.synapseignore`](concepts.md#ignored-files) or the secret-file defaults (`.env*`, `*.pem`, …), are ignored. When the session ends, its edit records in one area are [merged into one](concepts.md#consolidation).
- **Commands** are captured only when they matter:
  - build, test, lint, install, deploy or migration commands → `discovery`
  - commands that **failed** → `gotcha`. A failure is a non-zero exit code when the agent reports one (Codex does, and Gemini's `Exit Code: N`), `success: false` or `Exit code: N` (Devin), a non-`success` result or `completed with exit code N` (Copilot), or otherwise a failure-shaped line: `Error:`, `error[…]:`, `file:line: error:`, `file(l,c): error`, `npm ERR!`, `N failed`, a traceback, `command not found`, and so on. Output that merely contains the word "error", such as a grep of source code, doesn't count.
  - trivial commands (`ls`, `cd`, `cat`, `git status`, …) are ignored, unless chained with real work, as in `cd app && npm test`.
  - **read-only commands** (searches and file prints: `grep`, `rg`, `find`, `sed` without `-i`, `awk`, `jq`, `diff`, …, alone or chained with each other) are ignored even when they "fail", since `grep` exits 1 on no match and printed code can look like an error. They're kept only when the command itself broke: `command not found`, `No such file or directory`, `Permission denied`, an invalid option.
  - "Significant" is judged on each command's **program words**, not its arguments: `npx vitest run tests/a.test.ts` is a test run, but `grep -n x tests/a.test.ts`, or a `python3 -` or `cat >> file` heredoc whose body mentions "test", is not. Chains split on `&&`, `||`, `;`, `|` and newlines outside quotes.
- **Fixes** are detected: when a command passes after the same command failed earlier in the session, and files were edited in between, Synapse records a draft `problem-solution` (`Fixed: npm test`) with the failure output, the files changed and both commands, and resolves the failure record. Commands are matched on what they run, not their exact text: `npm test 2>&1 | tail -30` and `cd app && npm test` both count as `npm test`. A pass with no edits in between (a flaky test, an environment change) isn't a fix. When the agent stores its own `problem-solution` in that session, the drafts for the same files are resolved, since the agent's account of the cause replaces them.
- **Never captured:** read-only tools, Synapse's own MCP tools, commands that run `synapse`, and output that is Synapse's own search results.

Everything captured is a down-ranked **candidate**:

- `source: hook`, `admissionState: candidate`, `valueCategory: ephemeral`
- It is searchable, but scores ×0.45.
- It is never shown as a caution.
- It decays four times faster than an explicit memory.

Promote the useful ones with `synapse_qualify`, or edit and keep them in [`synapse ui`](cli.md#synapse-ui). Candidates nobody keeps, reads or rates are archived after 14 days (`SYNAPSE_CANDIDATE_DAYS`; see [consolidation](concepts.md#consolidation)).

### File notes

The brief at session start can't know which files the task will touch, and agents rarely search before editing. So when the agent **reads or edits a project file**, or runs a shell command naming one (`sed -n 1,80p src/ui.ts`), the hooks add the memories about that file to its context:

```
Synapse memory about src/ui-page.ts:
⚠ #126 gotcha: UI page is a String.raw template: no backticks or ${ in page JS
• #141 how-it-works: synapse ui Graph view: hand-rolled force layout on canvas [changed since stored]
Read one in full with synapse_detail before relying on it; check [changed since stored] ones against the current code.
```

- **Which memories:** active ones that name the file, reviewed only (stored by an agent or a person, or candidates someone kept; raw hook captures never), at most 3 per file and 3 files per tool call, gotchas first, then decisions, fixes and explanations. `[changed since stored]` marks memories whose files changed after they were stored.
- **Once per file per session**, so a file read ten times is noted once. Shown memories count as read.
- **Before the edit:** Claude Code must read a file before it can edit it, and the note rides on the read (`PostToolUse` `additionalContext`), so it arrives before the change. Codex gets it from `PreToolUse`, before `apply_patch` or the command runs; Gemini CLI on `read_file` (`AfterTool`). The context never carries a permission decision, so the normal approval flow is unchanged, and the hook still always exits 0.
- **Agents without a channel:** Cursor, Copilot CLI, Devin CLI and Antigravity document no way for these hooks to add context, so they get no file notes. Re-run `synapse setup codex` / `synapse setup gemini` so existing installs get the `PreToolUse` hook and the `read_file` matcher (`synapse doctor agents --fix` does it too).
- **Turn it off** with `SYNAPSE_FILE_NOTES=0` (`SYNAPSE_HOOK_INJECT=silent` turns it off as well).

### Store reminder

Hooks capture what happened, but only the agent knows what it learned, and agents rarely store memories unprompted. So when a turn ends, Synapse checks the session: if it **fixed something** (a draft fix exists) or **edited 3 or more files**, and the agent **stored no memory of its own**, the stop hook asks the agent to continue once with a reminder. The reminder names the work and any draft fix, and tells the agent to store a non-obvious cause and fix, gotcha or decision with `synapse_store`, or to finish if nothing is worth keeping.

- **Once per session.** It never repeats, and it stays quiet when the agent is already continuing because of a stop hook (`stop_hook_active`).
- **Agents:** Claude Code (verified live: after fixing a failing test, Claude stored the cause as a `problem-solution`), Codex and Antigravity. Re-run `synapse setup` so existing installs get the `Stop` hook.
- **Turn it off** with `SYNAPSE_NUDGE=0`.

### Safety

- **Never blocks the agent.** A hook always exits 0, whatever goes wrong. Set `SYNAPSE_DEBUG=1` to print errors to stderr.
- **Old Node is harmless.** On Node versions without `node:sqlite`, `synapse hook` exits quietly instead of failing.
- **Secrets are redacted** in everything captured.

## The hook command

```bash
synapse hook [--agent claude|cursor|codex|devin|copilot|gemini] [--event E]
```

`synapse hook` reads one hook event as JSON from stdin and prints the response in that agent's format. Setup passes `--agent` explicitly, except for Claude Code, and `--event` for Copilot CLI, whose payloads don't name their event. Without it, Cursor payloads are recognised from their fields, and Devin from `DEVIN_PROJECT_DIR`; anything else is treated as Claude format, which Codex shares.

## Controlling injection

| `SYNAPSE_HOOK_INJECT` | Session-start behaviour (`silent` also turns off file notes) |
| `SYNAPSE_FILE_NOTES` | `0` turns off [file notes](#file-notes) |
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

Any MCP client (Windsurf, Zed, VS Code Copilot, Claude Desktop, …) can use Synapse:

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
| Brief at session start | The brief goes into the server's **MCP instructions**, which clients that support them show to the model when the session starts. Clients not known to do that get the brief at the top of the **first Synapse tool result** instead (skipped when that first call is `synapse_project_context`). Claude Code is known to show instructions (verified live). Copilot CLI shows instructions only from servers it allowlists, so it gets the first-call brief (verified on 1.0.114; its client name is `copilot-cli`). |
| One session per agent session | **One session per server process.** It opens on the first tool call, labelled with the client's name, and closes with an automatic summary when the agent exits or closes the connection. `synapse_session_end` closes it early; the next call opens a new one. The summary is kept current after every tool call. Some clients kill their MCP servers outright when they exit (Copilot CLI sends `SIGKILL`, verified on 1.0.114), so the server never gets to close its session: each server records its process id, and the next server for the project closes sessions whose process is gone, with the summary they had. |
| Session goal from your first prompt | The task of the first `synapse_project_context` call |
| Capture of edits | **From the git working tree.** On each tool call, every 15 seconds in between, and at session end, the server compares the working tree with the previous check (`git status` plus content hashes). Files whose content changed become the session's edit records, as hooks would make them: they fill the summary's "Touched" list and the brief's "Start here" files, and the session's own memories naming them aren't flagged by [file freshness](concepts.md#file-freshness). Files that were already uncommitted when the server started, ignored files and files committed unchanged are left out. Outside a git repository, edits aren't tracked. |
| Capture of commands | Not available. `synapse setup git` records each commit instead. |
| Compaction checkpoints | **Rolling checkpoints.** The server can't see a compaction, so it writes a checkpoint (goal, files touched, memories stored) every 10 tool calls or 5 minutes when something changed, and keeps the session summary current. A later `synapse_project_context` call in a session that already did work leads with a fresh checkpoint, and the server instructions tell the agent to call it again when its context was summarized. There's no agent compaction summary. |

Limits:

- The server can't tell the agent's edits from yours: a file you change while the agent is connected counts as the session's.
- An edit made and committed within 15 seconds, between two tool calls, isn't seen as an edit (the git hook records the commit).
- When a client kills the server, an edit made in the last seconds before it exits can be missed, and the session stays open until the next server for the project starts.
- A client that keeps one server running across several chats gets one long session for all of them.

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

## Checking and repairing setup

```bash
synapse doctor agents [--agent A] [--global] [--fix]
```

For every agent with anything of Synapse's in the scope (the project, or your user config with `--global`), it checks:

- **Hooks:** every event setup installs is present (newer versions add events, such as `Stop`), and the Node binary and `cli.js` the commands run still exist. A command from another Synapse install is a warning.
- **MCP entry:** registered, its paths exist, and `SYNAPSE_HOOKS=1` is set exactly when hooks are installed. Without it next to hooks, the server also delivers the brief and runs a second session; with it and no hooks, nothing delivers the brief. Claude Code's entry is read with `claude mcp get synapse`, since Claude Code keeps it in its own files.
- **Instructions:** the project's `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` has the current Synapse block (or imports one).
- **Git hook** (project scope): the `post-commit` block points at valid paths.

Agents with nothing installed are listed as "not set up". Devin isn't counted as set up just because it imports Claude Code's hooks: it needs its own MCP entry or hooks. Copilot CLI's MCP entry is user-level, so in a project without Copilot hooks (and no `--global` hooks) its `SYNAPSE_HOOKS=1` is flagged: Copilot would get no brief there.

The command exits 1 when it finds a problem. `--fix` re-runs setup for each agent with a problem, which refreshes stale paths, adds missing events and re-registers the MCP entry, then checks again. Run it after updating Synapse or moving its folder.

## Uninstalling

```bash
synapse uninstall [--agent A] [--global] [--dry-run]
```

Removes what setup installed in the scope, backing changed files up as `*.synapse-backup`:

- Synapse's hook entries (your other hooks stay; Antigravity's `synapse` entry and Copilot's `~/.copilot/hooks/synapse.json` go whole).
- MCP entries: `claude mcp remove` / `devin mcp remove` for those agents, and the `synapse` entry or `[mcp_servers.synapse]` table elsewhere. Copilot's entry is user-level, so it goes with `--global`.
- With `--global`, Devin's `mcp__synapse__*` allow rules.
- Without `--agent`, in project scope, also the git `post-commit` block and the instruction blocks. A file left empty is deleted; an `@AGENTS.md` import line is removed only when `AGENTS.md` itself was deleted. With `--agent`, instruction files are left alone, since several agents share them.

Memories in `~/.synapse/synapse.db` are never touched; the command prints the path.

## Troubleshooting

| Symptom | Check |
|---|---|
| Anything setup-related | `synapse doctor agents` in the project (and with `--global`); `--fix` repairs it |
| Tools missing | Claude: `claude mcp list`. Cursor: Settings → MCP. Codex: `[mcp_servers.synapse]` in `config.toml`. Then restart the agent |
| Codex hooks don't run | Approve them in `/hooks`. For project setup, the project must be trusted |
| Devin events recorded twice | Synapse hooks exist in both Claude and Devin config; keep one. `synapse setup devin` and `setup claude` print which files |
| No brief at session start | `SYNAPSE_HOOK_INJECT` isn't `silent`; the hooks file contains the synapse command; run with `SYNAPSE_DEBUG=1` |
| `synapse requires Node.js >= 22.13` | Re-run setup under Node 22 so its absolute path is pinned |
| Memories land in the wrong project | `synapse doctor` from that directory shows the detected project id. Check the git remote or `SYNAPSE_PROJECT_ROOT` |
| Search says "fresh project" | Nothing has been stored for this project id yet. Try `synapse projects` |
