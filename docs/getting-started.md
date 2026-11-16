# Getting started

## Requirements

- **Node.js 22.13 or later.** Synapse uses Node's built-in `node:sqlite`, so there are no native modules to compile. If you use nvm and your default is older, run `nvm use 22` before the commands below.
- **git** (optional): used for project identity and git memory.

## Install

```bash
git clone https://github.com/pvsaravanan/synapse.git
cd synapse
npm install
npm run build
npm link            # makes the `synapse` command available
synapse doctor      # checks Node, SQLite/FTS5, database path, project detection, git
```

A healthy `doctor` run looks like this:

```
ok  node v22.23.2 (/path/to/node)
ok  node:sqlite + FTS5
     database: ~/.synapse/synapse.db (not created yet)
ok  project: acme/app @ /path/to/app
ok  git available
```

## Connect your agent

From inside the project you want memory for, run the command for your agent:

```bash
synapse setup claude      # Claude Code
synapse setup cursor      # Cursor
synapse setup codex       # Codex
synapse setup devin       # Devin CLI
```

Add `--global` to configure every project, or `--dry-run` to preview the changes first.

Setup does two things:

1. It installs Synapse's lifecycle hooks: a brief at session start, auto-capture, and a summary at session end.
2. It registers the MCP server so the agent gets the `synapse_*` tools.

Existing config is merged, not replaced, and backed up first as `*.synapse-backup`. Commands use the absolute path of the Node binary that ran `setup`, so they keep working even if your shell's default `node` is older than 22.

Then restart the agent. For Codex, also approve the synapse hooks once in `/hooks` and start a new thread. See [Agent integration](agents.md) for the exact files each agent uses and for other MCP clients.

## First memories

Inside a connected agent's session, memory is used on its own. You can also prompt it directly:

> "Before you start, get the Synapse brief for: fix the login redirect loop."

> "Remember that Stripe webhooks need the raw request body — store it as a gotcha."

The same works from the shell:

```bash
synapse store --type gotcha --entity billing \
  --title "Stripe webhooks need raw body" \
  --narrative "express.json() consumes the body, breaking signature verification. Use express.raw() on /webhook." \
  --files src/billing/webhook.ts

synapse search "webhook signature"
synapse detail 1
synapse context --task "fix the webhook handler"
```

Seed memory from history:

```bash
synapse ingest-git --count 100
```

## Next steps

- Learn how memory is organized in [Concepts](concepts.md).
- Look up tool parameters in [MCP tools](mcp-tools.md).
