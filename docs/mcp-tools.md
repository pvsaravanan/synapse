# MCP tools

Start the server with `synapse serve` (stdio). It binds to the project of its working directory, or of `SYNAPSE_PROJECT_ROOT` if set; `synapse_session_start { projectRoot }` can rebind it.

Lite mode (the default) exposes 14 tools. Full mode (`--mode full` or `SYNAPSE_MODE=full`) adds 10 more.

**Loaded at session start in Claude Code.** Claude Code defers MCP tools behind tool search: the model sees only their names until it loads them, which makes it less likely to use memory unprompted. The everyday tools (`synapse_project_context`, `synapse_search`, `synapse_detail`, `synapse_store`, `synapse_store_reasoning`, `synapse_feedback` and `synapse_session_end`) are marked `_meta["anthropic/alwaysLoad"]`, so they're ready from the first turn. The rest stay deferred to save context. Other agents ignore the marker.

## Recommended agent workflow

1. **Starting non-trivial work:** call `synapse_project_context` with the user's actual task, and read its "Start here" files first.
2. **When history would help:** call `synapse_search`, then `synapse_detail` on the ids that look relevant. A memory flagged `changed since: …` names files edited after it was stored: check current code, then send `synapse_feedback` with `verified` or `outdated`.
3. **After learning something durable:** call `synapse_store`, or `synapse_store_reasoning` for the "why".
4. **When something deserves to outlive many sessions:** call `synapse_lt_propose`. Approving with `synapse_lt_approve` always asks the user.
5. **When work is done or a memory is obsolete:** call `synapse_resolve`.
6. **At the end:** call `synapse_session_end` with a handoff summary.

Current code and the user's request always take precedence over memory.

---

## Memory

### `synapse_store`

Store an observation. Credentials are redacted before the write. On a feature branch the memory belongs to that branch until it merges ([branch-scoped memories](concepts.md#branch-scoped-memories)); Synapse decides from the files and text whether a memory is the branch's own work or holds everywhere, and the result says which and why. Pass `scope: "project"` or `"branch"` (also on `synapse_store_reasoning`) to choose.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `entityName` | string | yes | Area it belongs to, e.g. `auth-module` |
| `type` | enum | yes | See [types](concepts.md#types) |
| `title` | string | yes | ~5–10 words |
| `narrative` | string | yes | Full description |
| `facts` | string[] | | Discrete statements |
| `filesModified` | string[] | | Relative paths preferred |
| `concepts` | string[] | | `pinned`/`important`/`keep`/`critical` make it retention-immune |
| `topicKey` | string | | Revises the existing record with the same key |
| `progress` | `{ feature, status: in-progress\|completed\|blocked, completion?: 0–100 }` | | |
| `relatedCommits` | string[] | | |
| `relatedEntities` | string[] | | |

Returns, for example, `Stored #12 2026-11-16 [GOTCHA] billing: … ~40t`. The verb is `Updated topic` or `Merged into existing` when an [upsert or merge](concepts.md#writing-memory-upserts-and-duplicates) happened.

### `synapse_store_reasoning`

Record why a decision was made. It is stored as a `reasoning` observation with a structured narrative.

| Parameter | Type | Required |
|---|---|---|
| `entityName` | string | yes |
| `decision` | string | yes |
| `rationale` | string | yes |
| `alternatives` | string[] | |
| `constraints` | string[] | |
| `risks` | string[] | |
| `filesModified` | string[] | |
| `relatedCommits` | string[] | |
| `topicKey` | string | |

### `synapse_search`

Ranked search that returns an L1 index.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | (required) | An empty string browses by relevance |
| `type` | enum[] | all | Filter by types |
| `status` | `active`\|`resolved`\|`archived`\|`all` | `active` | |
| `entityName` | string | | Exact match |
| `since` | ISO date | | Updated on or after |
| `limit` | 1–50 | 10 | |
| `maxTokens` | number | | Token budget for the index |
| `scope` | `project`\|`global` | `project` | |
| `branches` | `current`\|`all` | `current` | `all` includes memories still scoped to other feature branches; otherwise their matches are only counted in a footer |

Hits whose files changed since they were stored are flagged `changed since: <files>`, followed by a hint line (project scope only; see [file freshness](concepts.md#file-freshness)).

When nothing matches, the reply says whether the project is **fresh** (no memories at all, so don't search again this turn) or whether nothing matched the query. In the second case it gives the active and total counts.

### `synapse_detail`

| Parameter | Type | Notes |
|---|---|---|
| `ids` | number[] (1–20) | Returns full records and counts as an access for ranking |

A record whose files changed since it was stored adds a line such as `Changed since stored: src/limit.ts (modified)`.

### `synapse_timeline`

| Parameter | Type | Default |
|---|---|---|
| `anchorId` | number | (required) |
| `before` | 0–20 | 3 |
| `after` | 0–20 | 3 |

Lists memories from the same project in chronological order, with the anchor marked `>`.

### `synapse_history`

| Parameter | Type | Notes |
|---|---|---|
| `id` | number | (required) |
| `at` | ISO date or date-time | Optional: the version that held then |
| `revision` | number | Optional: one version in full |

Without `at` or `revision`, lists the memory's kept versions, newest first, with what each change did and the narrative lines it added and removed. See [memory history](concepts.md#memory-history).

### `synapse_resolve`

| Parameter | Type | Default |
|---|---|---|
| `ids` | number[] | (required) |
| `status` | `resolved`\|`archived`\|`active` | `resolved` |

Pass `active` to reopen a memory. Only ids in the bound project are changed.

### `synapse_feedback`

| Parameter | Type |
|---|---|
| `id` | number |
| `signal` | `helpful`\|`verified`\|`conflicted`\|`outdated`\|`corrected` |
| `note` | string (optional) |

Adjusts future ranking. `outdated` also resolves the memory. `verified` means you checked the memory against current code and it still holds: it counts like `helpful` and re-records its file hashes, which clears a `changed since` flag.

### `synapse_qualify`

| Parameter | Type |
|---|---|
| `ids` | number[] |

Promotes hook-captured `candidate` memories to `qualified`.

### `synapse_lt_propose`

| Parameter | Type | Notes |
|---|---|---|
| `kind` | `semantic` \| `procedural` \| `episodic` | required |
| `title`, `body` | string | required unless `fromMemoryId` is given |
| `scope` | `project` \| `user` | default `project`; `user` shows it in every project |
| `applicability` | string | when it applies, e.g. "when publishing a release" |
| `evidence` | string[] | memory ids, commits, files or quotes |
| `fromMemoryId` | number | promote an existing memory; it becomes the evidence |

Creates a `proposed` long-term item. Proposals don't reach the brief until approved.

### `synapse_lt_approve`

| Parameter | Type |
|---|---|
| `id` | number |
| `title` | string: the item's title, exactly as stored |
| `scope` | `project` or `user`: the item's scope |
| `body` | string: the item's body, exactly as stored |
| `reason` | string (required) |
| `supersedes` | number, optional: an approved item this one replaces |
| `supersedesTitle` | string, required with `supersedes`: the replaced item's title |

Approves a proposal so it reaches the brief. With `supersedes`, it also retires the item it replaces.

**The prompt shows what you approve.** The agent must repeat the item's title, scope and body, and the call is refused (nothing approved) unless they match the stored item; whitespace differences don't count. A permission prompt shows the tool's arguments, so you see the real text and whether a `user` item will reach every project, not just an id. `synapse_lt_list` shows proposed items in full for this reason, and a refused call returns the stored text.

**Only clients that force the prompt may approve.** The tool refuses unless the MCP client is Claude Code, which always shows the prompt. Other agents get a refusal pointing to `synapse lt approve <id> --reason "..."` or the Long-term tab in `synapse ui`. Set `SYNAPSE_AGENT_APPROVAL=1` in the MCP server's environment to let an agent whose permission prompt you trust approve too.

**You confirm every call.** The tool is marked `_meta["anthropic/requiresUserInteraction"]`, so Claude Code shows its permission prompt on every call in every permission mode (manual, accept-edits, auto and bypass), with no "don't ask again" option. Allow rules such as `mcp__synapse__*` don't skip it. Where no prompt can be shown (`claude -p`, `dontAsk` mode), the call is denied and the item stays proposed. Other agents ignore the marker, so they are refused unless `SYNAPSE_AGENT_APPROVAL=1` is set; then their normal MCP permission prompt applies (`synapse setup devin --allow-tools` leaves this tool out of the rules it adds, so Devin keeps asking).

### `synapse_lt_archive`

| Parameter | Type |
|---|---|
| `id` | number |
| `reason` | string (required) |

Rejects a proposal, or retires an approved item that's no longer true. No special prompt.

### `synapse_lt_list`

| Parameter | Type |
|---|---|
| `state` | `proposed` \| `approved` \| `archived` \| `superseded` \| `all` (default `approved`) |
| `query` | string, optional full-text filter |
| `limit` | number |

### `synapse_suggest_topic_key`

| Parameter | Type |
|---|---|
| `type` | enum |
| `title` | string |
| `entityName` | string (optional) |

Returns a key like `decisions/auth/session-model`. The prefix comes from the type family: decisions, architecture, gotchas, fixes, changes, notes or sessions.

## Context and sessions

### `synapse_project_context`

| Parameter | Type | Default |
|---|---|---|
| `task` | string | (required) |
| `maxTokens` | 200–4000 | 1200 |

Returns the [task-lensed brief](concepts.md#the-project-context-brief). Without hooks, a later call in a session that already did work leads with that session's checkpoint, so an agent can recover after its context was summarized.

### `synapse_session_start`

| Parameter | Type | Notes |
|---|---|---|
| `agent` | string | Label recorded on the session |
| `projectRoot` | string | Rebinds the server to another project |

Returns the new session id and up to three previous handoff summaries.

### `synapse_session_end`

| Parameter | Type |
|---|---|
| `summary` | string |

Closes the active session (or creates and closes one) with the handoff summary. First, files that this session edited (as captured by hooks) are re-hashed in its memories, so the session's own edits don't flag them.

## Maintenance

### `synapse_retention`

| Parameter | Type | Notes |
|---|---|---|
| `archive` | boolean | Archive expired memories |

Reports counts by status and type, the retention zones, and up to 10 archive candidates.

### `synapse_ingest_git`

| Parameter | Type | Default |
|---|---|---|
| `count` | 1–500 | 20 |
| `since` | git date, e.g. `2.weeks` | |

Returns ingested, existing and noise counts. See [Git memory](concepts.md#git-memory).

---

## Full mode only

| Tool | Parameters | Purpose |
|---|---|---|
| `create_entities` | `entities: { name, entityType, observations[] }[]` | Add graph entities; existing names are skipped |
| `create_relations` | `relations: { from, to, relationType }[]` | Add directed relations |
| `add_observations` | `observations: { entityName, contents[] }[]` | Append to entities; errors if an entity is missing |
| `delete_entities` | `entityNames: string[]` | Also removes their relations |
| `delete_observations` | `deletions: { entityName, observations[] }[]` | |
| `delete_relations` | `relations: { from, to, relationType }[]` | |
| `read_graph` | none | The whole project graph |
| `search_nodes` | `query` | Substring match on name, type and observations |
| `open_nodes` | `names: string[]` | Entities plus their relations |
| `synapse_export` | none | All project observations and sessions as JSON |
